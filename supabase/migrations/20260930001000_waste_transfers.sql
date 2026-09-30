-- =====================================================================
-- PHASE 4: WASTE and TRANSFERS (storage-to-storage and location-to-location)
-- (Recipe waste is added by the recipes migration, which redefines log_waste.)
-- =====================================================================

create table public.waste_logs (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id),
  location_id      uuid not null references public.locations(id),
  product_id       uuid references public.products(id),
  recipe_id        uuid,   -- FK added with recipes
  quantity         numeric(18,4) not null check (quantity > 0),
  unit_id          uuid not null references public.units(id),
  storage_location_id uuid references public.storage_locations(id),
  reason_code      text not null,
  comment          text,
  photo_url        text,
  total_cost       numeric(18,4) not null default 0,
  wasted_at        timestamptz not null,
  business_date    date not null,
  logged_by        uuid references public.profiles(id),
  client_key       uuid unique,
  created_at       timestamptz not null default now(),
  check ((product_id is null) <> (recipe_id is null))
);
create index on public.waste_logs (location_id, business_date desc);
create trigger trg_waste_immutable before update or delete on public.waste_logs for each row execute function app.prevent_mutation();

create type public.transfer_type as enum ('storage', 'location');
create type public.transfer_status as enum ('draft', 'sent', 'in_transit', 'received', 'reconciled', 'cancelled');

create table public.inventory_transfers (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references public.organizations(id),
  transfer_number   text not null,
  transfer_type     public.transfer_type not null,
  status            public.transfer_status not null default 'draft',
  from_location_id  uuid not null references public.locations(id),
  to_location_id    uuid not null references public.locations(id),
  from_storage_id   uuid references public.storage_locations(id),
  to_storage_id     uuid references public.storage_locations(id),
  transfer_at       timestamptz,
  notes             text,
  client_key        uuid unique,
  created_by        uuid references public.profiles(id),
  sent_by           uuid references public.profiles(id),
  sent_at           timestamptz,
  received_by       uuid references public.profiles(id),
  received_at       timestamptz,
  reconciled_by     uuid references public.profiles(id),
  reconciled_at     timestamptz,
  cancelled_at      timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (organization_id, transfer_number),
  check (transfer_type <> 'storage' or (from_location_id = to_location_id and from_storage_id is not null and to_storage_id is not null and from_storage_id <> to_storage_id)),
  check (transfer_type <> 'location' or from_location_id <> to_location_id)
);
create index on public.inventory_transfers (from_location_id, status);
create index on public.inventory_transfers (to_location_id, status);
create trigger trg_transfers_touch before update on public.inventory_transfers for each row execute function app.touch_updated_at();

create table public.inventory_transfer_items (
  id            uuid primary key default gen_random_uuid(),
  transfer_id   uuid not null references public.inventory_transfers(id) on delete cascade,
  product_id    uuid not null references public.products(id),
  unit_id       uuid not null references public.units(id),
  unit_factor   numeric(24,10) not null,
  qty_sent      numeric(18,4) not null check (qty_sent > 0),
  qty_received  numeric(18,4) check (qty_received is null or qty_received >= 0),
  unit_cost     numeric(18,6),     -- per inventory unit, fixed when sent
  unique (transfer_id, product_id, unit_id)
);

insert into app.write_protected_tables values ('waste_logs'), ('inventory_transfers'), ('inventory_transfer_items');

alter table public.waste_logs enable row level security;
alter table public.inventory_transfers enable row level security;
alter table public.inventory_transfer_items enable row level security;
create policy waste_select on public.waste_logs for select to authenticated using (location_id in (select app.user_location_ids()));
create policy transfers_select on public.inventory_transfers for select to authenticated
  using (from_location_id in (select app.user_location_ids()) or to_location_id in (select app.user_location_ids()));
create policy transfer_items_select on public.inventory_transfer_items for select to authenticated
  using (transfer_id in (select id from public.inventory_transfers));

-- ---------------------------------------------------------------------
-- Product waste
-- ---------------------------------------------------------------------
create or replace function public.log_waste(
  p_location uuid, p_product uuid, p_qty numeric, p_unit uuid, p_reason text,
  p_storage uuid default null, p_comment text default null, p_photo text default null,
  p_at timestamptz default null, p_client_key uuid default null, p_recipe uuid default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_org uuid := app.location_org(p_location);
  v_id uuid; v_base numeric; v_cost numeric; v_at timestamptz := least(coalesce(p_at, now()), now());
  v_reason public.adjustment_reasons;
begin
  perform app.require_permission('waste.log', p_location);
  if p_client_key is not null then
    select id into v_id from public.waste_logs where client_key = p_client_key;
    if v_id is not null then return jsonb_build_object('id', v_id, 'duplicate', true); end if;
  end if;
  if p_recipe is not null then raise exception 'Recipe waste requires the recipes module'; end if;
  select * into v_reason from public.adjustment_reasons where organization_id = v_org and kind = 'waste' and code = p_reason and active;
  if v_reason.id is null then raise exception 'Unknown waste reason'; end if;
  if v_reason.requires_comment and coalesce(btrim(p_comment), '') = '' then raise exception 'A comment is required for "%"', v_reason.name; end if;
  if coalesce(p_qty, 0) <= 0 then raise exception 'Waste quantity must be greater than zero'; end if;
  if v_at < now() - interval '7 days' and not app.has_permission('inventory.adjust', p_location) then
    raise exception 'Waste older than 7 days must be entered by a manager';
  end if;
  v_base := app.to_base_qty(p_product, p_qty, p_unit);
  v_cost := app.current_unit_cost(p_location, p_product);
  insert into public.waste_logs (organization_id, location_id, product_id, quantity, unit_id, storage_location_id, reason_code, comment, photo_url,
                                 total_cost, wasted_at, business_date, logged_by, client_key)
  values (v_org, p_location, p_product, p_qty, p_unit, p_storage, p_reason, p_comment, p_photo, round(v_base * v_cost, 4), v_at,
          app.business_date(p_location, v_at), auth.uid(), p_client_key)
  returning id into v_id;
  perform app.post_inventory_txn(p_location, p_product, 'WASTE', -v_base, v_cost, v_at, 'waste', v_id, null, p_storage, p_reason, null, p_comment);
  perform app.audit(v_org, p_location, 'waste', 'product', p_product::text,
    format('Wasted %s %s %s (%s)', p_qty, (select code from public.units where id = p_unit), (select name from public.products where id = p_product), v_reason.name),
    null, jsonb_build_object('waste_id', v_id, 'base_qty', v_base, 'cost', round(v_base * v_cost, 2)));
  return jsonb_build_object('id', v_id, 'cost', round(v_base * v_cost, 2), 'base_qty', v_base);
end $$;

-- ---------------------------------------------------------------------
-- Storage transfer (immediate, same location): OUT of one area, IN to another
-- ---------------------------------------------------------------------
-- p_lines: [{product_id, unit_id, qty}]
create or replace function public.transfer_between_storage(p_location uuid, p_from uuid, p_to uuid, p_lines jsonb, p_notes text default null, p_client_key uuid default null)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_org uuid := app.location_org(p_location);
  v_id uuid; r jsonb; v_base numeric; v_cost numeric; v_factor numeric; v_at timestamptz := now();
begin
  perform app.require_permission('inventory.transfer', p_location);
  if p_client_key is not null then
    select id into v_id from public.inventory_transfers where client_key = p_client_key;
    if v_id is not null then return v_id; end if;
  end if;
  if not exists (select 1 from public.storage_locations where id = p_from and location_id = p_location)
     or not exists (select 1 from public.storage_locations where id = p_to and location_id = p_location) then
    raise exception 'Both storage areas must belong to this location';
  end if;
  insert into public.inventory_transfers (organization_id, transfer_number, transfer_type, status, from_location_id, to_location_id, from_storage_id, to_storage_id,
                                          transfer_at, notes, client_key, created_by, sent_by, sent_at, received_by, received_at, reconciled_by, reconciled_at)
  values (v_org, app.next_doc_number(v_org, 'TRF'), 'storage', 'reconciled', p_location, p_location, p_from, p_to, v_at, p_notes, p_client_key,
          auth.uid(), auth.uid(), v_at, auth.uid(), v_at, auth.uid(), v_at)
  returning id into v_id;
  for r in select * from jsonb_array_elements(p_lines) loop
    continue when coalesce((r ->> 'qty')::numeric, 0) <= 0;
    v_factor := app.unit_factor((r ->> 'product_id')::uuid, (r ->> 'unit_id')::uuid);
    if v_factor is null then raise exception 'No unit conversion' using errcode = '22023'; end if;
    v_base := round((r ->> 'qty')::numeric * v_factor, 4);
    v_cost := app.current_unit_cost(p_location, (r ->> 'product_id')::uuid);
    insert into public.inventory_transfer_items (transfer_id, product_id, unit_id, unit_factor, qty_sent, qty_received, unit_cost)
    values (v_id, (r ->> 'product_id')::uuid, (r ->> 'unit_id')::uuid, v_factor, (r ->> 'qty')::numeric, (r ->> 'qty')::numeric, v_cost);
    perform app.post_inventory_txn(p_location, (r ->> 'product_id')::uuid, 'TRANSFER_OUT', -v_base, v_cost, v_at, 'transfer', v_id, null, p_from);
    perform app.post_inventory_txn(p_location, (r ->> 'product_id')::uuid, 'TRANSFER_IN', v_base, v_cost, v_at, 'transfer', v_id, null, p_to);
  end loop;
  if not exists (select 1 from public.inventory_transfer_items where transfer_id = v_id) then raise exception 'Add at least one item'; end if;
  perform app.audit(v_org, p_location, 'transfer', 'inventory_transfer', v_id::text, 'Storage transfer', null, p_lines);
  return v_id;
end $$;

-- ---------------------------------------------------------------------
-- Location transfer: DRAFT -> SENT/IN TRANSIT (sender loses stock) ->
-- RECEIVED -> RECONCILED (receiver gains stock)
-- ---------------------------------------------------------------------
create or replace function public.create_location_transfer(p_from uuid, p_to uuid, p_lines jsonb, p_notes text default null, p_client_key uuid default null)
returns uuid
language plpgsql security definer set search_path = public as $$
declare v_org uuid := app.location_org(p_from); v_id uuid; r jsonb; v_factor numeric;
begin
  perform app.require_permission('inventory.transfer', p_from);
  if app.location_org(p_to) is distinct from v_org then raise exception 'Destination must be in the same organization'; end if;
  if p_client_key is not null then
    select id into v_id from public.inventory_transfers where client_key = p_client_key;
    if v_id is not null then return v_id; end if;
  end if;
  insert into public.inventory_transfers (organization_id, transfer_number, transfer_type, from_location_id, to_location_id, notes, client_key, created_by)
  values (v_org, app.next_doc_number(v_org, 'TRF'), 'location', p_from, p_to, p_notes, p_client_key, auth.uid()) returning id into v_id;
  for r in select * from jsonb_array_elements(p_lines) loop
    continue when coalesce((r ->> 'qty')::numeric, 0) <= 0;
    v_factor := app.unit_factor((r ->> 'product_id')::uuid, (r ->> 'unit_id')::uuid);
    if v_factor is null then raise exception 'No unit conversion' using errcode = '22023'; end if;
    insert into public.inventory_transfer_items (transfer_id, product_id, unit_id, unit_factor, qty_sent)
    values (v_id, (r ->> 'product_id')::uuid, (r ->> 'unit_id')::uuid, v_factor, (r ->> 'qty')::numeric);
  end loop;
  if not exists (select 1 from public.inventory_transfer_items where transfer_id = v_id) then raise exception 'Add at least one item'; end if;
  return v_id;
end $$;

create or replace function public.send_transfer(p_transfer uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_t public.inventory_transfers; i record; v_cost numeric; v_at timestamptz := now();
begin
  select * into v_t from public.inventory_transfers where id = p_transfer for update;
  if v_t.id is null then raise exception 'Transfer not found'; end if;
  perform app.require_permission('inventory.transfer', v_t.from_location_id);
  if v_t.status <> 'draft' then raise exception 'Transfer % was already %', v_t.transfer_number, v_t.status using errcode = 'P0003'; end if;
  for i in select * from public.inventory_transfer_items where transfer_id = p_transfer loop
    v_cost := app.current_unit_cost(v_t.from_location_id, i.product_id);
    update public.inventory_transfer_items set unit_cost = v_cost where id = i.id;
    perform app.post_inventory_txn(v_t.from_location_id, i.product_id, 'TRANSFER_OUT', -round(i.qty_sent * i.unit_factor, 4), v_cost, v_at,
                                   'transfer', p_transfer, i.id, null, null, v_t.transfer_number);
  end loop;
  update public.inventory_transfers set status = 'in_transit', sent_at = v_at, sent_by = auth.uid(), transfer_at = v_at where id = p_transfer;
  perform app.create_task(v_t.to_location_id, 'Receive transfer ' || v_t.transfer_number, 'receive', v_at + interval '1 day',
                          'Inventory is in transit from another location.', 'inventory_transfer', p_transfer, 'transfer:' || p_transfer);
  perform app.audit(v_t.organization_id, v_t.from_location_id, 'send', 'inventory_transfer', p_transfer::text, 'Transfer sent ' || v_t.transfer_number, null, null);
end $$;

-- p_lines: [{id, qty_received}]; reconciles (posts TRANSFER_IN) when p_reconcile
create or replace function public.receive_transfer(p_transfer uuid, p_lines jsonb, p_reconcile boolean default true) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_t public.inventory_transfers; r jsonb; i record; v_at timestamptz := now();
  v_base numeric; v_lp public.location_products; v_on numeric; v_short numeric := 0;
begin
  select * into v_t from public.inventory_transfers where id = p_transfer for update;
  if v_t.id is null then raise exception 'Transfer not found'; end if;
  perform app.require_permission('inventory.transfer', v_t.to_location_id);
  if v_t.status not in ('in_transit', 'sent', 'received') then raise exception 'Transfer % is %', v_t.transfer_number, v_t.status using errcode = 'P0003'; end if;
  for r in select * from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) loop
    update public.inventory_transfer_items set qty_received = (r ->> 'qty_received')::numeric
    where id = (r ->> 'id')::uuid and transfer_id = p_transfer;
  end loop;
  update public.inventory_transfers set status = 'received', received_at = v_at, received_by = auth.uid() where id = p_transfer;
  if not p_reconcile then return jsonb_build_object('status', 'received'); end if;
  if exists (select 1 from public.inventory_transfer_items where transfer_id = p_transfer and qty_received is null) then
    raise exception 'Enter the received quantity for every line';
  end if;
  for i in select * from public.inventory_transfer_items where transfer_id = p_transfer loop
    continue when i.qty_received = 0;
    v_base := round(i.qty_received * i.unit_factor, 4);
    -- weighted average cost at the receiving location
    select * into v_lp from public.location_products where location_id = v_t.to_location_id and product_id = i.product_id for update;
    select greatest(coalesce(on_hand, 0), 0) into v_on from public.inventory_balances where location_id = v_t.to_location_id and product_id = i.product_id;
    v_on := coalesce(v_on, 0);
    update public.location_products set
      avg_cost = case when v_on + v_base > 0 and avg_cost > 0 then round((v_on * avg_cost + v_base * i.unit_cost) / (v_on + v_base), 6) else i.unit_cost end
    where id = v_lp.id;
    perform app.post_inventory_txn(v_t.to_location_id, i.product_id, 'TRANSFER_IN', v_base, i.unit_cost, v_at, 'transfer', p_transfer, i.id, null, null, v_t.transfer_number);
    v_short := v_short + greatest(i.qty_sent - i.qty_received, 0) * i.unit_factor * i.unit_cost;
  end loop;
  update public.inventory_transfers set status = 'reconciled', reconciled_at = v_at, reconciled_by = auth.uid() where id = p_transfer;
  perform app.complete_tasks_for(p_transfer, 'receive');
  perform app.audit(v_t.organization_id, v_t.to_location_id, 'reconcile', 'inventory_transfer', p_transfer::text,
    format('Transfer %s received (shortage value %s)', v_t.transfer_number, round(v_short, 2)), null, null);
  return jsonb_build_object('status', 'reconciled', 'shortage_value', round(v_short, 2));
end $$;

create or replace function public.cancel_transfer(p_transfer uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_t public.inventory_transfers;
begin
  select * into v_t from public.inventory_transfers where id = p_transfer for update;
  perform app.require_permission('inventory.transfer', v_t.from_location_id);
  if v_t.status <> 'draft' then raise exception 'Only draft transfers can be cancelled'; end if;
  update public.inventory_transfers set status = 'cancelled', cancelled_at = now() where id = p_transfer;
end $$;

-- In-transit quantity for count review (inbound location transfers not yet reconciled)
create or replace function app.in_transit_qty(p_location uuid, p_product uuid) returns numeric
language sql stable security definer set search_path = public as $$
  select coalesce(sum(i.qty_sent * i.unit_factor), 0)
  from public.inventory_transfer_items i join public.inventory_transfers t on t.id = i.transfer_id
  where t.to_location_id = p_location and i.product_id = p_product and t.status in ('sent', 'in_transit', 'received')
$$;

select app.apply_grants();
