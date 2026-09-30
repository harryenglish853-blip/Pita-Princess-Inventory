-- =====================================================================
-- ALERT ENGINE and OPERATIONAL TASKS
-- =====================================================================

create type public.alert_type as enum (
  'low_stock', 'out_of_stock', 'critical_stock', 'negative_inventory', 'high_variance', 'high_waste', 'price_increase',
  'invoice_difference', 'late_delivery', 'order_not_submitted', 'inventory_due', 'inventory_not_posted',
  'unexpected_consumption', 'expiring_product', 'temperature_failure', 'short_delivery'
);

create table public.alerts (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  location_id     uuid references public.locations(id) on delete cascade,
  alert_type      public.alert_type not null,
  severity        text not null default 'warning' check (severity in ('info', 'warning', 'critical')),
  title           text not null,
  message         text,
  product_id      uuid references public.products(id),
  entity_type     text,
  entity_id       uuid,
  dedupe_key      text not null,
  data            jsonb not null default '{}'::jsonb,
  status          text not null default 'open' check (status in ('open', 'acknowledged', 'resolved')),
  acknowledged_by uuid references public.profiles(id),
  acknowledged_at timestamptz,
  resolved_by     uuid references public.profiles(id),
  resolved_at     timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create unique index alerts_open_dedupe on public.alerts (location_id, dedupe_key) where status <> 'resolved';
create index on public.alerts (location_id, status, created_at desc);
create trigger trg_alerts_touch before update on public.alerts for each row execute function app.touch_updated_at();
insert into app.write_protected_tables values ('alerts');

create or replace function app.raise_alert(
  p_location uuid, p_type public.alert_type, p_severity text, p_title text, p_message text,
  p_dedupe text, p_product uuid default null, p_entity_type text default null, p_entity_id uuid default null,
  p_data jsonb default '{}'::jsonb
) returns void
language plpgsql security definer set search_path = public as $$
begin
  insert into public.alerts (organization_id, location_id, alert_type, severity, title, message, product_id, entity_type, entity_id, dedupe_key, data)
  values (app.location_org(p_location), p_location, p_type, p_severity, p_title, p_message, p_product, p_entity_type, p_entity_id, p_dedupe, p_data)
  on conflict (location_id, dedupe_key) where status <> 'resolved'
  do update set title = excluded.title, message = excluded.message, severity = excluded.severity, data = excluded.data;
end $$;

create or replace function app.resolve_alerts(p_location uuid, p_dedupe_prefix text, p_keep text[]) returns void
language plpgsql security definer set search_path = public as $$
begin
  update public.alerts set status = 'resolved', resolved_at = now()
  where location_id = p_location and status <> 'resolved'
    and dedupe_key like p_dedupe_prefix || '%'
    and not (dedupe_key = any(coalesce(p_keep, '{}')));
end $$;

-- ---------------------------------------------------------------------
-- Tasks
-- ---------------------------------------------------------------------
create table public.tasks (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  location_id     uuid not null references public.locations(id) on delete cascade,
  title           text not null check (length(btrim(title)) > 0),
  description     text,
  task_type       text not null default 'custom' check (task_type in ('count', 'order', 'receive', 'review_variance', 'review_waste', 'invoice', 'custom')),
  due_at          timestamptz not null,
  assigned_to     uuid references public.profiles(id),
  entity_type     text,
  entity_id       uuid,
  dedupe_key      text,
  recurrence      text check (recurrence in ('daily', 'weekly', 'monthly')),
  status          text not null default 'open' check (status in ('open', 'complete', 'cancelled')),
  completed_by    uuid references public.profiles(id),
  completed_at    timestamptz,
  created_by      uuid references public.profiles(id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index on public.tasks (location_id, status, due_at);
create unique index tasks_open_dedupe on public.tasks (location_id, dedupe_key) where status = 'open' and dedupe_key is not null;
create trigger trg_tasks_touch before update on public.tasks for each row execute function app.touch_updated_at();

create or replace function app.create_task(p_location uuid, p_title text, p_type text, p_due timestamptz, p_description text,
                                           p_entity_type text, p_entity_id uuid, p_dedupe text) returns void
language plpgsql security definer set search_path = public as $$
begin
  insert into public.tasks (organization_id, location_id, title, description, task_type, due_at, entity_type, entity_id, dedupe_key, created_by)
  values (app.location_org(p_location), p_location, p_title, p_description, p_type, p_due, p_entity_type, p_entity_id, p_dedupe, auth.uid())
  on conflict (location_id, dedupe_key) where status = 'open' and dedupe_key is not null do nothing;
end $$;

create or replace function app.complete_tasks_for(p_entity_id uuid, p_type text) returns void
language plpgsql security definer set search_path = public as $$
begin
  update public.tasks set status = 'complete', completed_at = now(), completed_by = auth.uid()
  where entity_id = p_entity_id and task_type = p_type and status = 'open';
end $$;

create or replace function public.complete_task(p_task uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_t public.tasks;
begin
  select * into v_t from public.tasks where id = p_task for update;
  if v_t.id is null or not (v_t.location_id in (select app.user_location_ids())) then raise exception 'Task not found'; end if;
  if not (v_t.assigned_to = auth.uid() or v_t.assigned_to is null or app.has_permission('tasks.manage', v_t.location_id)) then
    raise exception 'Only the assignee or a manager can complete this task' using errcode = '42501';
  end if;
  if v_t.status <> 'open' then return; end if;
  update public.tasks set status = 'complete', completed_at = now(), completed_by = auth.uid() where id = p_task;
  if v_t.recurrence is not null then
    insert into public.tasks (organization_id, location_id, title, description, task_type, due_at, assigned_to, recurrence, created_by)
    values (v_t.organization_id, v_t.location_id, v_t.title, v_t.description, v_t.task_type,
            v_t.due_at + case v_t.recurrence when 'daily' then interval '1 day' when 'weekly' then interval '7 days' else interval '1 month' end,
            v_t.assigned_to, v_t.recurrence, auth.uid());
  end if;
  perform app.audit(v_t.organization_id, v_t.location_id, 'complete', 'task', p_task::text, v_t.title, null, null);
end $$;

create or replace function public.acknowledge_alert(p_alert uuid, p_resolve boolean default false) returns void
language plpgsql security definer set search_path = public as $$
declare v_a public.alerts;
begin
  select * into v_a from public.alerts where id = p_alert for update;
  if v_a.id is null or not (v_a.location_id in (select app.user_location_ids())) then raise exception 'Alert not found'; end if;
  update public.alerts set
    status = case when p_resolve then 'resolved' else 'acknowledged' end,
    acknowledged_by = coalesce(acknowledged_by, auth.uid()), acknowledged_at = coalesce(acknowledged_at, now()),
    resolved_by = case when p_resolve then auth.uid() end, resolved_at = case when p_resolve then now() end
  where id = p_alert;
end $$;

alter table public.alerts enable row level security;
alter table public.tasks enable row level security;

create policy alerts_select on public.alerts for select to authenticated
  using (location_id in (select app.user_location_ids()));
create policy tasks_select on public.tasks for select to authenticated
  using (location_id in (select app.user_location_ids()));
create policy tasks_insert on public.tasks for insert to authenticated
  with check (app.has_permission('tasks.manage', location_id) and organization_id = app.location_org(location_id));
create policy tasks_update on public.tasks for update to authenticated
  using (app.has_permission('tasks.manage', location_id))
  with check (app.has_permission('tasks.manage', location_id));

-- Stock alerts are recomputed from current balances (called by the dashboard and after posting).
create or replace function public.refresh_stock_alerts(p_location uuid) returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_keep text[];
  v_n integer;
begin
  if not (p_location in (select app.user_location_ids())) then raise exception 'Location not found' using errcode = '42501'; end if;

  with st as (
    select ci.* from public.current_inventory ci where ci.location_id = p_location and ci.active
  ),
  raised as (
    select app.raise_alert(p_location,
             case st.stock_status when 'negative' then 'negative_inventory'::public.alert_type
                                  when 'out' then 'out_of_stock'::public.alert_type
                                  when 'critical' then 'critical_stock'::public.alert_type
                                  else 'low_stock'::public.alert_type end,
             case when st.stock_status in ('negative', 'out', 'critical') then 'critical' else 'warning' end,
             case st.stock_status when 'negative' then 'Negative inventory: ' || st.product_name
                                  when 'out' then 'Out of stock: ' || st.product_name
                                  when 'critical' then 'Critical stock: ' || st.product_name
                                  else 'Low stock: ' || st.product_name end,
             case when st.stock_status = 'negative'
                  then format('Book inventory is %s %s. Possible causes: missing receipt, incorrect recipe, missing production, wrong unit conversion, unrecorded transfer or a bad count.', st.on_hand, st.inventory_unit)
                  else format('On hand %s %s (par %s)', st.on_hand, st.inventory_unit, coalesce(st.effective_par::text, 'not set')) end,
             'stock:' || st.product_id || ':' || st.stock_status, st.product_id, 'product', st.product_id,
             jsonb_build_object('on_hand', st.on_hand, 'par', st.effective_par)) as x,
           'stock:' || st.product_id || ':' || st.stock_status as k
    from st
    where st.stock_status <> 'ok'
      and (st.stock_status = 'negative' or st.effective_par is not null or st.min_qty is not null or st.last_txn_at is not null)
  )
  select array_agg(k) into v_keep from raised;
  perform app.resolve_alerts(p_location, 'stock:', v_keep);

  -- Inventory due: no posted count in 7 days
  if not exists (select 1 from public.count_sessions where location_id = p_location and status = 'posted' and count_at > now() - interval '7 days') then
    perform app.raise_alert(p_location, 'inventory_due', 'warning', 'Weekly inventory is due',
      'No inventory count has been posted in the last 7 days.', 'inventory_due');
  else
    perform app.resolve_alerts(p_location, 'inventory_due', null);
  end if;

  -- Counts waiting too long for posting
  select array_agg('count_unposted:' || id) into v_keep from public.count_sessions
   where location_id = p_location and status in ('awaiting_review', 'reviewed') and submitted_at < now() - interval '24 hours';
  perform app.raise_alert(p_location, 'inventory_not_posted', 'warning', 'Inventory not posted: ' || s.name,
    'Submitted ' || to_char(s.submitted_at, 'Mon DD HH24:MI') || ' and still not posted.', 'count_unposted:' || s.id, null, 'count_session', s.id)
  from public.count_sessions s
  where s.location_id = p_location and s.status in ('awaiting_review', 'reviewed') and s.submitted_at < now() - interval '24 hours';
  perform app.resolve_alerts(p_location, 'count_unposted:', v_keep);

  select count(*) into v_n from public.alerts where location_id = p_location and status <> 'resolved';
  return v_n;
end $$;

select app.apply_grants();
