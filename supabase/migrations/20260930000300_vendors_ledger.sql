-- =====================================================================
-- VENDORS, ORDER GUIDES, PRICE HISTORY and the INVENTORY LEDGER
-- =====================================================================

create table public.vendors (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references public.organizations(id) on delete cascade,
  name               text not null check (length(btrim(name)) > 0),
  vendor_number      text,
  account_number     text,
  sales_rep          text,
  phone              text,
  email              text,
  ordering_email     text,
  edi_enabled        boolean not null default false,
  einvoice_enabled   boolean not null default false,
  order_website      text,
  delivery_days      smallint[] not null default '{}' check (delivery_days <@ array[0,1,2,3,4,5,6]::smallint[]), -- 0 = Sunday
  lead_time_days     integer not null default 1 check (lead_time_days >= 0),
  order_cutoff       time,
  minimum_order      numeric(12,2) not null default 0 check (minimum_order >= 0),
  freight_rules      text,
  payment_terms      text,
  notes              text,
  active             boolean not null default true,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (organization_id, name)
);
create trigger trg_vendors_touch before update on public.vendors for each row execute function app.touch_updated_at();
create trigger trg_vendors_audit after insert or update on public.vendors for each row execute function app.audit_row();

alter table public.products add constraint products_default_vendor_fk foreign key (default_vendor_id) references public.vendors(id);
alter table public.location_products add constraint location_products_local_vendor_fk foreign key (local_vendor_id) references public.vendors(id);
alter table public.product_barcodes add constraint product_barcodes_vendor_fk foreign key (vendor_id) references public.vendors(id);

-- Local vendor settings per restaurant (account number, schedule overrides)
create table public.location_vendors (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  location_id      uuid not null references public.locations(id) on delete cascade,
  vendor_id        uuid not null references public.vendors(id) on delete cascade,
  account_number   text,
  delivery_days    smallint[] check (delivery_days is null or delivery_days <@ array[0,1,2,3,4,5,6]::smallint[]),
  lead_time_days   integer check (lead_time_days is null or lead_time_days >= 0),
  order_cutoff     time,
  active           boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (location_id, vendor_id)
);
create trigger trg_location_vendors_touch before update on public.location_vendors for each row execute function app.touch_updated_at();

-- Vendor order guide: what a vendor sells us and at what price.
create table public.vendor_products (
  id                   uuid primary key default gen_random_uuid(),
  organization_id      uuid not null references public.organizations(id) on delete cascade,
  vendor_id            uuid not null references public.vendors(id) on delete cascade,
  product_id           uuid not null references public.products(id) on delete cascade,
  vendor_item_number   text not null,
  description          text,
  purchase_unit_id     uuid not null references public.units(id),
  pack_size            text,
  current_price        numeric(18,4) not null default 0 check (current_price >= 0),  -- per purchase unit
  contract_price       numeric(18,4) check (contract_price is null or contract_price >= 0),
  contract_start       date,
  contract_end         date,
  order_multiple       numeric(12,4) not null default 1 check (order_multiple > 0),
  min_order_qty        numeric(12,4) not null default 0 check (min_order_qty >= 0),
  is_preferred         boolean not null default false,
  guide_sort           integer not null default 0,
  active               boolean not null default true,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (vendor_id, vendor_item_number),
  check (contract_start is null or contract_end is null or contract_start <= contract_end)
);
create index on public.vendor_products (product_id);
create index on public.vendor_products (vendor_id, guide_sort);
create trigger trg_vendor_products_touch before update on public.vendor_products for each row execute function app.touch_updated_at();
create trigger trg_vendor_products_audit after insert or update on public.vendor_products for each row execute function app.audit_row();

create or replace function app.vendor_products_guard() returns trigger
language plpgsql as $$
begin
  if app.unit_factor(new.product_id, new.purchase_unit_id) is null then
    raise exception 'Purchase unit % has no conversion for this product. Add the conversion on the product first.',
      (select code from public.units where id = new.purchase_unit_id) using errcode = '22023';
  end if;
  return new;
end $$;
create trigger trg_vendor_products_guard before insert or update on public.vendor_products for each row execute function app.vendor_products_guard();

-- Effective purchase price for a vendor item on a date (contract price when in force).
create or replace function app.vendor_item_price(p_vendor_product uuid, p_on date default current_date) returns numeric
language sql stable security definer set search_path = public as $$
  select case
           when vp.contract_price is not null
                and (vp.contract_start is null or vp.contract_start <= p_on)
                and (vp.contract_end is null or vp.contract_end >= p_on)
           then vp.contract_price else vp.current_price end
  from public.vendor_products vp where vp.id = p_vendor_product
$$;

create table public.price_history (
  id                 bigint generated always as identity primary key,
  organization_id    uuid not null references public.organizations(id) on delete cascade,
  location_id        uuid references public.locations(id) on delete cascade,
  product_id         uuid not null references public.products(id) on delete cascade,
  vendor_id          uuid references public.vendors(id),
  vendor_product_id  uuid references public.vendor_products(id),
  purchase_unit_id   uuid references public.units(id),
  unit_price         numeric(18,4) not null check (unit_price >= 0),     -- per purchase unit
  base_unit_price    numeric(18,6) not null check (base_unit_price >= 0), -- per inventory unit
  effective_at       timestamptz not null,
  source_type        text not null check (source_type in ('invoice','contract','manual','order_guide')),
  source_id          uuid,
  created_by         uuid references public.profiles(id),
  created_at         timestamptz not null default now()
);
create index on public.price_history (product_id, effective_at desc);
create index on public.price_history (location_id, effective_at desc);
create trigger trg_price_history_immutable before update or delete on public.price_history for each row execute function app.prevent_mutation();

-- ---------------------------------------------------------------------
-- INVENTORY TRANSACTION LEDGER (immutable source of truth)
-- ---------------------------------------------------------------------
create type public.inv_txn_type as enum (
  'BEGINNING', 'RECEIPT', 'POS_CONSUMPTION', 'RECIPE_CONSUMPTION', 'PRODUCTION', 'WASTE',
  'TRANSFER_IN', 'TRANSFER_OUT', 'MANUAL_ADJUSTMENT', 'PHYSICAL_VARIANCE', 'RETURN_TO_VENDOR', 'CORRECTION'
);

create table public.inventory_transactions (
  id                  bigint generated always as identity primary key,
  txn_uid             uuid not null unique default gen_random_uuid(),
  organization_id     uuid not null references public.organizations(id),
  location_id         uuid not null references public.locations(id),
  product_id          uuid not null references public.products(id),
  storage_location_id uuid references public.storage_locations(id),
  txn_type            public.inv_txn_type not null,
  quantity            numeric(18,4) not null check (quantity <> 0),   -- inventory units, signed
  unit_cost           numeric(18,6) not null default 0 check (unit_cost >= 0),
  extended_cost       numeric(18,4) generated always as (round(quantity * unit_cost, 4)) stored,
  txn_at              timestamptz not null,                           -- when it happened (business time)
  business_date       date not null,
  source_type         text,                                           -- e.g. receipt, count_session, waste
  source_id           uuid,
  source_line_id      uuid,
  reason_code         text,
  reference           text,
  notes               text,
  lot_id              uuid,
  created_by          uuid references public.profiles(id),
  created_at          timestamptz not null default now(),
  check (case txn_type
           when 'RECEIPT'          then quantity > 0
           when 'TRANSFER_IN'      then quantity > 0
           when 'PRODUCTION'       then quantity > 0
           when 'TRANSFER_OUT'     then quantity < 0
           when 'WASTE'            then quantity < 0
           when 'RETURN_TO_VENDOR' then quantity < 0
           else true end)
);
create index inv_txn_loc_prod_at on public.inventory_transactions (location_id, product_id, txn_at);
create index inv_txn_loc_date on public.inventory_transactions (location_id, business_date, txn_type);
create index inv_txn_source on public.inventory_transactions (source_type, source_id);
create trigger trg_inv_txn_immutable before update or delete on public.inventory_transactions
  for each row execute function app.prevent_mutation();

-- Cached perpetual balance (derived from the ledger; never edited directly).
create table public.inventory_balances (
  location_id  uuid not null references public.locations(id) on delete cascade,
  product_id   uuid not null references public.products(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  on_hand      numeric(18,4) not null default 0,
  last_txn_at  timestamptz,
  updated_at   timestamptz not null default now(),
  primary key (location_id, product_id)
);

create or replace function app.inventory_txn_apply() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.inventory_balances as b (location_id, product_id, organization_id, on_hand, last_txn_at)
  values (new.location_id, new.product_id, new.organization_id, new.quantity, new.txn_at)
  on conflict (location_id, product_id) do update
    set on_hand = b.on_hand + excluded.on_hand,
        last_txn_at = greatest(b.last_txn_at, excluded.last_txn_at),
        updated_at = now();
  return null;
end $$;
create trigger trg_inv_txn_apply after insert on public.inventory_transactions
  for each row execute function app.inventory_txn_apply();

-- The only way rows enter the ledger.
create or replace function app.post_inventory_txn(
  p_location uuid, p_product uuid, p_type public.inv_txn_type, p_qty numeric, p_unit_cost numeric,
  p_txn_at timestamptz, p_source_type text, p_source_id uuid, p_source_line_id uuid default null,
  p_storage uuid default null, p_reason text default null, p_reference text default null,
  p_notes text default null, p_lot uuid default null
) returns bigint
language plpgsql security definer set search_path = public as $$
declare
  v_id bigint;
  v_org uuid := app.location_org(p_location);
begin
  if p_qty is null or p_qty = 0 then return null; end if;
  if not exists (select 1 from public.products where id = p_product and organization_id = v_org) then
    raise exception 'Product does not belong to this organization';
  end if;
  insert into public.inventory_transactions (organization_id, location_id, product_id, storage_location_id, txn_type,
    quantity, unit_cost, txn_at, business_date, source_type, source_id, source_line_id, reason_code, reference, notes, lot_id, created_by)
  values (v_org, p_location, p_product, p_storage, p_type, round(p_qty, 4), round(greatest(coalesce(p_unit_cost, 0), 0), 6),
    p_txn_at, app.business_date(p_location, p_txn_at), p_source_type, p_source_id, p_source_line_id, p_reason, p_reference, p_notes, p_lot, auth.uid())
  returning id into v_id;
  return v_id;
end $$;

-- Book (perpetual) quantity at a point in time, computed from the ledger.
create or replace function app.book_qty(p_location uuid, p_product uuid, p_at timestamptz) returns numeric
language sql stable security definer set search_path = public as $$
  select coalesce(sum(quantity), 0) from public.inventory_transactions
  where location_id = p_location and product_id = p_product and txn_at <= p_at
$$;

-- Current cost per inventory unit (weighted average, falling back to last / standard cost).
create or replace function app.current_unit_cost(p_location uuid, p_product uuid) returns numeric
language sql stable security definer set search_path = public as $$
  select coalesce(nullif(lp.avg_cost, 0), lp.last_cost, p.standard_cost, 0)
  from public.products p
  left join public.location_products lp on lp.product_id = p.id and lp.location_id = p_location
  where p.id = p_product
$$;

-- ---------------------------------------------------------------------
-- Adjustment reasons & manual adjustments
-- ---------------------------------------------------------------------
create table public.adjustment_reasons (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  code            text not null,
  name            text not null,
  kind            text not null check (kind in ('waste', 'adjustment')),
  requires_comment boolean not null default false,
  sort            integer not null default 0,
  active          boolean not null default true,
  created_at      timestamptz not null default now(),
  unique (organization_id, kind, code)
);

create or replace function app.provision_organization(p_org uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  insert into public.adjustment_reasons (organization_id, code, name, kind, requires_comment, sort) values
    (p_org, 'SPOILAGE',        'Spoilage',              'waste', false, 1),
    (p_org, 'EXPIRED',         'Expired',               'waste', false, 2),
    (p_org, 'DROPPED',         'Dropped',               'waste', false, 3),
    (p_org, 'OVERCOOKED',      'Overcooked',            'waste', false, 4),
    (p_org, 'INCORRECT_PREP',  'Incorrect Preparation', 'waste', false, 5),
    (p_org, 'CUSTOMER_RETURN', 'Customer Return',       'waste', false, 6),
    (p_org, 'DAMAGED',         'Damaged',               'waste', false, 7),
    (p_org, 'QUALITY',         'Quality Failure',       'waste', false, 8),
    (p_org, 'PREP_WASTE',      'Prep Waste',            'waste', false, 9),
    (p_org, 'EQUIPMENT',       'Equipment Failure',     'waste', false, 10),
    (p_org, 'UNKNOWN',         'Unknown',               'waste', false, 11),
    (p_org, 'OTHER',           'Other',                 'waste', true,  12),
    (p_org, 'BREAKAGE',        'Breakage',              'adjustment', false, 1),
    (p_org, 'SPOILAGE',        'Spoilage',              'adjustment', false, 2),
    (p_org, 'CORRECTION',      'Correction',            'adjustment', true,  3),
    (p_org, 'MISSING',         'Missing',               'adjustment', true,  4),
    (p_org, 'DONATION',        'Donation',              'adjustment', false, 5),
    (p_org, 'MANAGER_MEAL',    'Manager Meal',          'adjustment', false, 6),
    (p_org, 'EMPLOYEE_MEAL',   'Employee Meal',         'adjustment', false, 7),
    (p_org, 'PROMOTION',       'Promotion',             'adjustment', false, 8),
    (p_org, 'TRANSFER_ERROR',  'Transfer Error',        'adjustment', true,  9),
    (p_org, 'PRODUCTION_DIFF', 'Production Difference', 'adjustment', false, 10),
    (p_org, 'OTHER',           'Other',                 'adjustment', true,  11)
  on conflict do nothing;
end $$;

-- Manual adjustment: records original qty, adjustment, new qty; never silent.
create or replace function public.adjust_inventory(
  p_location uuid, p_product uuid, p_qty numeric, p_unit uuid, p_reason_code text,
  p_comment text default null, p_storage uuid default null, p_idempotency_key uuid default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_org uuid := app.location_org(p_location);
  v_reason public.adjustment_reasons;
  v_base numeric;
  v_before numeric;
  v_cost numeric;
  v_txn bigint;
begin
  perform app.require_permission('inventory.adjust', p_location);
  if p_idempotency_key is not null and exists (select 1 from public.inventory_transactions where source_type = 'adjustment' and source_id = p_idempotency_key) then
    return jsonb_build_object('duplicate', true);
  end if;
  select * into v_reason from public.adjustment_reasons where organization_id = v_org and kind = 'adjustment' and code = p_reason_code and active;
  if v_reason.id is null then raise exception 'Unknown adjustment reason %', p_reason_code; end if;
  if v_reason.requires_comment and coalesce(btrim(p_comment), '') = '' then
    raise exception 'A comment is required for reason "%"', v_reason.name;
  end if;
  v_base := app.to_base_qty(p_product, p_qty, p_unit);
  if v_base = 0 then raise exception 'Adjustment quantity cannot be zero'; end if;
  perform 1 from public.location_products where location_id = p_location and product_id = p_product for update;
  select coalesce(on_hand, 0) into v_before from public.inventory_balances where location_id = p_location and product_id = p_product;
  v_before := coalesce(v_before, 0);
  v_cost := app.current_unit_cost(p_location, p_product);
  v_txn := app.post_inventory_txn(p_location, p_product, 'MANUAL_ADJUSTMENT', v_base, v_cost, now(), 'adjustment',
                                  coalesce(p_idempotency_key, gen_random_uuid()), null, p_storage, p_reason_code, null, p_comment);
  perform app.audit(v_org, p_location, 'adjust', 'inventory', p_product::text,
    format('Adjusted %s by %s (%s)', (select name from public.products where id = p_product), v_base, v_reason.name),
    jsonb_build_object('on_hand', v_before),
    jsonb_build_object('on_hand', v_before + v_base, 'adjustment', v_base, 'reason', p_reason_code, 'comment', p_comment, 'txn_id', v_txn));
  return jsonb_build_object('txn_id', v_txn, 'original_qty', v_before, 'adjustment', v_base, 'new_qty', v_before + v_base);
end $$;

-- ---------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------
alter table public.vendors                enable row level security;
alter table public.location_vendors       enable row level security;
alter table public.vendor_products        enable row level security;
alter table public.price_history          enable row level security;
alter table public.inventory_transactions enable row level security;
alter table public.inventory_balances     enable row level security;
alter table public.adjustment_reasons     enable row level security;

create policy vendors_select on public.vendors for select to authenticated
  using (organization_id in (select app.user_org_ids()));
create policy vendors_insert on public.vendors for insert to authenticated
  with check (app.has_org_permission('vendors.edit', organization_id));
create policy vendors_update on public.vendors for update to authenticated
  using (app.has_org_permission('vendors.edit', organization_id))
  with check (app.has_org_permission('vendors.edit', organization_id));

create policy location_vendors_select on public.location_vendors for select to authenticated
  using (location_id in (select app.user_location_ids()));
create policy location_vendors_write on public.location_vendors for all to authenticated
  using (app.has_permission('products.local_edit', location_id))
  with check (app.has_permission('products.local_edit', location_id) and organization_id = app.location_org(location_id));

create policy vendor_products_select on public.vendor_products for select to authenticated
  using (organization_id in (select app.user_org_ids()));
create policy vendor_products_insert on public.vendor_products for insert to authenticated
  with check (app.has_org_permission('vendors.edit', organization_id)
              and organization_id = (select organization_id from public.vendors where id = vendor_id)
              and organization_id = (select organization_id from public.products where id = product_id));
create policy vendor_products_update on public.vendor_products for update to authenticated
  using (app.has_org_permission('vendors.edit', organization_id))
  with check (app.has_org_permission('vendors.edit', organization_id));

create policy price_history_select on public.price_history for select to authenticated
  using (organization_id in (select app.user_org_ids())
         and (location_id is null or location_id in (select app.user_location_ids())));

create policy inv_txn_select on public.inventory_transactions for select to authenticated
  using (location_id in (select app.user_location_ids()));
create policy inv_bal_select on public.inventory_balances for select to authenticated
  using (location_id in (select app.user_location_ids()));

create policy reasons_select on public.adjustment_reasons for select to authenticated
  using (organization_id in (select app.user_org_ids()));
create policy reasons_write on public.adjustment_reasons for all to authenticated
  using (app.has_org_permission('settings.manage', organization_id))
  with check (app.has_org_permission('settings.manage', organization_id));

-- Ledger, balances and price history are written only by SECURITY DEFINER functions.
insert into app.write_protected_tables values ('inventory_transactions'), ('inventory_balances'), ('price_history');

-- ---------------------------------------------------------------------
-- Current inventory view (what do we have, what is it worth)
-- ---------------------------------------------------------------------
create or replace view public.current_inventory with (security_invoker = true) as
select
  lp.location_id, lp.organization_id, p.id as product_id, p.product_number, p.name as product_name,
  p.category_id, c.name as category_name, u.code as inventory_unit,
  coalesce(b.on_hand, 0) as on_hand,
  app.current_unit_cost(lp.location_id, p.id) as unit_cost,
  round(coalesce(b.on_hand, 0) * app.current_unit_cost(lp.location_id, p.id), 2) as extended_value,
  lp.par_mode, lp.par_qty, lp.min_qty, lp.reorder_point, lp.dynamic_par_qty,
  case when lp.par_mode = 'dynamic' then lp.dynamic_par_qty else lp.par_qty end as effective_par,
  lp.avg_cost, lp.last_cost, lp.last_counted_at, b.last_txn_at,
  case
    when coalesce(b.on_hand, 0) < 0 then 'negative'
    when coalesce(b.on_hand, 0) = 0 then 'out'
    when lp.min_qty is not null and b.on_hand <= lp.min_qty then 'critical'
    when coalesce(lp.reorder_point, lp.par_qty) is not null and b.on_hand <= coalesce(lp.reorder_point, lp.par_qty * 0.5) then 'low'
    else 'ok' end as stock_status,
  p.active and lp.active as active
from public.location_products lp
join public.products p on p.id = lp.product_id and p.deleted_at is null
join public.units u on u.id = p.inventory_unit_id
left join public.categories c on c.id = p.category_id
left join public.inventory_balances b on b.location_id = lp.location_id and b.product_id = lp.product_id;

-- Grants (see app.apply_grants in the foundation migration)
select app.apply_grants();
