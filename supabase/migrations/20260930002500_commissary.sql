-- =====================================================================
-- COMMISSARY / CENTRAL KITCHEN: an internal supplier inside the system.
--
-- The commissary is a location (kind = 'commissary') that produces items
-- (record_production) and supplies restaurants through a vendor record of
-- kind 'commissary'. A restaurant's commissary order moves:
--   DRAFT -> SUBMITTED -> ACCEPTED -> PREPARING -> READY -> IN TRANSIT -> RECEIVED
--   (or CANCELLED before it ships)
-- Shipping posts TRANSFER_OUT at the commissary; receiving posts TRANSFER_IN at
-- the restaurant for what actually arrived. Commissary out always equals
-- restaurant in: anything shipped but not received is credited back to the
-- commissary (CORRECTION) and flagged as a discrepancy.
-- =====================================================================

alter table public.locations add column if not exists kind text not null default 'restaurant' check (kind in ('restaurant', 'commissary'));
alter table public.vendors add column if not exists supplying_location_id uuid references public.locations(id);
alter table public.vendors add constraint vendors_commissary_location check (kind <> 'commissary' or supplying_location_id is not null);

create type public.commissary_order_status as enum ('draft', 'submitted', 'accepted', 'preparing', 'ready', 'in_transit', 'received', 'cancelled');

create table public.commissary_orders (
  id                     uuid primary key default gen_random_uuid(),
  organization_id        uuid not null references public.organizations(id),
  order_number           text not null,
  location_id            uuid not null references public.locations(id),      -- ordering restaurant
  vendor_id              uuid not null references public.vendors(id),        -- the commissary vendor record
  commissary_location_id uuid not null references public.locations(id),
  status                 public.commissary_order_status not null default 'draft',
  needed_date            date not null,
  notes                  text,
  client_key             uuid unique,
  created_by             uuid references public.profiles(id),
  submitted_by           uuid references public.profiles(id),
  submitted_at           timestamptz,
  accepted_at            timestamptz,
  preparing_at           timestamptz,
  ready_at               timestamptz,
  shipped_by             uuid references public.profiles(id),
  shipped_at             timestamptz,
  received_by            uuid references public.profiles(id),
  received_at            timestamptz,
  cancelled_by           uuid references public.profiles(id),
  cancelled_at           timestamptz,
  cancel_reason          text,
  discrepancy_value      numeric(14,2),
  employee_id            uuid references public.employees(id) default app.current_employee_id(),
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  unique (organization_id, order_number),
  check (location_id <> commissary_location_id)
);
create index on public.commissary_orders (location_id, status, needed_date);
create index on public.commissary_orders (commissary_location_id, status, needed_date);
create trigger trg_commissary_orders_touch before update on public.commissary_orders for each row execute function app.touch_updated_at();

create table public.commissary_order_items (
  id            uuid primary key default gen_random_uuid(),
  order_id      uuid not null references public.commissary_orders(id) on delete cascade,
  product_id    uuid not null references public.products(id),
  unit_id       uuid not null references public.units(id),
  unit_factor   numeric(24,10) not null check (unit_factor > 0),
  qty_ordered   numeric(12,4) not null check (qty_ordered > 0),
  qty_shipped   numeric(12,4) check (qty_shipped is null or qty_shipped >= 0),
  qty_received  numeric(12,4) check (qty_received is null or qty_received >= 0),
  unit_cost     numeric(18,6),                        -- per inventory unit at the commissary when shipped
  notes         text,
  sort          integer not null default 0,
  unique (order_id, product_id, unit_id)
);
create index on public.commissary_order_items (order_id);

insert into app.write_protected_tables values ('commissary_orders'), ('commissary_order_items');
alter table public.commissary_orders enable row level security;
alter table public.commissary_order_items enable row level security;
create policy commissary_orders_select on public.commissary_orders for select to authenticated
  using (location_id in (select app.user_location_ids()) or commissary_location_id in (select app.user_location_ids()));
create policy commissary_items_select on public.commissary_order_items for select to authenticated
  using (order_id in (select id from public.commissary_orders));

-- Dollar values on commissary orders follow the same rule as everywhere else.
create or replace function public.commissary_order_lines(p_order uuid)
returns table (id uuid, product_id uuid, product_name text, product_number text, unit_id uuid, unit_code text, unit_factor numeric,
               inventory_unit text, qty_ordered numeric, qty_shipped numeric, qty_received numeric, unit_cost numeric, notes text)
language sql stable security definer set search_path = public as $$
  select i.id, i.product_id, p.name, p.product_number, i.unit_id, u.code, i.unit_factor, iu.code, i.qty_ordered, i.qty_shipped, i.qty_received,
         case when app.has_permission('reports.view_cost', o.location_id) or app.has_permission('reports.view_cost', o.commissary_location_id) then i.unit_cost end,
         i.notes
  from public.commissary_order_items i
  join public.commissary_orders o on o.id = i.order_id
  join public.products p on p.id = i.product_id
  join public.units u on u.id = i.unit_id
  join public.units iu on iu.id = p.inventory_unit_id
  where i.order_id = p_order
    and (o.location_id in (select app.user_location_ids()) or o.commissary_location_id in (select app.user_location_ids()))
  order by i.sort, p.name
$$;

-- ---------------------------------------------------------------------
-- Create / edit (draft only)
-- p_lines: [{product_id, unit_id, qty, notes}]
-- ---------------------------------------------------------------------
create or replace function public.save_commissary_order(p_id uuid, p_location uuid, p_vendor uuid, p_needed date, p_notes text, p_lines jsonb,
                                                        p_client_key uuid default null)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_org uuid := app.location_org(p_location); v_v public.vendors; v_o public.commissary_orders; v_id uuid; r jsonb; v_factor numeric; v_sort int := 0;
  v_today date;
begin
  perform app.require_permission('orders.create', p_location);
  if p_id is null and p_client_key is not null then
    select id into v_id from public.commissary_orders where client_key = p_client_key;
    if v_id is not null then return v_id; end if;
  end if;
  select * into v_v from public.vendors where id = p_vendor and organization_id = v_org and kind = 'commissary' and active;
  if v_v.id is null then raise exception 'Commissary not found'; end if;
  if v_v.supplying_location_id = p_location then raise exception 'The commissary cannot order from itself'; end if;
  v_today := (now() at time zone (select timezone from public.locations where id = p_location))::date;
  if p_needed is null or p_needed < v_today then raise exception 'The needed date cannot be in the past'; end if;
  if p_id is null then
    insert into public.commissary_orders (organization_id, order_number, location_id, vendor_id, commissary_location_id, needed_date, notes, client_key, created_by)
    values (v_org, app.next_doc_number(v_org, 'CO'), p_location, p_vendor, v_v.supplying_location_id, p_needed, nullif(btrim(p_notes), ''), p_client_key, auth.uid())
    returning id into v_id;
  else
    select * into v_o from public.commissary_orders where id = p_id for update;
    if v_o.id is null or v_o.location_id <> p_location then raise exception 'Order not found'; end if;
    if v_o.status <> 'draft' then raise exception 'Order % is % and can no longer be edited', v_o.order_number, v_o.status using errcode = 'P0003'; end if;
    update public.commissary_orders set vendor_id = p_vendor, commissary_location_id = v_v.supplying_location_id, needed_date = p_needed,
           notes = nullif(btrim(p_notes), '') where id = p_id;
    delete from public.commissary_order_items where order_id = p_id;
    v_id := p_id;
  end if;
  for r in select * from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) loop
    v_sort := v_sort + 1;
    continue when coalesce(nullif(r ->> 'qty', '')::numeric, 0) = 0;
    if (r ->> 'qty')::numeric < 0 then raise exception 'Quantities cannot be negative'; end if;
    if not exists (select 1 from public.products where id = (r ->> 'product_id')::uuid and organization_id = v_org and active) then
      raise exception 'Product not found';
    end if;
    v_factor := app.unit_factor((r ->> 'product_id')::uuid, (r ->> 'unit_id')::uuid);
    if v_factor is null then raise exception 'That unit has no conversion for this product' using errcode = '22023'; end if;
    insert into public.commissary_order_items (order_id, product_id, unit_id, unit_factor, qty_ordered, notes, sort)
    values (v_id, (r ->> 'product_id')::uuid, (r ->> 'unit_id')::uuid, v_factor, (r ->> 'qty')::numeric, nullif(btrim(r ->> 'notes'), ''), v_sort)
    on conflict (order_id, product_id, unit_id) do update set qty_ordered = public.commissary_order_items.qty_ordered + excluded.qty_ordered;
  end loop;
  perform app.audit(v_org, p_location, case when p_id is null then 'create' else 'update' end, 'commissary_order', v_id::text,
    'Commissary order ' || (select order_number from public.commissary_orders where id = v_id), null,
    jsonb_build_object('needed_date', p_needed, 'lines', jsonb_array_length(coalesce(p_lines, '[]'::jsonb))));
  return v_id;
end $$;

create or replace function app.commissary_email_payload(p_order uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('template', 'commissary_order', 'order_id', o.id, 'order_number', o.order_number, 'needed_date', o.needed_date,
           'notes', o.notes, 'restaurant', l.code || ' ' || l.name, 'commissary', c.name,
           'submitted_by', coalesce((select display_name from public.employees where id = app.current_employee_id()),
                                    (select full_name from public.profiles where id = auth.uid())),
           'lines', (select coalesce(jsonb_agg(jsonb_build_object('name', p.name, 'qty', i.qty_ordered, 'unit', u.code, 'notes', i.notes) order by i.sort, p.name), '[]'::jsonb)
                     from public.commissary_order_items i join public.products p on p.id = i.product_id join public.units u on u.id = i.unit_id
                     where i.order_id = o.id),
           'link', '/commissary/' || o.id)
  from public.commissary_orders o join public.locations l on l.id = o.location_id join public.locations c on c.id = o.commissary_location_id
  where o.id = p_order
$$;

create or replace function public.submit_commissary_order(p_order uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_o public.commissary_orders; v_loc public.locations;
begin
  select * into v_o from public.commissary_orders where id = p_order for update;
  if v_o.id is null then raise exception 'Order not found'; end if;
  perform app.require_permission('orders.create', v_o.location_id);
  if v_o.status <> 'draft' then raise exception 'Order % was already submitted (status %)', v_o.order_number, v_o.status using errcode = 'P0003'; end if;
  if not exists (select 1 from public.commissary_order_items where order_id = p_order) then raise exception 'Add at least one item'; end if;
  update public.commissary_orders set status = 'submitted', submitted_at = now(), submitted_by = auth.uid() where id = p_order;
  select * into v_loc from public.locations where id = v_o.location_id;
  perform app.create_task(v_o.commissary_location_id, format('Prepare %s for #%s %s', v_o.order_number, v_loc.code, v_loc.name), 'custom',
    app.local_ts(v_o.commissary_location_id, v_o.needed_date, '06:00'), 'Commissary order needed ' || to_char(v_o.needed_date, 'Dy Mon DD'),
    'commissary_order', p_order, 'co_prepare:' || p_order);
  perform app.queue_email(v_o.organization_id, v_o.commissary_location_id, 'commissary_order', 'commissary_order:' || p_order || ':submitted',
    format('Commissary Order %s — #%s %s, needed %s', v_o.order_number, v_loc.code, v_loc.name, to_char(v_o.needed_date, 'FMDay, Mon FMDD')),
    app.commissary_email_payload(p_order), array[v_o.location_id]);
  perform app.audit(v_o.organization_id, v_o.location_id, 'submit', 'commissary_order', p_order::text, 'Submitted ' || v_o.order_number, null, null);
end $$;

-- Commissary staff move the order along. Forward only; skipping steps is allowed.
create or replace function public.set_commissary_status(p_order uuid, p_status public.commissary_order_status, p_reason text default null) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_o public.commissary_orders;
  v_rank int; v_new int;
  ranks constant text[] := array['draft', 'submitted', 'accepted', 'preparing', 'ready', 'in_transit', 'received'];
begin
  select * into v_o from public.commissary_orders where id = p_order for update;
  if v_o.id is null then raise exception 'Order not found'; end if;
  if p_status = 'cancelled' then
    if v_o.status in ('in_transit', 'received', 'cancelled') then raise exception 'Order % is % and cannot be cancelled', v_o.order_number, v_o.status; end if;
    if not (app.has_permission('orders.create', v_o.location_id) or app.has_permission('inventory.transfer', v_o.commissary_location_id)) then
      raise exception 'Permission denied' using errcode = '42501';
    end if;
    if v_o.status <> 'draft' and coalesce(btrim(p_reason), '') = '' then raise exception 'A reason is required to cancel a submitted order'; end if;
    update public.commissary_orders set status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid(), cancel_reason = p_reason where id = p_order;
    perform app.complete_tasks_for(p_order, 'custom');
  else
    if p_status not in ('accepted', 'preparing', 'ready') then raise exception 'Use Ship or Receive for %', p_status; end if;
    perform app.require_permission('inventory.transfer', v_o.commissary_location_id);
    v_rank := array_position(ranks, v_o.status::text); v_new := array_position(ranks, p_status::text);
    if v_o.status = 'draft' or v_o.status = 'cancelled' or v_rank is null or v_new <= v_rank or v_rank >= 6 then
      raise exception 'Order % is % and cannot move to %', v_o.order_number, v_o.status, p_status using errcode = 'P0003';
    end if;
    update public.commissary_orders set status = p_status,
      accepted_at = case when p_status in ('accepted', 'preparing', 'ready') then coalesce(accepted_at, now()) else accepted_at end,
      preparing_at = case when p_status in ('preparing', 'ready') then coalesce(preparing_at, now()) else preparing_at end,
      ready_at = case when p_status = 'ready' then now() else ready_at end
    where id = p_order;
  end if;
  perform app.audit(v_o.organization_id, case when p_status = 'cancelled' then v_o.location_id else v_o.commissary_location_id end,
    'status', 'commissary_order', p_order::text, format('%s: %s -> %s', v_o.order_number, v_o.status, p_status), null,
    case when p_reason is not null then jsonb_build_object('reason', p_reason) end);
end $$;

-- Ship: commissary stock leaves now (TRANSFER_OUT). p_lines: [{id, qty_shipped}] (missing lines ship the ordered qty).
create or replace function public.ship_commissary_order(p_order uuid, p_lines jsonb default '[]') returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_o public.commissary_orders; r jsonb; i record; v_cost numeric; v_at timestamptz := now(); v_loc public.locations; v_value numeric := 0;
begin
  select * into v_o from public.commissary_orders where id = p_order for update;
  if v_o.id is null then raise exception 'Order not found'; end if;
  perform app.require_permission('inventory.transfer', v_o.commissary_location_id);
  if v_o.status not in ('submitted', 'accepted', 'preparing', 'ready') then
    raise exception 'Order % is % and cannot be shipped', v_o.order_number, v_o.status using errcode = 'P0003';
  end if;
  for r in select * from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) loop
    if nullif(r ->> 'qty_shipped', '')::numeric < 0 then raise exception 'Shipped quantities cannot be negative'; end if;
    update public.commissary_order_items set qty_shipped = nullif(r ->> 'qty_shipped', '')::numeric
     where id = (r ->> 'id')::uuid and order_id = p_order;
  end loop;
  update public.commissary_order_items set qty_shipped = qty_ordered where order_id = p_order and qty_shipped is null;
  if not exists (select 1 from public.commissary_order_items where order_id = p_order and qty_shipped > 0) then
    raise exception 'Nothing to ship. Cancel the order instead.';
  end if;
  for i in select * from public.commissary_order_items where order_id = p_order loop
    v_cost := app.current_unit_cost(v_o.commissary_location_id, i.product_id);
    update public.commissary_order_items set unit_cost = v_cost where id = i.id;
    if i.qty_shipped > 0 then
      perform app.post_inventory_txn(v_o.commissary_location_id, i.product_id, 'TRANSFER_OUT', -round(i.qty_shipped * i.unit_factor, 4), v_cost, v_at,
                                     'commissary_order', p_order, i.id, null, null, v_o.order_number);
      v_value := v_value + i.qty_shipped * i.unit_factor * v_cost;
    end if;
  end loop;
  update public.commissary_orders set status = 'in_transit', shipped_at = v_at, shipped_by = auth.uid(),
    accepted_at = coalesce(accepted_at, v_at), ready_at = coalesce(ready_at, v_at) where id = p_order;
  perform app.complete_tasks_for(p_order, 'custom');
  select * into v_loc from public.locations where id = v_o.commissary_location_id;
  perform app.create_task(v_o.location_id, format('Receive commissary order %s', v_o.order_number), 'receive', v_at + interval '12 hours',
    'On its way from ' || v_loc.name || '. Count what arrives and confirm.', 'commissary_order', p_order, 'co_receive:' || p_order);
  perform app.audit(v_o.organization_id, v_o.commissary_location_id, 'ship', 'commissary_order', p_order::text,
    format('Shipped %s (%s)', v_o.order_number, to_char(v_value, 'FM$999,999,990.00')), null, p_lines);
  return jsonb_build_object('status', 'in_transit', 'value', round(v_value, 2));
end $$;

-- Receive at the restaurant: TRANSFER_IN for what arrived; the commissary is
-- corrected for any difference so commissary-out = restaurant-in.
-- p_lines: [{id, qty_received}] — every shipped line needs a quantity.
create or replace function public.receive_commissary_order(p_order uuid, p_lines jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_o public.commissary_orders; r jsonb; i record; v_at timestamptz := now(); v_base numeric; v_diff numeric; v_on numeric;
  v_issues jsonb := '[]'::jsonb; v_value numeric := 0; v_lp public.location_products;
begin
  select * into v_o from public.commissary_orders where id = p_order for update;
  if v_o.id is null then raise exception 'Order not found'; end if;
  perform app.require_permission('orders.receive', v_o.location_id);
  if v_o.status <> 'in_transit' then
    raise exception 'Order % is % — only orders in transit can be received', v_o.order_number, v_o.status using errcode = 'P0003';
  end if;
  for r in select * from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) loop
    if nullif(r ->> 'qty_received', '') is null or (r ->> 'qty_received')::numeric < 0 then
      raise exception 'Enter the received quantity for every item (0 if it did not arrive)';
    end if;
    update public.commissary_order_items set qty_received = (r ->> 'qty_received')::numeric where id = (r ->> 'id')::uuid and order_id = p_order;
  end loop;
  if exists (select 1 from public.commissary_order_items where order_id = p_order and qty_received is null) then
    raise exception 'Enter the received quantity for every item (0 if it did not arrive)';
  end if;
  for i in select ci.*, p.name from public.commissary_order_items ci join public.products p on p.id = ci.product_id where ci.order_id = p_order loop
    v_base := round(i.qty_received * i.unit_factor, 4);
    if v_base > 0 then
      select * into v_lp from public.location_products where location_id = v_o.location_id and product_id = i.product_id for update;
      if v_lp.id is null then
        insert into public.location_products (organization_id, location_id, product_id) values (v_o.organization_id, v_o.location_id, i.product_id)
        returning * into v_lp;
      end if;
      select greatest(coalesce(on_hand, 0), 0) into v_on from public.inventory_balances where location_id = v_o.location_id and product_id = i.product_id;
      v_on := coalesce(v_on, 0);
      update public.location_products set
        avg_cost = case when v_on + v_base > 0 and avg_cost > 0 then round((v_on * avg_cost + v_base * i.unit_cost) / (v_on + v_base), 6) else i.unit_cost end,
        last_cost = i.unit_cost, last_cost_at = v_at
      where id = v_lp.id;
      perform app.post_inventory_txn(v_o.location_id, i.product_id, 'TRANSFER_IN', v_base, i.unit_cost, v_at, 'commissary_order', p_order, i.id, null,
                                     null, v_o.order_number);
    end if;
    v_diff := round((coalesce(i.qty_shipped, 0) - i.qty_received) * i.unit_factor, 4);
    if v_diff <> 0 then
      -- shipped but not received goes back on the commissary's books (and vice versa)
      perform app.post_inventory_txn(v_o.commissary_location_id, i.product_id, 'CORRECTION', v_diff, i.unit_cost, v_at, 'commissary_order', p_order, i.id,
                                     null, case when v_diff > 0 then 'COMMISSARY_SHORT' else 'COMMISSARY_OVER' end, v_o.order_number,
                                     format('Shipped %s, restaurant received %s', i.qty_shipped, i.qty_received));
    end if;
    if i.qty_received <> i.qty_ordered or i.qty_received <> coalesce(i.qty_shipped, 0) then
      v_issues := v_issues || jsonb_build_object('product', i.name, 'ordered', i.qty_ordered, 'shipped', i.qty_shipped, 'received', i.qty_received,
        'difference', i.qty_received - i.qty_ordered,
        'value', round((i.qty_received - i.qty_ordered) * i.unit_factor * coalesce(i.unit_cost, 0), 2));
      v_value := v_value + (i.qty_received - i.qty_ordered) * i.unit_factor * coalesce(i.unit_cost, 0);
    end if;
  end loop;
  update public.commissary_orders set status = 'received', received_at = v_at, received_by = auth.uid(),
    discrepancy_value = case when jsonb_array_length(v_issues) > 0 then round(v_value, 2) end where id = p_order;
  perform app.complete_tasks_for(p_order, 'receive');
  if jsonb_array_length(v_issues) > 0 then
    perform app.raise_alert(v_o.location_id, 'short_delivery', 'warning', 'Commissary discrepancy on ' || v_o.order_number,
      (select string_agg(format('%s: ordered %s, received %s', x ->> 'product', x ->> 'ordered', x ->> 'received'), '; ') from jsonb_array_elements(v_issues) x),
      'co_exc:' || p_order, null, 'commissary_order', p_order, jsonb_build_object('issues', v_issues));
  end if;
  perform app.audit(v_o.organization_id, v_o.location_id, 'receive', 'commissary_order', p_order::text,
    format('Received %s%s', v_o.order_number, case when jsonb_array_length(v_issues) > 0 then format(' with %s discrepanc%s', jsonb_array_length(v_issues),
           case when jsonb_array_length(v_issues) = 1 then 'y' else 'ies' end) else '' end), null, jsonb_build_object('issues', v_issues));
  return jsonb_build_object('status', 'received', 'issues', v_issues, 'discrepancy_value', round(v_value, 2));
end $$;

-- ---------------------------------------------------------------------
-- Incoming stock includes commissary orders (suggested ordering, count review)
-- ---------------------------------------------------------------------
create or replace function app.on_order_qty(p_location uuid, p_product uuid, p_exclude_po uuid default null) returns numeric
language sql stable security definer set search_path = public as $$
  select coalesce((select sum(greatest(i.order_qty - i.received_qty, 0) * i.unit_factor)
                   from public.purchase_order_items i join public.purchase_orders po on po.id = i.po_id
                   where po.location_id = p_location and i.product_id = p_product
                     and (p_exclude_po is null or po.id <> p_exclude_po)
                     and po.status in ('submitted', 'confirmed', 'partially_received', 'back_ordered', 'invoice_received', 'ready_to_reconcile')), 0)
       + coalesce((select sum(case when o.status = 'in_transit' then coalesce(i.qty_shipped, 0) else i.qty_ordered end * i.unit_factor)
                   from public.commissary_order_items i join public.commissary_orders o on o.id = i.order_id
                   where o.location_id = p_location and i.product_id = p_product
                     and o.status in ('submitted', 'accepted', 'preparing', 'ready', 'in_transit')), 0)
$$;

create or replace function app.in_transit_qty(p_location uuid, p_product uuid) returns numeric
language sql stable security definer set search_path = public as $$
  select coalesce((select sum(i.qty_sent * i.unit_factor)
                   from public.inventory_transfer_items i join public.inventory_transfers t on t.id = i.transfer_id
                   where t.to_location_id = p_location and i.product_id = p_product and t.status in ('sent', 'in_transit', 'received')), 0)
       + coalesce((select sum(coalesce(i.qty_shipped, 0) * i.unit_factor)
                   from public.commissary_order_items i join public.commissary_orders o on o.id = i.order_id
                   where o.location_id = p_location and i.product_id = p_product and o.status = 'in_transit'), 0)
$$;

-- Daily/weekly reports mention commissary activity.
create or replace function app.commissary_summary(p_location uuid, p_from date, p_to date) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'received', (select count(*) from public.commissary_orders where location_id = p_location and status = 'received'
                   and (received_at at time zone (select timezone from public.locations where id = p_location))::date between p_from and p_to),
    'value', (select coalesce(round(sum(i.qty_received * i.unit_factor * coalesce(i.unit_cost, 0)), 2), 0)
              from public.commissary_order_items i join public.commissary_orders o on o.id = i.order_id
              where o.location_id = p_location and o.status = 'received'
                and (o.received_at at time zone (select timezone from public.locations where id = p_location))::date between p_from and p_to),
    'discrepancies', (select count(*) from public.commissary_orders where location_id = p_location and status = 'received' and discrepancy_value is not null
                   and (received_at at time zone (select timezone from public.locations where id = p_location))::date between p_from and p_to),
    'open', (select count(*) from public.commissary_orders where location_id = p_location and status in ('submitted', 'accepted', 'preparing', 'ready', 'in_transit')))
$$;

select app.apply_grants();
