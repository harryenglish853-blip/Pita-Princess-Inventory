-- =====================================================================
-- PURCHASING: suggested ordering engine, purchase orders, receiving,
-- invoice reconciliation, lots/traceability, price history & alerts.
-- =====================================================================

create type public.po_status as enum (
  'draft', 'ready_to_submit', 'submitted', 'confirmed', 'partially_received', 'invoice_received',
  'ready_to_reconcile', 'reconciled', 'posted', 'back_ordered', 'cancelled'
);

create table public.purchase_orders (
  id                     uuid primary key default gen_random_uuid(),
  organization_id        uuid not null references public.organizations(id),
  location_id            uuid not null references public.locations(id),
  vendor_id              uuid not null references public.vendors(id),
  po_number              text not null,
  status                 public.po_status not null default 'draft',
  order_date             date not null default current_date,
  expected_delivery_date date not null,
  next_delivery_date     date,
  delivery_window        text,
  notes                  text,
  confirmation_number    text,
  client_key             uuid unique,
  created_by             uuid references public.profiles(id),
  submitted_by           uuid references public.profiles(id),
  submitted_at           timestamptz,
  confirmed_at           timestamptz,
  cancelled_by           uuid references public.profiles(id),
  cancelled_at           timestamptz,
  cancel_reason          text,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  unique (organization_id, po_number),
  check (next_delivery_date is null or next_delivery_date > expected_delivery_date)
);
create index on public.purchase_orders (location_id, status, expected_delivery_date);
create index on public.purchase_orders (vendor_id);
create trigger trg_po_touch before update on public.purchase_orders for each row execute function app.touch_updated_at();

create table public.purchase_order_items (
  id                 uuid primary key default gen_random_uuid(),
  po_id              uuid not null references public.purchase_orders(id) on delete cascade,
  product_id         uuid not null references public.products(id),
  vendor_product_id  uuid references public.vendor_products(id),
  unit_id            uuid not null references public.units(id),
  unit_factor        numeric(24,10) not null check (unit_factor > 0),   -- inventory units per order unit (snapshot)
  suggested_qty      numeric(12,4) check (suggested_qty is null or suggested_qty >= 0),  -- SYSTEM SUGGESTION
  order_qty          numeric(12,4) not null check (order_qty >= 0),    -- MANAGER ORDER
  unit_price         numeric(18,4) not null default 0 check (unit_price >= 0),
  extended_price     numeric(18,2) generated always as (round(order_qty * unit_price, 2)) stored,
  suggestion         jsonb,        -- explanation snapshot ("why 4 cases?")
  received_qty       numeric(12,4) not null default 0,   -- posted receipts, in order units
  back_ordered_qty   numeric(12,4) not null default 0 check (back_ordered_qty >= 0),
  notes              text,
  sort               integer not null default 0,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (po_id, product_id, unit_id)
);
create index on public.purchase_order_items (product_id);
create trigger trg_poi_touch before update on public.purchase_order_items for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------
-- Receiving + invoice (one document per delivery)
-- ---------------------------------------------------------------------
create type public.receipt_status as enum ('draft', 'received', 'posted', 'cancelled');

create table public.receipts (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references public.organizations(id),
  location_id        uuid not null references public.locations(id),
  vendor_id          uuid not null references public.vendors(id),
  purchase_order_id  uuid references public.purchase_orders(id),
  receipt_number     text not null,
  status             public.receipt_status not null default 'draft',
  delivery_date      date not null default current_date,
  received_at        timestamptz,
  received_by        uuid references public.profiles(id),
  invoice_number     text,
  invoice_date       date,
  invoice_total      numeric(12,2) check (invoice_total is null or invoice_total >= 0),
  tax                numeric(12,2) not null default 0 check (tax >= 0),
  freight            numeric(12,2) not null default 0 check (freight >= 0),
  fuel_surcharge     numeric(12,2) not null default 0 check (fuel_surcharge >= 0),
  misc_fees          numeric(12,2) not null default 0 check (misc_fees >= 0),
  credits            numeric(12,2) not null default 0 check (credits >= 0),
  notes              text,
  client_key         uuid unique,
  document_id        uuid,
  override_reason    text,
  override_by        uuid references public.profiles(id),
  posted_at          timestamptz,
  posted_by          uuid references public.profiles(id),
  cancelled_at       timestamptz,
  cancelled_by       uuid references public.profiles(id),
  created_by         uuid references public.profiles(id),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (organization_id, receipt_number)
);
-- Duplicate invoice protection
create unique index receipts_invoice_uniq on public.receipts (vendor_id, lower(invoice_number))
  where status <> 'cancelled' and invoice_number is not null;
create index on public.receipts (location_id, status, delivery_date desc);
create index on public.receipts (purchase_order_id);
create trigger trg_receipts_touch before update on public.receipts for each row execute function app.touch_updated_at();

create table public.receipt_items (
  id                  uuid primary key default gen_random_uuid(),
  receipt_id          uuid not null references public.receipts(id) on delete cascade,
  po_item_id          uuid references public.purchase_order_items(id),
  product_id          uuid not null references public.products(id),
  vendor_product_id   uuid references public.vendor_products(id),
  unit_id             uuid not null references public.units(id),
  unit_factor         numeric(24,10) not null check (unit_factor > 0),
  line_type           text not null default 'ordered' check (line_type in ('ordered', 'substitution', 'forced', 'wrong_item', 'unordered')),
  substitute_for_id   uuid references public.receipt_items(id),
  ordered_qty         numeric(12,4) not null default 0 check (ordered_qty >= 0),
  received_qty        numeric(12,4) check (received_qty is null or received_qty >= 0),   -- physically accepted
  invoiced_qty        numeric(12,4) check (invoiced_qty is null or invoiced_qty >= 0),
  rejected_qty        numeric(12,4) not null default 0 check (rejected_qty >= 0),
  damaged_qty         numeric(12,4) not null default 0 check (damaged_qty >= 0),
  contract_price      numeric(18,4),
  invoice_price       numeric(18,4) check (invoice_price is null or invoice_price >= 0),
  invoice_extended    numeric(18,2) check (invoice_extended is null or invoice_extended >= 0),
  catch_weight_qty    numeric(18,4) check (catch_weight_qty is null or catch_weight_qty > 0),  -- actual inventory units (e.g. LB)
  back_order          boolean not null default false,
  exception_codes     text[] not null default '{}',
  temperature         numeric(6,2),
  temp_max            numeric(6,2),
  temp_min            numeric(6,2),
  temp_decision       text check (temp_decision in ('accept', 'reject', 'override')),
  lot_number          text,
  lot_tlc             text,
  lot_production_date date,
  expiration_date     date,
  best_by_date        date,
  storage_allocations jsonb not null default '[]'::jsonb,   -- [{storage_location_id, qty}] in order units
  notes               text,
  sort                integer not null default 0,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index on public.receipt_items (receipt_id, sort);
create trigger trg_receipt_items_touch before update on public.receipt_items for each row execute function app.touch_updated_at();

-- Lots & traceability
create table public.lots (
  id                    uuid primary key default gen_random_uuid(),
  organization_id       uuid not null references public.organizations(id),
  product_id            uuid not null references public.products(id),
  lot_number            text not null,
  traceability_lot_code text,
  lot_source            text,
  vendor_id             uuid references public.vendors(id),
  production_date       date,
  expiration_date       date,
  best_by_date          date,
  created_at            timestamptz not null default now(),
  unique (organization_id, product_id, lot_number)
);
create table public.lot_receipts (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null references public.organizations(id),
  location_id         uuid not null references public.locations(id),
  lot_id              uuid not null references public.lots(id),
  receipt_id          uuid references public.receipts(id),
  receipt_item_id     uuid references public.receipt_items(id),
  storage_location_id uuid references public.storage_locations(id),
  quantity            numeric(18,4) not null,
  received_at         timestamptz not null,
  created_at          timestamptz not null default now()
);
create index on public.lot_receipts (lot_id);
create index lots_number_trgm on public.lots using gin (lot_number extensions.gin_trgm_ops);

alter table public.inventory_transactions add constraint inv_txn_lot_fk foreign key (lot_id) references public.lots(id);

insert into app.write_protected_tables values
  ('purchase_orders'), ('purchase_order_items'), ('receipts'), ('receipt_items'), ('lots'), ('lot_receipts');

-- Audit every quantity/price change on POs and receipts (who changed invoice qty 5 -> 4)
create trigger trg_po_audit after insert or update on public.purchase_orders for each row execute function app.audit_row();
create or replace function app.audit_child_row() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_old jsonb := case when tg_op in ('UPDATE','DELETE') then to_jsonb(old) end;
  v_new jsonb := case when tg_op in ('INSERT','UPDATE') then to_jsonb(new) end;
  v_row jsonb := coalesce(v_new, v_old);
  v_parent_table text := tg_argv[0];
  v_parent_col text := tg_argv[1];
  v_parent_id uuid := (v_row ->> v_parent_col)::uuid;
  v_org uuid; v_loc uuid;
  v_od jsonb := '{}'; v_nd jsonb := '{}'; k text;
begin
  execute format('select organization_id, location_id from public.%I where id = $1', v_parent_table) into v_org, v_loc using v_parent_id;
  if tg_op = 'UPDATE' then
    for k in select jsonb_object_keys(v_new) loop
      if k not in ('updated_at') and (v_old -> k) is distinct from (v_new -> k) then
        v_od := v_od || jsonb_build_object(k, v_old -> k); v_nd := v_nd || jsonb_build_object(k, v_new -> k);
      end if;
    end loop;
    if v_nd = '{}'::jsonb then return new; end if;
  else
    v_od := v_old; v_nd := v_new;
  end if;
  perform app.audit(v_org, v_loc, lower(tg_op), tg_table_name, v_row ->> 'id',
    (select name from public.products where id = (v_row ->> 'product_id')::uuid), v_od, v_nd);
  return coalesce(new, old);
end $$;
create trigger trg_poi_audit after insert or update or delete on public.purchase_order_items
  for each row execute function app.audit_child_row('purchase_orders', 'po_id');
create trigger trg_receipts_audit after insert or update on public.receipts for each row execute function app.audit_row();
create trigger trg_receipt_items_audit after insert or update or delete on public.receipt_items
  for each row execute function app.audit_child_row('receipts', 'receipt_id');

-- ---------------------------------------------------------------------
-- RLS (reads by location; writes through functions)
-- ---------------------------------------------------------------------
alter table public.purchase_orders      enable row level security;
alter table public.purchase_order_items enable row level security;
alter table public.receipts             enable row level security;
alter table public.receipt_items        enable row level security;
alter table public.lots                 enable row level security;
alter table public.lot_receipts         enable row level security;

create policy po_select on public.purchase_orders for select to authenticated
  using (location_id in (select app.user_location_ids()));
create policy poi_select on public.purchase_order_items for select to authenticated
  using (po_id in (select id from public.purchase_orders));
create policy receipts_select on public.receipts for select to authenticated
  using (location_id in (select app.user_location_ids()));
create policy receipt_items_select on public.receipt_items for select to authenticated
  using (receipt_id in (select id from public.receipts));
create policy lots_select on public.lots for select to authenticated
  using (organization_id in (select app.user_org_ids()));
create policy lot_receipts_select on public.lot_receipts for select to authenticated
  using (location_id in (select app.user_location_ids()));

-- ---------------------------------------------------------------------
-- Usage & forecasting hooks
-- ---------------------------------------------------------------------
-- Average daily usage from the ledger: consumption + waste + count variance
-- + adjustments (i.e. actual usage), over the trailing window.
create or replace function app.avg_daily_usage(p_location uuid, p_product uuid, p_days integer default 28) returns numeric
language sql stable security definer set search_path = public as $$
  select greatest(0, -coalesce(sum(quantity), 0)) / greatest(p_days, 1)
  from public.inventory_transactions
  where location_id = p_location and product_id = p_product
    and txn_type in ('POS_CONSUMPTION', 'RECIPE_CONSUMPTION', 'WASTE', 'PHYSICAL_VARIANCE', 'MANUAL_ADJUSTMENT')
    and txn_at > now() - make_interval(days => p_days) and txn_at <= now()
$$;

-- Forecast usage between two dates. Returns {qty, method, daily}. Replaced by the
-- forecasting migration with a day-of-week / sales-driven model.
create or replace function app.forecast_usage(p_location uuid, p_product uuid, p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_daily numeric := app.avg_daily_usage(p_location, p_product, 28);
begin
  return jsonb_build_object('qty', round(v_daily * greatest(p_to - p_from, 0), 4), 'daily', round(v_daily, 4),
                            'method', '28-day average daily usage');
end $$;

-- Quantity on open purchase orders not yet received (inventory units).
create or replace function app.on_order_qty(p_location uuid, p_product uuid, p_exclude_po uuid default null) returns numeric
language sql stable security definer set search_path = public as $$
  select coalesce(sum(greatest(i.order_qty - i.received_qty, 0) * i.unit_factor), 0)
  from public.purchase_order_items i join public.purchase_orders po on po.id = i.po_id
  where po.location_id = p_location and i.product_id = p_product
    and (p_exclude_po is null or po.id <> p_exclude_po)
    and po.status in ('submitted', 'confirmed', 'partially_received', 'back_ordered', 'invoice_received', 'ready_to_reconcile')
$$;

-- Next delivery day for a vendor after a date (uses local overrides).
create or replace function app.next_vendor_delivery(p_location uuid, p_vendor uuid, p_after date) returns date
language plpgsql stable security definer set search_path = public as $$
declare
  v_days smallint[];
  d date;
begin
  select coalesce(lv.delivery_days, v.delivery_days) into v_days
  from public.vendors v left join public.location_vendors lv on lv.vendor_id = v.id and lv.location_id = p_location
  where v.id = p_vendor;
  if coalesce(array_length(v_days, 1), 0) = 0 then return p_after + 7; end if;
  for i in 1..7 loop
    d := p_after + i;
    if extract(dow from d)::smallint = any(v_days) then return d; end if;
  end loop;
  return p_after + 7;
end $$;

-- ---------------------------------------------------------------------
-- SUGGESTED ORDER ENGINE:  NEED - HAVE = SUGGESTED ORDER
-- ---------------------------------------------------------------------
create or replace function public.suggest_order(
  p_location uuid, p_vendor uuid, p_delivery_date date, p_next_delivery_date date default null, p_exclude_po uuid default null
)
returns table (
  vendor_product_id uuid, product_id uuid, product_number text, product_name text, category_name text,
  vendor_item_number text, pack_size text, purchase_unit_id uuid, purchase_unit text, unit_factor numeric,
  inventory_unit text, unit_price numeric, on_hand numeric, on_order numeric, par numeric, par_mode public.par_mode,
  forecast_usage numeric, suggested_qty numeric, is_primary_vendor boolean, explanation jsonb
)
language plpgsql stable security definer set search_path = public as $$
declare
  v_next date;
  v_days_until integer;
  v_cover integer;
begin
  perform app.require_permission('orders.view', p_location);
  if p_delivery_date < current_date then raise exception 'Delivery date cannot be in the past'; end if;
  v_next := coalesce(p_next_delivery_date, app.next_vendor_delivery(p_location, p_vendor, p_delivery_date));
  if v_next <= p_delivery_date then raise exception 'Next delivery must be after this delivery'; end if;
  v_days_until := p_delivery_date - current_date;
  v_cover := v_next - p_delivery_date;

  return query
  with items as (
    select vp.id as vp_id, vp.product_id, p.product_number, p.name, c.name as cat, vp.vendor_item_number, vp.pack_size,
           vp.purchase_unit_id, pu.code as pu_code, app.unit_factor(vp.product_id, vp.purchase_unit_id) as factor,
           iu.code as iu_code, app.vendor_item_price(vp.id, p_delivery_date) as price,
           vp.order_multiple, vp.min_order_qty,
           coalesce(b.on_hand, 0) as on_hand,
           app.on_order_qty(p_location, vp.product_id, p_exclude_po) as on_order,
           lp.par_mode, case when lp.par_mode = 'dynamic' then lp.dynamic_par_qty when lp.par_mode = 'static' then lp.par_qty end as par,
           lp.safety_stock_qty, lp.safety_stock_days,
           (coalesce(lp.local_vendor_id, p.default_vendor_id,
                     (select v2.vendor_id from public.vendor_products v2 where v2.product_id = vp.product_id and v2.active
                      order by v2.is_preferred desc, v2.created_at limit 1)) = p_vendor) as is_primary,
           app.forecast_usage(p_location, vp.product_id, current_date, p_delivery_date) as f_until,
           app.forecast_usage(p_location, vp.product_id, p_delivery_date, v_next) as f_cover,
           vp.guide_sort
    from public.vendor_products vp
    join public.products p on p.id = vp.product_id and p.active and p.deleted_at is null
    join public.location_products lp on lp.product_id = vp.product_id and lp.location_id = p_location and lp.active
    join public.units pu on pu.id = vp.purchase_unit_id
    join public.units iu on iu.id = p.inventory_unit_id
    left join public.categories c on c.id = p.category_id
    left join public.inventory_balances b on b.location_id = p_location and b.product_id = vp.product_id
    where vp.vendor_id = p_vendor and vp.active
  ),
  calc as (
    select i.*,
      (i.f_until ->> 'qty')::numeric as usage_until,
      (i.f_cover ->> 'qty')::numeric as usage_cover,
      coalesce(i.safety_stock_qty, (i.f_cover ->> 'daily')::numeric * i.safety_stock_days, 0) as safety
    from items i
  ),
  need as (
    select c.*,
      c.usage_until + greatest(c.usage_cover + c.safety, case when c.par_mode <> 'none' then coalesce(c.par, 0) else 0 end) as need_qty,
      greatest(c.on_hand, 0) + c.on_order as have_qty
    from calc c
  ),
  sug as (
    select n.*,
      greatest(n.need_qty - n.have_qty, 0) as shortage,
      case when n.is_primary and n.need_qty - n.have_qty > 0 then
        greatest(ceil(((n.need_qty - n.have_qty) / n.factor) / n.order_multiple) * n.order_multiple, n.min_order_qty)
      else 0 end as sug_units
    from need n
  )
  select s.vp_id, s.product_id, s.product_number, s.name, s.cat, s.vendor_item_number, s.pack_size,
         s.purchase_unit_id, s.pu_code, s.factor, s.iu_code, s.price, s.on_hand, s.on_order, s.par, s.par_mode,
         round(s.usage_until + s.usage_cover, 4), s.sug_units, s.is_primary,
         jsonb_build_object(
           'delivery_date', p_delivery_date, 'next_delivery_date', v_next,
           'days_until_delivery', v_days_until, 'coverage_days', v_cover,
           'forecast_method', s.f_cover ->> 'method', 'avg_daily_usage', (s.f_cover ->> 'daily')::numeric,
           'usage_until_delivery', round(s.usage_until, 4), 'usage_during_coverage', round(s.usage_cover, 4),
           'safety_stock', round(s.safety, 4), 'par', s.par, 'par_mode', s.par_mode,
           'need', round(s.need_qty, 4), 'on_hand', s.on_hand, 'on_hand_used', greatest(s.on_hand, 0), 'incoming', s.on_order,
           'have', round(s.have_qty, 4), 'shortage', round(s.shortage, 4),
           'unit', s.iu_code, 'purchase_unit', s.pu_code, 'unit_factor', s.factor,
           'raw_purchase_units', round(s.shortage / s.factor, 4), 'order_multiple', s.order_multiple,
           'min_order_qty', s.min_order_qty, 'recommended', s.sug_units, 'is_primary_vendor', s.is_primary,
           'negative_on_hand', s.on_hand < 0)
  from sug s
  order by s.guide_sort, s.name;
end $$;

-- ---------------------------------------------------------------------
-- Purchase orders
-- ---------------------------------------------------------------------
-- p_lines: [{product_id, vendor_product_id, unit_id, order_qty, suggested_qty, suggestion}]
create or replace function app.write_po_lines(p_po uuid, p_lines jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_po public.purchase_orders;
  r jsonb; v_factor numeric; v_price numeric; v_vp public.vendor_products; v_sort int := 0;
begin
  select * into v_po from public.purchase_orders where id = p_po;
  delete from public.purchase_order_items where po_id = p_po;
  for r in select * from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) loop
    v_sort := v_sort + 1;
    continue when coalesce((r ->> 'order_qty')::numeric, 0) = 0 and nullif(r ->> 'suggested_qty', '') is null;
    v_vp := null;
    if nullif(r ->> 'vendor_product_id', '') is not null then
      select * into v_vp from public.vendor_products where id = (r ->> 'vendor_product_id')::uuid and vendor_id = v_po.vendor_id;
      if v_vp.id is null then raise exception 'Item is not on this vendor''s order guide'; end if;
    end if;
    v_factor := app.unit_factor((r ->> 'product_id')::uuid, coalesce(nullif(r ->> 'unit_id', '')::uuid, v_vp.purchase_unit_id));
    if v_factor is null then raise exception 'Order unit has no conversion for this product' using errcode = '22023'; end if;
    v_price := coalesce(nullif(r ->> 'unit_price', '')::numeric, case when v_vp.id is not null then app.vendor_item_price(v_vp.id, v_po.expected_delivery_date) end, 0);
    if (r ->> 'order_qty')::numeric < 0 then raise exception 'Order quantity cannot be negative'; end if;
    insert into public.purchase_order_items (po_id, product_id, vendor_product_id, unit_id, unit_factor, suggested_qty, order_qty, unit_price, suggestion, notes, sort)
    values (p_po, (r ->> 'product_id')::uuid, v_vp.id, coalesce(nullif(r ->> 'unit_id', '')::uuid, v_vp.purchase_unit_id), v_factor,
            nullif(r ->> 'suggested_qty', '')::numeric, coalesce((r ->> 'order_qty')::numeric, 0), v_price, r -> 'suggestion', r ->> 'notes', v_sort);
  end loop;
end $$;

create or replace function public.create_purchase_order(
  p_location uuid, p_vendor uuid, p_delivery_date date, p_lines jsonb,
  p_next_delivery_date date default null, p_notes text default null, p_client_key uuid default null, p_delivery_window text default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_org uuid := app.location_org(p_location);
  v_id uuid;
begin
  perform app.require_permission('orders.create', p_location);
  if p_client_key is not null then
    select id into v_id from public.purchase_orders where client_key = p_client_key;
    if v_id is not null then return v_id; end if;
  end if;
  if not exists (select 1 from public.vendors where id = p_vendor and organization_id = v_org and active) then
    raise exception 'Vendor not found';
  end if;
  insert into public.purchase_orders (organization_id, location_id, vendor_id, po_number, expected_delivery_date, next_delivery_date,
                                      delivery_window, notes, client_key, created_by)
  values (v_org, p_location, p_vendor, app.next_doc_number(v_org, 'PO'), p_delivery_date, p_next_delivery_date,
          p_delivery_window, p_notes, p_client_key, auth.uid())
  returning id into v_id;
  perform app.write_po_lines(v_id, p_lines);
  return v_id;
end $$;

create or replace function public.update_purchase_order(
  p_po uuid, p_lines jsonb, p_delivery_date date default null, p_next_delivery_date date default null,
  p_notes text default null, p_delivery_window text default null
) returns void
language plpgsql security definer set search_path = public as $$
declare v_po public.purchase_orders;
begin
  select * into v_po from public.purchase_orders where id = p_po for update;
  if v_po.id is null then raise exception 'Order not found'; end if;
  perform app.require_permission('orders.create', v_po.location_id);
  if v_po.status not in ('draft', 'ready_to_submit') then
    raise exception 'Order % is % and can no longer be edited', v_po.po_number, v_po.status;
  end if;
  update public.purchase_orders set
    expected_delivery_date = coalesce(p_delivery_date, expected_delivery_date),
    next_delivery_date = coalesce(p_next_delivery_date, next_delivery_date),
    notes = coalesce(p_notes, notes), delivery_window = coalesce(p_delivery_window, delivery_window)
  where id = p_po;
  if p_lines is not null then perform app.write_po_lines(p_po, p_lines); end if;
end $$;

create or replace function public.set_purchase_order_status(
  p_po uuid, p_status public.po_status, p_reason text default null, p_confirmation text default null, p_confirm_below_minimum boolean default false
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_po public.purchase_orders;
  v_total numeric;
  v_min numeric;
begin
  select * into v_po from public.purchase_orders where id = p_po for update;
  if v_po.id is null then raise exception 'Order not found'; end if;
  if v_po.status = p_status then return jsonb_build_object('status', p_status, 'unchanged', true); end if;

  if p_status = 'ready_to_submit' then
    perform app.require_permission('orders.create', v_po.location_id);
    if v_po.status <> 'draft' then raise exception 'Only draft orders can be marked ready'; end if;
    update public.purchase_orders set status = 'ready_to_submit' where id = p_po;
  elsif p_status = 'draft' then
    perform app.require_permission('orders.create', v_po.location_id);
    if v_po.status <> 'ready_to_submit' then raise exception 'Only a ready order can go back to draft'; end if;
    update public.purchase_orders set status = 'draft' where id = p_po;
  elsif p_status = 'submitted' then
    perform app.require_permission('orders.submit', v_po.location_id);
    if v_po.status not in ('draft', 'ready_to_submit') then
      raise exception 'Order % was already submitted (status %)', v_po.po_number, v_po.status using errcode = 'P0003';
    end if;
    select coalesce(sum(extended_price), 0) into v_total from public.purchase_order_items where po_id = p_po and order_qty > 0;
    if v_total = 0 and not exists (select 1 from public.purchase_order_items where po_id = p_po and order_qty > 0) then
      raise exception 'The order has no quantities';
    end if;
    select minimum_order into v_min from public.vendors where id = v_po.vendor_id;
    if v_total < v_min and not p_confirm_below_minimum then
      raise exception 'Order total % is below the vendor minimum of %. Confirm to submit anyway.', v_total, v_min using errcode = 'P0005';
    end if;
    delete from public.purchase_order_items where po_id = p_po and order_qty = 0;
    update public.purchase_orders set status = 'submitted', submitted_at = now(), submitted_by = auth.uid() where id = p_po;
  elsif p_status = 'confirmed' then
    perform app.require_permission('orders.submit', v_po.location_id);
    if v_po.status <> 'submitted' then raise exception 'Only submitted orders can be confirmed'; end if;
    update public.purchase_orders set status = 'confirmed', confirmed_at = now(), confirmation_number = p_confirmation where id = p_po;
  elsif p_status = 'cancelled' then
    perform app.require_permission('orders.create', v_po.location_id);
    if v_po.status not in ('draft', 'ready_to_submit', 'submitted', 'confirmed', 'back_ordered') then
      raise exception 'Order % cannot be cancelled in status %', v_po.po_number, v_po.status;
    end if;
    if exists (select 1 from public.receipts where purchase_order_id = p_po and status in ('draft', 'received')) then
      raise exception 'Cancel or post the open receipt for this order first';
    end if;
    if coalesce(btrim(p_reason), '') = '' then raise exception 'A reason is required to cancel an order'; end if;
    update public.purchase_orders set status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid(), cancel_reason = p_reason where id = p_po;
  else
    raise exception 'Status % is set by receiving and reconciliation, not manually', p_status;
  end if;
  perform app.audit(v_po.organization_id, v_po.location_id, 'status', 'purchase_order', p_po::text,
                    format('%s: %s -> %s', v_po.po_number, v_po.status, p_status), null, null);
  return jsonb_build_object('status', p_status);
end $$;

-- ---------------------------------------------------------------------
-- Receiving
-- ---------------------------------------------------------------------
create or replace function public.create_receipt(p_location uuid, p_vendor uuid, p_po uuid default null, p_client_key uuid default null)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_org uuid := app.location_org(p_location);
  v_po public.purchase_orders;
  v_id uuid;
begin
  perform app.require_permission('orders.receive', p_location);
  if p_client_key is not null then
    select id into v_id from public.receipts where client_key = p_client_key;
    if v_id is not null then return v_id; end if;
  end if;
  if p_po is not null then
    select * into v_po from public.purchase_orders where id = p_po and location_id = p_location for update;
    if v_po.id is null then raise exception 'Order not found'; end if;
    -- Duplicate receiving protection: reuse the open receipt for this order.
    select id into v_id from public.receipts where purchase_order_id = p_po and status in ('draft', 'received');
    if v_id is not null then return v_id; end if;
    if v_po.status not in ('submitted', 'confirmed', 'partially_received', 'back_ordered', 'invoice_received', 'ready_to_reconcile') then
      raise exception 'Order % is % and cannot be received', v_po.po_number, v_po.status;
    end if;
    p_vendor := v_po.vendor_id;
  end if;
  if not exists (select 1 from public.vendors where id = p_vendor and organization_id = v_org) then raise exception 'Vendor not found'; end if;

  insert into public.receipts (organization_id, location_id, vendor_id, purchase_order_id, receipt_number, client_key, created_by)
  values (v_org, p_location, p_vendor, p_po, app.next_doc_number(v_org, 'RCV'), p_client_key, auth.uid())
  returning id into v_id;

  if p_po is not null then
    insert into public.receipt_items (receipt_id, po_item_id, product_id, vendor_product_id, unit_id, unit_factor, line_type,
                                      ordered_qty, invoiced_qty, contract_price, invoice_price, temp_min, temp_max, sort)
    select v_id, i.id, i.product_id, i.vendor_product_id, i.unit_id, i.unit_factor, 'ordered',
           greatest(i.order_qty - i.received_qty, 0), greatest(i.order_qty - i.received_qty, 0), i.unit_price, i.unit_price,
           p.receiving_temp_min, p.receiving_temp_max, i.sort
    from public.purchase_order_items i join public.products p on p.id = i.product_id
    where i.po_id = p_po and i.order_qty - i.received_qty > 0;
  end if;
  return v_id;
end $$;

-- Exception codes are derived from the numbers so nothing is missed.
create or replace function app.receipt_item_exceptions(ri public.receipt_items) returns text[]
language sql immutable as $$
  select array_remove(array[
    case when ri.received_qty is not null and ri.received_qty < ri.ordered_qty and ri.line_type = 'ordered' then 'short' end,
    case when ri.received_qty is not null and ri.received_qty > ri.ordered_qty and ri.line_type = 'ordered' then 'over' end,
    case when ri.received_qty = 0 and ri.ordered_qty > 0 then 'missing' end,
    case when ri.invoiced_qty is not null and ri.received_qty is not null and ri.invoiced_qty <> ri.received_qty then 'invoice_qty_mismatch' end,
    case when ri.contract_price is not null and ri.invoice_price is not null and ri.invoice_price <> ri.contract_price then 'price_variance' end,
    case when ri.temperature is not null and ((ri.temp_max is not null and ri.temperature > ri.temp_max) or (ri.temp_min is not null and ri.temperature < ri.temp_min)) then 'temp_out_of_range' end,
    case when ri.back_order then 'back_order' end,
    case when ri.rejected_qty > 0 then 'rejected' end,
    case when ri.damaged_qty > 0 then 'damaged' end,
    case when ri.line_type = 'substitution' then 'substitution' end,
    case when ri.line_type = 'forced' then 'forced_ship' end,
    case when ri.line_type = 'wrong_item' then 'wrong_item' end,
    case when ri.catch_weight_qty is not null then 'catch_weight' end
  ], null)
$$;

-- p_header: {delivery_date, invoice_number, invoice_date, invoice_total, tax, freight, fuel_surcharge, misc_fees, credits, notes}
-- p_lines:  [{id?, product_id, vendor_product_id, unit_id, line_type, substitute_for_id, received_qty, invoiced_qty, invoice_price,
--             invoice_extended, rejected_qty, damaged_qty, catch_weight_qty, back_order, temperature, temp_decision,
--             lot_number, lot_tlc, lot_production_date, expiration_date, best_by_date, storage_allocations, notes, remove}]
create or replace function public.save_receipt(p_receipt uuid, p_header jsonb, p_lines jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_r public.receipts;
  r jsonb;
  v_item public.receipt_items;
  v_factor numeric;
  v_unit uuid;
  v_vp public.vendor_products;
  v_product public.products;
begin
  select * into v_r from public.receipts where id = p_receipt for update;
  if v_r.id is null then raise exception 'Receipt not found'; end if;
  perform app.require_permission('orders.receive', v_r.location_id);
  if v_r.status not in ('draft', 'received') then raise exception 'Receipt % is % and locked', v_r.receipt_number, v_r.status; end if;

  if p_header is not null then
    if nullif(p_header ->> 'invoice_number', '') is not null and exists (
         select 1 from public.receipts where vendor_id = v_r.vendor_id and lower(invoice_number) = lower(btrim(p_header ->> 'invoice_number'))
           and status <> 'cancelled' and id <> p_receipt) then
      raise exception 'Invoice % from this vendor was already entered on another receipt', p_header ->> 'invoice_number' using errcode = '23505';
    end if;
    update public.receipts set
      delivery_date  = coalesce(nullif(p_header ->> 'delivery_date', '')::date, delivery_date),
      invoice_number = case when p_header ? 'invoice_number' then nullif(btrim(p_header ->> 'invoice_number'), '') else invoice_number end,
      invoice_date   = case when p_header ? 'invoice_date' then nullif(p_header ->> 'invoice_date', '')::date else invoice_date end,
      invoice_total  = case when p_header ? 'invoice_total' then nullif(p_header ->> 'invoice_total', '')::numeric else invoice_total end,
      tax            = coalesce(nullif(p_header ->> 'tax', '')::numeric, tax),
      freight        = coalesce(nullif(p_header ->> 'freight', '')::numeric, freight),
      fuel_surcharge = coalesce(nullif(p_header ->> 'fuel_surcharge', '')::numeric, fuel_surcharge),
      misc_fees      = coalesce(nullif(p_header ->> 'misc_fees', '')::numeric, misc_fees),
      credits        = coalesce(nullif(p_header ->> 'credits', '')::numeric, credits),
      notes          = case when p_header ? 'notes' then p_header ->> 'notes' else notes end
    where id = p_receipt;
  end if;

  for r in select * from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) loop
    if nullif(r ->> 'id', '') is not null then
      select * into v_item from public.receipt_items where id = (r ->> 'id')::uuid and receipt_id = p_receipt for update;
      if v_item.id is null then raise exception 'Receipt line not found'; end if;
      if coalesce((r ->> 'remove')::boolean, false) then
        if v_item.line_type = 'ordered' then raise exception 'Ordered lines cannot be removed; set received quantity to 0 instead'; end if;
        delete from public.receipt_items where id = v_item.id;
        continue;
      end if;
    else
      -- New line: substitution / forced ship / wrong item / unordered
      select * into v_product from public.products where id = (r ->> 'product_id')::uuid and organization_id = v_r.organization_id;
      if v_product.id is null then raise exception 'Product not found'; end if;
      v_vp := null;
      if nullif(r ->> 'vendor_product_id', '') is not null then
        select * into v_vp from public.vendor_products where id = (r ->> 'vendor_product_id')::uuid;
      end if;
      v_unit := coalesce(nullif(r ->> 'unit_id', '')::uuid, v_vp.purchase_unit_id, v_product.purchase_unit_id, v_product.inventory_unit_id);
      v_factor := app.unit_factor(v_product.id, v_unit);
      if v_factor is null then raise exception 'Unit has no conversion for %', v_product.name using errcode = '22023'; end if;
      insert into public.receipt_items (receipt_id, product_id, vendor_product_id, unit_id, unit_factor, line_type, substitute_for_id,
                                        ordered_qty, contract_price, temp_min, temp_max, sort)
      values (p_receipt, v_product.id, v_vp.id, v_unit, v_factor, coalesce(nullif(r ->> 'line_type', ''), 'unordered'),
              nullif(r ->> 'substitute_for_id', '')::uuid, 0,
              case when v_vp.id is not null then app.vendor_item_price(v_vp.id, v_r.delivery_date) end,
              v_product.receiving_temp_min, v_product.receiving_temp_max, 1000)
      returning * into v_item;
    end if;

    update public.receipt_items set
      received_qty     = case when r ? 'received_qty' then nullif(r ->> 'received_qty', '')::numeric else received_qty end,
      invoiced_qty     = case when r ? 'invoiced_qty' then nullif(r ->> 'invoiced_qty', '')::numeric else invoiced_qty end,
      invoice_price    = case when r ? 'invoice_price' then nullif(r ->> 'invoice_price', '')::numeric else invoice_price end,
      invoice_extended = case when r ? 'invoice_extended' then nullif(r ->> 'invoice_extended', '')::numeric else invoice_extended end,
      rejected_qty     = coalesce(nullif(r ->> 'rejected_qty', '')::numeric, rejected_qty),
      damaged_qty      = coalesce(nullif(r ->> 'damaged_qty', '')::numeric, damaged_qty),
      catch_weight_qty = case when r ? 'catch_weight_qty' then nullif(r ->> 'catch_weight_qty', '')::numeric else catch_weight_qty end,
      back_order       = coalesce((r ->> 'back_order')::boolean, back_order),
      temperature      = case when r ? 'temperature' then nullif(r ->> 'temperature', '')::numeric else temperature end,
      temp_decision    = case when r ? 'temp_decision' then nullif(r ->> 'temp_decision', '') else temp_decision end,
      lot_number       = case when r ? 'lot_number' then nullif(btrim(r ->> 'lot_number'), '') else lot_number end,
      lot_tlc          = case when r ? 'lot_tlc' then nullif(btrim(r ->> 'lot_tlc'), '') else lot_tlc end,
      lot_production_date = case when r ? 'lot_production_date' then nullif(r ->> 'lot_production_date', '')::date else lot_production_date end,
      expiration_date  = case when r ? 'expiration_date' then nullif(r ->> 'expiration_date', '')::date else expiration_date end,
      best_by_date     = case when r ? 'best_by_date' then nullif(r ->> 'best_by_date', '')::date else best_by_date end,
      storage_allocations = coalesce(r -> 'storage_allocations', storage_allocations),
      notes            = case when r ? 'notes' then r ->> 'notes' else notes end
    where id = v_item.id
    returning * into v_item;

    if v_item.back_order and v_item.po_item_id is null then
      raise exception 'Only ordered items can be back ordered';
    end if;
    update public.receipt_items set exception_codes = app.receipt_item_exceptions(v_item) where id = v_item.id;
  end loop;

  -- Receipt already completed and the invoice has now arrived
  if v_r.status = 'received' and v_r.purchase_order_id is not null then
    update public.purchase_orders set status = 'ready_to_reconcile'
    where id = v_r.purchase_order_id and status in ('partially_received', 'invoice_received')
      and (select invoice_number from public.receipts where id = p_receipt) is not null;
  end if;

  return public.receipt_totals(p_receipt);
end $$;

-- Financial summary used by the UI and by posting (single source of the math).
create or replace function public.receipt_totals(p_receipt uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_r public.receipts;
  v_lines numeric; v_calc numeric; v_received_value numeric; v_tol numeric;
begin
  select * into v_r from public.receipts where id = p_receipt;
  if v_r.id is null or not (v_r.location_id in (select app.user_location_ids())) then raise exception 'Receipt not found'; end if;
  select coalesce(sum(coalesce(invoice_extended, round(coalesce(invoiced_qty, 0) * coalesce(invoice_price, 0), 2))), 0),
         coalesce(sum(round(coalesce(received_qty, 0) * coalesce(invoice_price, contract_price, 0), 2)), 0)
    into v_lines, v_received_value
  from public.receipt_items where receipt_id = p_receipt;
  v_calc := v_lines + v_r.tax + v_r.freight + v_r.fuel_surcharge + v_r.misc_fees - v_r.credits;
  select invoice_tolerance into v_tol from public.locations where id = v_r.location_id;
  return jsonb_build_object(
    'lines_total', v_lines, 'tax', v_r.tax, 'freight', v_r.freight, 'fuel_surcharge', v_r.fuel_surcharge,
    'misc_fees', v_r.misc_fees, 'credits', v_r.credits, 'calculated_total', v_calc,
    'invoice_total', v_r.invoice_total,
    'over_short', case when v_r.invoice_total is not null then v_r.invoice_total - v_calc end,
    'received_value', v_received_value, 'tolerance', v_tol,
    'within_tolerance', v_r.invoice_total is not null and abs(v_r.invoice_total - v_calc) <= v_tol,
    'exceptions', (select count(*) from public.receipt_items where receipt_id = p_receipt and exception_codes <> '{}'),
    'unreceived_lines', (select count(*) from public.receipt_items where receipt_id = p_receipt and received_qty is null)
  );
end $$;

-- Physical receiving finished (invoice may follow later).
create or replace function public.complete_receiving(p_receipt uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_r public.receipts;
begin
  select * into v_r from public.receipts where id = p_receipt for update;
  if v_r.id is null then raise exception 'Receipt not found'; end if;
  perform app.require_permission('orders.receive', v_r.location_id);
  if v_r.status <> 'draft' then raise exception 'Receipt is already %', v_r.status; end if;
  if exists (select 1 from public.receipt_items where receipt_id = p_receipt and received_qty is null) then
    raise exception 'Enter the received quantity for every line (0 if nothing arrived)';
  end if;
  update public.receipts set status = 'received', received_at = coalesce(received_at, now()), received_by = auth.uid() where id = p_receipt;
  if v_r.purchase_order_id is not null then
    update public.purchase_orders set status = case when v_r.invoice_number is not null then 'ready_to_reconcile'::public.po_status
                                                    else 'invoice_received'::public.po_status end
    where id = v_r.purchase_order_id;
  end if;
  -- Shortages / invoice differences create a reconciliation task.
  if exists (select 1 from public.receipt_items where receipt_id = p_receipt and exception_codes && array['short','missing','invoice_qty_mismatch','price_variance','over']) then
    perform app.create_task(v_r.location_id, 'Resolve delivery discrepancies: ' || v_r.receipt_number, 'invoice', now() + interval '1 day',
      'Receiving found differences between the order, the delivery and the invoice.', 'receipt', p_receipt, 'receipt:' || p_receipt);
    perform app.raise_alert(v_r.location_id, 'short_delivery', 'warning', 'Delivery discrepancies on ' || v_r.receipt_number,
      'Ordered, received and invoiced quantities do not all match.', 'receipt_exc:' || p_receipt, null, 'receipt', p_receipt);
  end if;
  perform app.audit(v_r.organization_id, v_r.location_id, 'receive', 'receipt', p_receipt::text, 'Delivery received ' || v_r.receipt_number, null, null);
end $$;

-- ---------------------------------------------------------------------
-- RECONCILE & POST (atomic): receipt txns, weighted average cost, latest
-- cost, price history, price alerts, PO status, lots, audit.
-- ---------------------------------------------------------------------
create or replace function public.post_receipt(p_receipt uuid, p_override_reason text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_r public.receipts;
  v_loc public.locations;
  v_totals jsonb;
  v_override boolean := false;
  ri public.receipt_items;
  v_base numeric; v_unit_cost numeric; v_line_value numeric;
  v_on_hand numeric; v_lp public.location_products;
  v_new_avg numeric; v_prev_cost numeric;
  v_at timestamptz;
  alloc jsonb; v_alloc_total numeric; v_alloc_base numeric; v_remaining numeric;
  v_lot uuid;
  v_value numeric := 0;
  v_lines integer := 0;
  v_price_alerts integer := 0;
  v_po_open boolean;
begin
  select * into v_r from public.receipts where id = p_receipt for update;
  if v_r.id is null then raise exception 'Receipt not found'; end if;
  perform app.require_permission('orders.reconcile', v_r.location_id);
  if v_r.status = 'posted' then raise exception 'Receipt % was already posted', v_r.receipt_number using errcode = 'P0003'; end if;
  if v_r.status = 'cancelled' then raise exception 'Receipt is cancelled'; end if;
  if v_r.invoice_number is null or v_r.invoice_total is null then
    raise exception 'Enter the invoice number and invoice total before reconciling';
  end if;
  if exists (select 1 from public.receipt_items where receipt_id = p_receipt and received_qty is null) then
    raise exception 'Every line needs a received quantity';
  end if;
  select * into v_loc from public.locations where id = v_r.location_id;

  -- Temperature failures need an explicit decision; overriding needs permission.
  if exists (select 1 from public.receipt_items where receipt_id = p_receipt and 'temp_out_of_range' = any(exception_codes) and temp_decision is null) then
    raise exception 'A received temperature is out of range. Choose Accept, Reject or Manager Override for it.';
  end if;
  if exists (select 1 from public.receipt_items where receipt_id = p_receipt and 'temp_out_of_range' = any(exception_codes) and temp_decision in ('override', 'accept'))
     and not app.has_permission('orders.reconcile_override', v_r.location_id) then
    raise exception 'Accepting product received out of temperature range requires manager override permission' using errcode = '42501';
  end if;

  v_totals := public.receipt_totals(p_receipt);
  if not (v_totals ->> 'within_tolerance')::boolean then
    if not app.has_permission('orders.reconcile_override', v_r.location_id) then
      raise exception 'Invoice is out of balance by % (tolerance %). A manager with override permission must post it.',
        v_totals ->> 'over_short', v_totals ->> 'tolerance' using errcode = '42501';
    end if;
    if coalesce(btrim(p_override_reason), '') = '' then
      raise exception 'Invoice is out of balance by %. Enter an override reason to post.', v_totals ->> 'over_short' using errcode = 'P0006';
    end if;
    v_override := true;
  end if;

  v_at := coalesce(v_r.received_at, now());

  for ri in select * from public.receipt_items where receipt_id = p_receipt order by sort loop
    -- product sent back for temperature is not received into inventory
    if ri.temp_decision = 'reject' then
      update public.receipt_items set rejected_qty = rejected_qty + coalesce(received_qty, 0), received_qty = 0 where id = ri.id returning * into ri;
      perform app.raise_alert(v_r.location_id, 'temperature_failure', 'critical',
        'Temperature failure rejected: ' || (select name from public.products where id = ri.product_id),
        format('Received at %s°F (allowed %s to %s).', ri.temperature, coalesce(ri.temp_min::text, '-'), coalesce(ri.temp_max::text, '-')),
        'temp:' || ri.id, ri.product_id, 'receipt', p_receipt);
    elsif 'temp_out_of_range' = any(ri.exception_codes) then
      perform app.raise_alert(v_r.location_id, 'temperature_failure', 'critical',
        'Temperature override: ' || (select name from public.products where id = ri.product_id),
        format('Accepted at %s°F (allowed %s to %s) by manager decision "%s".', ri.temperature, coalesce(ri.temp_min::text, '-'), coalesce(ri.temp_max::text, '-'), ri.temp_decision),
        'temp:' || ri.id, ri.product_id, 'receipt', p_receipt);
    end if;

    if coalesce(ri.received_qty, 0) > 0 then
      v_base := coalesce(ri.catch_weight_qty, round(ri.received_qty * ri.unit_factor, 4));
      -- cost per inventory unit from the invoice price (catch weight: invoice extended / actual weight)
      v_line_value := case
        when ri.catch_weight_qty is not null and ri.invoice_extended is not null then ri.invoice_extended * least(1, ri.received_qty / nullif(coalesce(ri.invoiced_qty, ri.received_qty), 0))
        else round(ri.received_qty * coalesce(ri.invoice_price, ri.contract_price, 0), 2) end;
      v_unit_cost := round(v_line_value / v_base, 6);

      -- Lot
      v_lot := null;
      if ri.lot_number is not null then
        insert into public.lots (organization_id, product_id, lot_number, traceability_lot_code, lot_source, vendor_id, production_date, expiration_date, best_by_date)
        values (v_r.organization_id, ri.product_id, ri.lot_number, ri.lot_tlc, 'receipt ' || v_r.receipt_number, v_r.vendor_id,
                ri.lot_production_date, ri.expiration_date, ri.best_by_date)
        on conflict (organization_id, product_id, lot_number) do update
          set traceability_lot_code = coalesce(excluded.traceability_lot_code, lots.traceability_lot_code),
              expiration_date = coalesce(excluded.expiration_date, lots.expiration_date)
        returning id into v_lot;
      end if;

      -- Weighted average cost (uses usable on-hand before this receipt)
      select * into v_lp from public.location_products where location_id = v_r.location_id and product_id = ri.product_id for update;
      select coalesce(on_hand, 0) into v_on_hand from public.inventory_balances where location_id = v_r.location_id and product_id = ri.product_id;
      v_on_hand := greatest(coalesce(v_on_hand, 0), 0);
      v_prev_cost := coalesce(v_lp.last_cost, nullif(v_lp.avg_cost, 0));
      v_new_avg := case when v_on_hand + v_base > 0 and v_lp.avg_cost > 0
                        then round((v_on_hand * v_lp.avg_cost + v_base * v_unit_cost) / (v_on_hand + v_base), 6)
                        else v_unit_cost end;

      -- Ledger rows, split by storage allocation (remainder -> unassigned)
      v_alloc_total := 0;
      for alloc in select * from jsonb_array_elements(ri.storage_allocations) loop
        continue when coalesce((alloc ->> 'qty')::numeric, 0) <= 0;
        v_alloc_total := v_alloc_total + (alloc ->> 'qty')::numeric;
      end loop;
      if v_alloc_total > ri.received_qty then
        raise exception 'Storage split for % is more than the received quantity', (select name from public.products where id = ri.product_id);
      end if;
      v_remaining := v_base;
      for alloc in select * from jsonb_array_elements(ri.storage_allocations) loop
        continue when coalesce((alloc ->> 'qty')::numeric, 0) <= 0;
        v_alloc_base := round(v_base * (alloc ->> 'qty')::numeric / ri.received_qty, 4);
        perform app.post_inventory_txn(v_r.location_id, ri.product_id, 'RECEIPT', v_alloc_base, v_unit_cost, v_at, 'receipt', p_receipt, ri.id,
                                       (alloc ->> 'storage_location_id')::uuid, null, coalesce(v_r.invoice_number, v_r.receipt_number), null, v_lot);
        if v_lot is not null then
          insert into public.lot_receipts (organization_id, location_id, lot_id, receipt_id, receipt_item_id, storage_location_id, quantity, received_at)
          values (v_r.organization_id, v_r.location_id, v_lot, p_receipt, ri.id, (alloc ->> 'storage_location_id')::uuid, v_alloc_base, v_at);
        end if;
        v_remaining := v_remaining - v_alloc_base;
      end loop;
      if v_remaining > 0 then
        perform app.post_inventory_txn(v_r.location_id, ri.product_id, 'RECEIPT', v_remaining, v_unit_cost, v_at, 'receipt', p_receipt, ri.id,
                                       null, null, coalesce(v_r.invoice_number, v_r.receipt_number), null, v_lot);
        if v_lot is not null then
          insert into public.lot_receipts (organization_id, location_id, lot_id, receipt_id, receipt_item_id, quantity, received_at)
          values (v_r.organization_id, v_r.location_id, v_lot, p_receipt, ri.id, v_remaining, v_at);
        end if;
      end if;

      update public.location_products set avg_cost = v_new_avg, last_cost = v_unit_cost, last_cost_at = v_at
      where id = v_lp.id;

      insert into public.price_history (organization_id, location_id, product_id, vendor_id, vendor_product_id, purchase_unit_id,
                                        unit_price, base_unit_price, effective_at, source_type, source_id, created_by)
      values (v_r.organization_id, v_r.location_id, ri.product_id, v_r.vendor_id, ri.vendor_product_id, ri.unit_id,
              round(v_unit_cost * ri.unit_factor, 4), v_unit_cost, v_at, 'invoice', p_receipt, auth.uid());

      -- latest invoice price becomes the order-guide price (contract prices are left alone)
      if ri.vendor_product_id is not null and ri.invoice_price is not null then
        update public.vendor_products set current_price = ri.invoice_price where id = ri.vendor_product_id and current_price <> ri.invoice_price;
      end if;

      if v_prev_cost is not null and v_prev_cost > 0 and v_unit_cost > v_prev_cost * (1 + v_loc.price_alert_pct / 100) then
        perform app.raise_alert(v_r.location_id, 'price_increase', 'warning',
          'Price increase: ' || (select name from public.products where id = ri.product_id),
          format('%s → %s per %s (+%s%%)', round(v_prev_cost, 2), round(v_unit_cost, 2),
                 (select u.code from public.products p join public.units u on u.id = p.inventory_unit_id where p.id = ri.product_id),
                 round((v_unit_cost / v_prev_cost - 1) * 100, 2)),
          'price:' || ri.product_id || ':' || p_receipt, ri.product_id, 'receipt', p_receipt,
          jsonb_build_object('previous', v_prev_cost, 'current', v_unit_cost));
        v_price_alerts := v_price_alerts + 1;
      end if;

      v_value := v_value + v_line_value;
      v_lines := v_lines + 1;
    end if;

    -- PO line progress & back orders
    if ri.po_item_id is not null then
      update public.purchase_order_items i set
        received_qty = i.received_qty + coalesce(ri.received_qty, 0),
        back_ordered_qty = case when ri.back_order then greatest(ri.ordered_qty - coalesce(ri.received_qty, 0), 0) else 0 end
      where i.id = ri.po_item_id;
      -- short without back order closes the line at what was received
      if not ri.back_order and coalesce(ri.received_qty, 0) < ri.ordered_qty then
        update public.purchase_order_items i set order_qty = i.received_qty where i.id = ri.po_item_id and i.received_qty < i.order_qty;
      end if;
    end if;
  end loop;

  update public.receipts set status = 'posted', posted_at = now(), posted_by = auth.uid(),
         received_at = coalesce(received_at, v_at), received_by = coalesce(received_by, auth.uid()),
         override_reason = case when v_override then p_override_reason end,
         override_by = case when v_override then auth.uid() end
  where id = p_receipt;

  if v_r.purchase_order_id is not null then
    select exists (select 1 from public.purchase_order_items where po_id = v_r.purchase_order_id and back_ordered_qty > 0) into v_po_open;
    update public.purchase_orders set status = case when v_po_open then 'back_ordered'::public.po_status else 'posted'::public.po_status end
    where id = v_r.purchase_order_id;
  end if;

  if v_override then
    perform app.raise_alert(v_r.location_id, 'invoice_difference', 'warning', 'Invoice posted out of balance: ' || v_r.invoice_number,
      format('Over/short %s. Reason: %s', v_totals ->> 'over_short', p_override_reason), 'invoice:' || p_receipt, null, 'receipt', p_receipt, v_totals);
  end if;
  perform app.complete_tasks_for(p_receipt, 'invoice');
  update public.alerts set status = 'resolved', resolved_at = now(), resolved_by = auth.uid()
    where location_id = v_r.location_id and dedupe_key = 'receipt_exc:' || p_receipt and status <> 'resolved';

  perform app.audit(v_r.organization_id, v_r.location_id, 'post', 'receipt', p_receipt::text,
    format('Reconciled and posted %s / invoice %s (%s lines, %s)', v_r.receipt_number, v_r.invoice_number, v_lines, round(v_value, 2)),
    null, v_totals || jsonb_build_object('override', v_override, 'override_reason', p_override_reason));

  return jsonb_build_object('lines', v_lines, 'inventory_value', round(v_value, 2), 'price_alerts', v_price_alerts,
                            'override', v_override, 'totals', v_totals);
end $$;

create or replace function public.cancel_receipt(p_receipt uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare v_r public.receipts;
begin
  select * into v_r from public.receipts where id = p_receipt for update;
  if v_r.id is null then raise exception 'Receipt not found'; end if;
  perform app.require_permission('orders.receive', v_r.location_id);
  if v_r.status in ('posted', 'cancelled') then raise exception 'Receipt is %', v_r.status; end if;
  if coalesce(btrim(p_reason), '') = '' then raise exception 'A reason is required'; end if;
  update public.receipts set status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid(), notes = concat_ws(E'\n', notes, 'Cancelled: ' || p_reason)
  where id = p_receipt;
  if v_r.purchase_order_id is not null then
    update public.purchase_orders set status = case when confirmed_at is not null then 'confirmed'::public.po_status else 'submitted'::public.po_status end
    where id = v_r.purchase_order_id and status in ('invoice_received', 'ready_to_reconcile');
  end if;
  perform app.complete_tasks_for(p_receipt, 'invoice');
end $$;

-- Recall search: every location that received a lot.
create or replace function public.search_lots(p_query text)
returns table (lot_id uuid, lot_number text, traceability_lot_code text, product_name text, vendor_name text,
               location_id uuid, location_name text, receipt_number text, quantity numeric, received_at timestamptz,
               expiration_date date, storage_name text)
language sql stable security definer set search_path = public as $$
  select l.id, l.lot_number, l.traceability_lot_code, p.name, v.name, loc.id, loc.code || ' ' || loc.name, r.receipt_number,
         lr.quantity, lr.received_at, l.expiration_date, s.name
  from public.lots l
  join public.products p on p.id = l.product_id
  left join public.vendors v on v.id = l.vendor_id
  join public.lot_receipts lr on lr.lot_id = l.id
  join public.locations loc on loc.id = lr.location_id
  left join public.receipts r on r.id = lr.receipt_id
  left join public.storage_locations s on s.id = lr.storage_location_id
  where lr.location_id in (select app.user_location_ids())
    and (l.lot_number ilike '%' || p_query || '%' or l.traceability_lot_code ilike '%' || p_query || '%')
  order by lr.received_at desc
  limit 200
$$;

select app.apply_grants();
