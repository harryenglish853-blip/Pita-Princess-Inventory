-- =====================================================================
-- TOAST ORDER SYNC (order-level, idempotent)
--
-- Orders arrive from a Toast webhook, an API pull or a manual upload, already
-- normalized by the app's Toast adapter (src/lib/pos/toast-orders.ts) into:
--   {guid, business_date, modified_at (ms), voided, deleted, guest_count,
--    selections: [{guid, item_guid, name, quantity, net_sales, voided, refunded_quantity}]}
-- Rules:
--   * One row per Toast order GUID per store. An event older than (or the same
--     as) what was already applied changes nothing -> repeats never double count.
--   * Each order remembers the ingredient usage it has posted. Creates, updates,
--     voids, refunds, removed items and quantity changes post only the difference.
--   * Items not mapped to a recipe deplete nothing until management maps them;
--     mapping reprocesses the affected orders.
--   * A per-day sales_imports row (source 'toast_api') is rebuilt from the orders
--     so dashboards, forecasts and food cost read Toast sales the same way as
--     file imports. A day is either file-imported or API-synced, never both.
-- =====================================================================

create table public.toast_orders (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  location_id     uuid not null references public.locations(id),
  toast_guid      text not null,
  business_date   date not null,
  modified_at     bigint not null,               -- Toast modifiedDate (epoch ms): the order's version
  voided          boolean not null default false,
  deleted         boolean not null default false,
  guest_count     integer not null default 0,
  net_sales       numeric(14,2) not null default 0,
  unmapped_items  integer not null default 0,
  payload_hash    text not null,
  first_seen_at   timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (location_id, toast_guid)
);
create index on public.toast_orders (location_id, business_date);

create table public.toast_order_items (
  id                uuid primary key default gen_random_uuid(),
  order_id          uuid not null references public.toast_orders(id) on delete cascade,
  selection_guid    text not null,
  item_guid         text,
  item_name         text not null,
  quantity          numeric(12,4) not null default 0,
  refunded_quantity numeric(12,4) not null default 0,
  net_sales         numeric(14,2) not null default 0,
  voided            boolean not null default false,
  menu_item_id      uuid references public.menu_items(id),
  unique (order_id, selection_guid)
);

-- What each order has already taken out of inventory (base units).
create table public.toast_order_usage (
  order_id   uuid not null references public.toast_orders(id) on delete cascade,
  product_id uuid not null references public.products(id),
  base_qty   numeric(18,4) not null,
  primary key (order_id, product_id)
);

create table public.toast_sync_log (
  id              bigint generated always as identity primary key,
  organization_id uuid references public.organizations(id),
  location_id     uuid references public.locations(id),
  source          text not null check (source in ('webhook', 'api', 'manual', 'reprocess', 'demo')),
  toast_guid      text,
  business_date   date,
  status          text not null check (status in ('applied', 'unchanged', 'stale', 'held', 'error')),
  message         text,
  created_at      timestamptz not null default now()
);
create index on public.toast_sync_log (location_id, created_at desc);
create trigger trg_toast_sync_log_immutable before update or delete on public.toast_sync_log for each row execute function app.prevent_mutation();

insert into app.write_protected_tables values ('toast_orders'), ('toast_order_items'), ('toast_order_usage'), ('toast_sync_log');
alter table public.toast_orders enable row level security;
alter table public.toast_order_items enable row level security;
alter table public.toast_order_usage enable row level security;
alter table public.toast_sync_log enable row level security;
create policy toast_orders_select on public.toast_orders for select to authenticated
  using (location_id in (select app.user_location_ids()) and (app.has_permission('sales.import', location_id) or app.has_permission('reports.view_cost', location_id)));
create policy toast_items_select on public.toast_order_items for select to authenticated using (order_id in (select id from public.toast_orders));
create policy toast_usage_select on public.toast_order_usage for select to authenticated using (order_id in (select id from public.toast_orders));
create policy toast_log_select on public.toast_sync_log for select to authenticated
  using (location_id in (select app.user_location_ids()) and app.has_permission('sales.import', location_id));

-- The API-synced daily row can only change through the order sync.
create or replace function app.sales_imports_toast_guard() returns trigger
language plpgsql as $$
begin
  if old.source = 'toast_api' and new.status = 'reversed' then
    raise exception 'Toast-synced sales cannot be reversed here. Void or refund the order in Toast; the change syncs automatically.';
  end if;
  return new;
end $$;
create trigger trg_sales_imports_toast_guard before update on public.sales_imports for each row execute function app.sales_imports_toast_guard();

-- Toast restaurant GUID -> store (set on the Toast integration screen).
create unique index if not exists pos_integrations_external_uniq on public.pos_integrations (provider, external_location_id) where external_location_id is not null;

create or replace function public.set_toast_restaurant(p_location uuid, p_restaurant_guid text) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform app.require_permission('settings.manage', p_location);
  if p_restaurant_guid is not null and p_restaurant_guid !~* '^[0-9a-f-]{36}$' then raise exception 'That is not a Toast restaurant GUID'; end if;
  insert into public.pos_integrations (organization_id, location_id, provider, external_location_id, active)
  values (app.location_org(p_location), p_location, 'toast', nullif(btrim(p_restaurant_guid), ''), true)
  on conflict (location_id, provider) do update set external_location_id = excluded.external_location_id, active = true;
  perform app.audit(app.location_org(p_location), p_location, 'update', 'pos_integration', 'toast', 'Toast restaurant GUID set', null,
                    jsonb_build_object('restaurant_guid', p_restaurant_guid));
end $$;

create or replace function public.toast_location_for(p_restaurant_guid text) returns uuid
language sql stable security definer set search_path = public as $$
  select location_id from public.pos_integrations where provider = 'toast' and active and lower(external_location_id) = lower(p_restaurant_guid)
$$;

-- ---------------------------------------------------------------------
-- Re-derive one order's usage and post the difference.
-- ---------------------------------------------------------------------
create or replace function app.apply_toast_order_usage(p_order uuid) returns integer
language plpgsql security definer set search_path = public as $$
declare
  o public.toast_orders; v_at timestamptz; v_tz text; c record; v_posted int := 0; v_late boolean;
begin
  select * into o from public.toast_orders where id = p_order for update;
  select timezone into v_tz from public.locations where id = o.location_id;
  v_at := (o.business_date::timestamp + time '12:00') at time zone v_tz;
  -- never rewrite history behind a posted count: late changes are booked now
  v_late := exists (select 1 from public.count_sessions where location_id = o.location_id and status = 'posted' and count_at >= v_at);
  if v_late then v_at := now(); end if;

  if to_regclass('pg_temp.tmp_toast_usage') is null then
    create temporary table tmp_toast_usage (product_id uuid, base_qty numeric) on commit drop;
  end if;
  truncate tmp_toast_usage;
  if not o.voided and not o.deleted then
    insert into tmp_toast_usage
    select rc.product_id, rc.base_qty
    from public.toast_order_items i
    join public.menu_items mi on mi.id = i.menu_item_id and mi.recipe_id is not null
    cross join lateral app.recipe_components(mi.recipe_id, mi.portion_qty * (i.quantity - i.refunded_quantity), true) rc
    where i.order_id = p_order and not i.voided and i.quantity - i.refunded_quantity > 0;
  end if;

  for c in
    select coalesce(w.product_id, u.product_id) as product_id, coalesce(w.q, 0) as want, coalesce(u.base_qty, 0) as have
    from (select product_id, round(sum(base_qty), 4) as q from tmp_toast_usage group by product_id) w
    full join (select product_id, base_qty from public.toast_order_usage where order_id = p_order) u on u.product_id = w.product_id
  loop
    continue when c.want = c.have;
    perform app.post_inventory_txn(o.location_id, c.product_id, 'POS_CONSUMPTION', -(c.want - c.have), app.current_unit_cost(o.location_id, c.product_id),
      v_at, 'toast_order', p_order, null, null, case when c.have = 0 then null else 'TOAST_UPDATE' end, 'Toast ' || o.business_date,
      case when v_late then 'Late Toast change after a posted count' end);
    v_posted := v_posted + 1;
    if c.want = 0 then
      delete from public.toast_order_usage where order_id = p_order and product_id = c.product_id;
    else
      insert into public.toast_order_usage (order_id, product_id, base_qty) values (p_order, c.product_id, c.want)
      on conflict (order_id, product_id) do update set base_qty = excluded.base_qty;
    end if;
  end loop;
  return v_posted;
end $$;

-- Rebuild the day's sales row (sales, guests, items, theoretical cost) from the orders.
create or replace function app.rebuild_toast_day(p_location uuid, p_date date) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_org uuid := app.location_org(p_location);
begin
  select id into v_id from public.sales_imports where location_id = p_location and business_date = p_date and status = 'posted' and source = 'toast_api';
  if v_id is null then
    insert into public.sales_imports (organization_id, location_id, business_date, source, file_name, imported_by)
    values (v_org, p_location, p_date, 'toast_api', 'Toast order sync', auth.uid()) returning id into v_id;
  end if;
  delete from public.sales_lines where import_id = v_id;
  insert into public.sales_lines (import_id, menu_item_id, pos_item_id, item_name, quantity, net_sales, voids, refunds, recipe_cost)
  select v_id, i.menu_item_id, i.item_guid, min(i.item_name),
         sum(case when i.voided or o.voided or o.deleted then 0 else i.quantity - i.refunded_quantity end),
         sum(case when i.voided or o.voided or o.deleted then 0 else i.net_sales end),
         sum(case when i.voided or o.voided or o.deleted then i.quantity else 0 end),
         sum(case when i.voided or o.voided or o.deleted then 0 else i.refunded_quantity end),
         (select public.recipe_unit_cost(mi.recipe_id, p_location) * mi.portion_qty from public.menu_items mi where mi.id = i.menu_item_id and mi.recipe_id is not null)
  from public.toast_order_items i join public.toast_orders o on o.id = i.order_id
  where o.location_id = p_location and o.business_date = p_date
  group by i.menu_item_id, i.item_guid;
  update public.sales_imports s set
    net_sales = coalesce((select sum(net_sales) from public.toast_orders where location_id = p_location and business_date = p_date and not voided and not deleted), 0),
    gross_sales = coalesce((select sum(net_sales) from public.toast_orders where location_id = p_location and business_date = p_date and not voided and not deleted), 0),
    guest_count = coalesce((select sum(guest_count) from public.toast_orders where location_id = p_location and business_date = p_date and not voided and not deleted), 0),
    check_count = (select count(*) from public.toast_orders where location_id = p_location and business_date = p_date and not voided and not deleted),
    voids = coalesce((select sum(net_sales) from public.toast_orders where location_id = p_location and business_date = p_date and (voided or deleted)), 0),
    refunds = coalesce((select sum(i.refunded_quantity) from public.toast_order_items i join public.toast_orders o on o.id = i.order_id
                        where o.location_id = p_location and o.business_date = p_date), 0),
    unmapped_lines = (select count(*) from public.sales_lines where import_id = v_id and menu_item_id is null and quantity > 0),
    theoretical_cost = coalesce((select round(sum(quantity * coalesce(recipe_cost, 0)), 4) from public.sales_lines where import_id = v_id), 0)
  where s.id = v_id;
  return v_id;
end $$;

-- ---------------------------------------------------------------------
-- Ingest one normalized order. Callable by the server (webhook/API job) or by a
-- manager with sales.import (manual upload). Always returns; problems are logged.
-- ---------------------------------------------------------------------
create or replace function public.ingest_toast_order(p_location uuid, p_order jsonb, p_source text default 'manual') returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_org uuid := app.location_org(p_location);
  v_guid text := nullif(btrim(p_order ->> 'guid'), '');
  v_date date; v_version bigint; v_hash text; o public.toast_orders; s jsonb; v_mi uuid; v_unmapped int := 0; v_posted int;
begin
  -- authorization failures are raised to the caller, never swallowed into the log
  if not app.is_trusted_caller() then perform app.require_permission('sales.import', p_location); end if;
  if v_org is null then raise exception 'Location not found'; end if;
  if v_guid is null then raise exception 'Toast order has no guid'; end if;
  begin  -- everything below is all-or-nothing; a failure is logged and alerted
  begin
    v_date := (p_order ->> 'business_date')::date;
    v_version := (p_order ->> 'modified_at')::bigint;
  exception when others then
    insert into public.toast_sync_log (organization_id, location_id, source, toast_guid, status, message)
    values (v_org, p_location, p_source, v_guid, 'error', 'Missing or invalid business_date / modified_at');
    return jsonb_build_object('status', 'error', 'message', 'Missing or invalid business_date / modified_at');
  end;
  if v_date is null or v_version is null then
    insert into public.toast_sync_log (organization_id, location_id, source, toast_guid, status, message)
    values (v_org, p_location, p_source, v_guid, 'error', 'Missing business_date or modified_at');
    return jsonb_build_object('status', 'error', 'message', 'Missing business_date or modified_at');
  end if;
  v_hash := md5((p_order - 'received_at')::text);

  -- A day imported from a file is not also synced (that would double count).
  if exists (select 1 from public.sales_imports where location_id = p_location and business_date = v_date and status = 'posted' and source <> 'toast_api') then
    insert into public.toast_sync_log (organization_id, location_id, source, toast_guid, business_date, status, message)
    values (v_org, p_location, p_source, v_guid, v_date, 'held',
            format('Sales for %s were already imported from a file. Reverse that import to let Toast sync this day.', v_date));
    perform app.raise_alert(p_location, 'sync_failure', 'warning', 'Toast orders held for ' || to_char(v_date, 'Mon DD'),
      'That day was already imported from a file, so synced orders are held to avoid counting sales twice.', 'toast_held:' || v_date);
    return jsonb_build_object('status', 'held');
  end if;

  -- serialize concurrent events for the same order
  perform pg_advisory_xact_lock(hashtextextended(p_location::text || v_guid, 0));
  select * into o from public.toast_orders where location_id = p_location and toast_guid = v_guid for update;
  if o.id is not null and (o.modified_at > v_version or (o.modified_at = v_version and o.payload_hash = v_hash)) then
    insert into public.toast_sync_log (organization_id, location_id, source, toast_guid, business_date, status, message)
    values (v_org, p_location, p_source, v_guid, v_date, case when o.modified_at > v_version then 'stale' else 'unchanged' end,
            case when o.modified_at > v_version then 'Older than the version already applied' else 'Already applied' end);
    return jsonb_build_object('status', case when o.modified_at > v_version then 'stale' else 'unchanged' end, 'order_id', o.id);
  end if;
  if o.id is not null and o.business_date <> v_date then
    insert into public.toast_sync_log (organization_id, location_id, source, toast_guid, business_date, status, message)
    values (v_org, p_location, p_source, v_guid, v_date, 'error', 'Business date changed in Toast; review manually');
    return jsonb_build_object('status', 'error', 'message', 'Business date changed');
  end if;

  if o.id is null then
    insert into public.toast_orders (organization_id, location_id, toast_guid, business_date, modified_at, payload_hash)
    values (v_org, p_location, v_guid, v_date, v_version, v_hash) returning * into o;
  end if;
  delete from public.toast_order_items where order_id = o.id;
  for s in select * from jsonb_array_elements(coalesce(p_order -> 'selections', '[]'::jsonb)) loop
    continue when nullif(s ->> 'guid', '') is null;
    select mi.id into v_mi from public.menu_items mi
     where mi.organization_id = v_org and mi.active
       and ((nullif(s ->> 'item_guid', '') is not null and mi.pos_item_id = s ->> 'item_guid') or lower(mi.name) = lower(btrim(s ->> 'name')))
     order by (mi.pos_item_id = s ->> 'item_guid') desc nulls last limit 1;
    insert into public.toast_order_items (order_id, selection_guid, item_guid, item_name, quantity, refunded_quantity, net_sales, voided, menu_item_id)
    values (o.id, s ->> 'guid', nullif(s ->> 'item_guid', ''), coalesce(nullif(btrim(s ->> 'name'), ''), s ->> 'item_guid', 'Unknown item'),
            greatest(coalesce((s ->> 'quantity')::numeric, 0), 0), greatest(coalesce((s ->> 'refunded_quantity')::numeric, 0), 0),
            coalesce((s ->> 'net_sales')::numeric, 0), coalesce((s ->> 'voided')::boolean, false), v_mi)
    on conflict (order_id, selection_guid) do nothing;
    if v_mi is null or not exists (select 1 from public.menu_items where id = v_mi and recipe_id is not null) then
      v_unmapped := v_unmapped + case when coalesce((s ->> 'voided')::boolean, false) then 0 else 1 end;
    end if;
  end loop;
  update public.toast_orders set modified_at = v_version, payload_hash = v_hash,
    voided = coalesce((p_order ->> 'voided')::boolean, false), deleted = coalesce((p_order ->> 'deleted')::boolean, false),
    guest_count = greatest(coalesce((p_order ->> 'guest_count')::int, 0), 0),
    net_sales = coalesce((select sum(net_sales) from public.toast_order_items where order_id = o.id and not voided), 0),
    unmapped_items = v_unmapped, updated_at = now()
  where id = o.id;

  v_posted := app.apply_toast_order_usage(o.id);
  perform app.rebuild_toast_day(p_location, v_date);
  if v_unmapped > 0 then
    perform app.create_task(p_location, 'Map Toast menu items to recipes', 'custom', now() + interval '1 day',
      'Unmapped Toast items do not deplete inventory until they are mapped (Sales / Toast).', null, null, 'toast_unmapped');
  end if;
  insert into public.toast_sync_log (organization_id, location_id, source, toast_guid, business_date, status, message)
  values (v_org, p_location, p_source, v_guid, v_date, 'applied',
          format('%s ingredient movement(s)%s%s', v_posted, case when v_unmapped > 0 then format(', %s unmapped item(s)', v_unmapped) else '' end,
                 case when coalesce((p_order ->> 'voided')::boolean, false) or coalesce((p_order ->> 'deleted')::boolean, false) then ', order voided' else '' end));
  return jsonb_build_object('status', 'applied', 'order_id', o.id, 'movements', v_posted, 'unmapped', v_unmapped);
  exception when others then
    -- the order's changes are rolled back by this block; record why and alert
    insert into public.toast_sync_log (organization_id, location_id, source, toast_guid, status, message)
    values (v_org, p_location, p_source, v_guid, 'error', left(sqlerrm, 500));
    perform app.raise_alert(p_location, 'sync_failure', 'critical', 'Toast sync error',
      'An order could not be processed: ' || left(sqlerrm, 200), 'toast_error:' || v_guid);
    return jsonb_build_object('status', 'error', 'message', sqlerrm);
  end;
end $$;

-- After mapping a menu item, re-derive usage for the store's orders that contain it.
create or replace function public.reprocess_toast_orders(p_location uuid, p_since date default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare o record; v_n int := 0; v_m int := 0; d date;
begin
  if not app.is_trusted_caller() then perform app.require_permission('sales.import', p_location); end if;
  for o in select t.id, t.business_date from public.toast_orders t where t.location_id = p_location
             and t.business_date >= coalesce(p_since, current_date - 60) and t.unmapped_items > 0 loop
    update public.toast_order_items i set menu_item_id = (
      select mi.id from public.menu_items mi where mi.organization_id = app.location_org(p_location) and mi.active
        and ((i.item_guid is not null and mi.pos_item_id = i.item_guid) or lower(mi.name) = lower(i.item_name))
      order by (mi.pos_item_id = i.item_guid) desc nulls last limit 1)
    where i.order_id = o.id;
    update public.toast_orders t set unmapped_items = (select count(*) from public.toast_order_items i left join public.menu_items mi on mi.id = i.menu_item_id
                                                        where i.order_id = t.id and not i.voided and mi.recipe_id is null)
    where t.id = o.id;
    v_m := v_m + app.apply_toast_order_usage(o.id);
    v_n := v_n + 1;
  end loop;
  for d in select distinct business_date from public.toast_orders where location_id = p_location and business_date >= coalesce(p_since, current_date - 60) loop
    perform app.rebuild_toast_day(p_location, d);
  end loop;
  if v_n > 0 then
    insert into public.toast_sync_log (organization_id, location_id, source, status, message)
    values (app.location_org(p_location), p_location, 'reprocess', 'applied', format('%s order(s) reprocessed after mapping, %s ingredient movement(s)', v_n, v_m));
  end if;
  return jsonb_build_object('orders', v_n, 'movements', v_m);
end $$;

-- Sync health for the integration screen.
create or replace function public.toast_sync_status(p_location uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'restaurant_guid', (select external_location_id from public.pos_integrations where location_id = p_location and provider = 'toast'),
    'last_event_at', (select max(created_at) from public.toast_sync_log where location_id = p_location),
    'last_applied_at', (select max(created_at) from public.toast_sync_log where location_id = p_location and status = 'applied'),
    'orders_today', (select count(*) from public.toast_orders where location_id = p_location
                       and business_date = (now() at time zone (select timezone from public.locations where id = p_location))::date),
    'errors_24h', (select count(*) from public.toast_sync_log where location_id = p_location and status in ('error', 'held') and created_at > now() - interval '24 hours'),
    'unmapped', (select coalesce(jsonb_agg(x order by x.qty desc), '[]'::jsonb) from (
        select i.item_guid, i.item_name, sum(i.quantity) as qty from public.toast_order_items i join public.toast_orders o on o.id = i.order_id
        left join public.menu_items mi on mi.id = i.menu_item_id
        where o.location_id = p_location and not i.voided and mi.recipe_id is null and o.business_date >= current_date - 60
        group by i.item_guid, i.item_name) x))
  where p_location in (select app.user_location_ids()) and app.has_permission('sales.import', p_location)
$$;

-- Toast failures email the owners who asked for them. (Compared as text: the
-- sync_failure enum value may be new in this same transaction.)
create or replace function app.alert_email_kind(p_type public.alert_type) returns text
language sql immutable as $$
  select case p_type::text
    when 'high_waste' then 'waste_alert'
    when 'high_variance' then 'variance_alert'
    when 'short_delivery' then 'delivery_discrepancy'
    when 'invoice_difference' then 'delivery_discrepancy'
    when 'temperature_failure' then 'delivery_discrepancy'
    when 'price_increase' then 'price_alert'
    when 'sync_failure' then 'sync_failure'
  end
$$;

select app.apply_grants();
