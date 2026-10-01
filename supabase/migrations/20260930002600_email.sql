-- =====================================================================
-- EMAIL: recipients, per-report subscriptions, outbox, report data
--
-- Every email is a row in email_outbox with a unique dedupe_key, written in
-- the same transaction as the event that caused it (an alert, a submitted
-- commissary order, the daily schedule). A server job renders and sends
-- pending rows (Resend) and records the result, so an email is never lost
-- when a request fails and never sent twice.
-- =====================================================================

-- The server's scheduled jobs call the API with the service-role key.
create or replace function app.is_service_role() returns boolean
language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '') = 'service_role'
$$;

create or replace function app.is_trusted_caller() returns boolean
language sql stable as $$
  select app.is_system_caller() or app.is_service_role()
$$;

-- Server jobs act for every location (service_role already bypasses RLS).
create or replace function app.user_location_ids() returns setof uuid
language sql stable security definer set search_path = public as $$
  select distinct l.id
  from public.user_roles ur
  join public.organization_members m on m.organization_id = ur.organization_id and m.user_id = ur.user_id and m.active
  join public.locations l on l.organization_id = ur.organization_id
  where ur.user_id = auth.uid()
    and (   ur.scope_type = 'organization'
         or (ur.scope_type = 'region'   and ur.scope_id = l.region_id)
         or (ur.scope_type = 'district' and ur.scope_id = l.district_id)
         or (ur.scope_type = 'location' and ur.scope_id = l.id))
  union
  select l.id from public.locations l where app.is_trusted_caller()
$$;

create or replace function app.require_location_access(p_location uuid) returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if app.is_trusted_caller() then return; end if;
  if not (p_location in (select app.user_location_ids())) then raise exception 'Location not found' using errcode = '42501'; end if;
end $$;

create or replace function app.require_report_access(p_perm text, p_location uuid) returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if app.is_trusted_caller() then return; end if;
  perform app.require_permission(p_perm, p_location);
end $$;

-- ---------------------------------------------------------------------
-- What can be emailed
-- ---------------------------------------------------------------------
create table public.email_kinds (
  key         text primary key,
  label       text not null,
  description text not null,
  category    text not null check (category in ('report', 'alert', 'operations')),
  sort        integer not null
);
insert into public.email_kinds values
  ('daily_report',          'Daily report',                 'Yesterday''s sales, waste, deliveries, stock and what needs attention (6 AM).', 'report', 1),
  ('weekly_report',         'Weekly report',                'Sales, purchases, inventory, food cost, waste, variances and vendor spending for last week (Monday 6 AM).', 'report', 2),
  ('monthly_report',        'Monthly owner report',         'Month totals, food cost, AvT, waste, vendor price trends, best/worst weeks, month over month (1st, 6 AM).', 'report', 3),
  ('waste_alert',           'High waste',                   'Waste this week went over the limit.', 'alert', 10),
  ('variance_alert',        'Inventory variance',           'A posted count lost more than the dollar tolerance on an item.', 'alert', 11),
  ('delivery_discrepancy',  'Delivery discrepancies',       'Short, over, missing, damaged or rejected items, invoice differences, temperature failures.', 'alert', 12),
  ('price_alert',           'Price increases',              'A vendor price rose more than the price-alert percentage.', 'alert', 13),
  ('critical_stock',        'Critical / out of stock',      'Once a day: items at or below minimum or out.', 'alert', 14),
  ('low_stock',             'Low stock',                    'Once a day: items below the reorder point.', 'alert', 15),
  ('inventory_due',         'Inventory due',                'Once a day while no count has been posted for 7 days.', 'operations', 20),
  ('vendor_order_reminder', 'Vendor order reminders',       'A vendor''s order cutoff is within 4 hours and nothing is marked as ordered.', 'operations', 21),
  ('commissary_order',      'Commissary orders',            'A restaurant submitted a commissary order.', 'operations', 22),
  ('sync_failure',          'Failed sync',                  'Toast sales could not be processed.', 'alert', 23);

create table public.email_recipients (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  location_id     uuid references public.locations(id) on delete cascade,   -- null = every location
  name            text not null check (length(btrim(name)) > 0),
  email           text not null check (email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  active          boolean not null default true,
  created_by      uuid references public.profiles(id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create unique index email_recipients_uniq on public.email_recipients (organization_id, lower(email), coalesce(location_id, '00000000-0000-0000-0000-000000000000'::uuid));
create trigger trg_email_recipients_touch before update on public.email_recipients for each row execute function app.touch_updated_at();
create trigger trg_email_recipients_audit after insert or update on public.email_recipients for each row execute function app.audit_row();

create table public.email_subscriptions (
  recipient_id    uuid not null references public.email_recipients(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  kind            text not null references public.email_kinds(key),
  primary key (recipient_id, kind)
);

create table public.email_outbox (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  location_id     uuid references public.locations(id) on delete cascade,
  kind            text not null references public.email_kinds(key),
  dedupe_key      text not null unique,
  subject         text not null,
  payload         jsonb not null,
  recipients      text[] not null default '{}',
  status          text not null default 'pending' check (status in ('pending', 'sending', 'sent', 'failed', 'skipped')),
  attempts        integer not null default 0,
  last_error      text,
  provider_id     text,
  created_at      timestamptz not null default now(),
  claimed_at      timestamptz,
  sent_at         timestamptz
);
create index on public.email_outbox (status, created_at);
create index on public.email_outbox (organization_id, created_at desc);

insert into app.write_protected_tables values ('email_kinds'), ('email_recipients'), ('email_subscriptions'), ('email_outbox');

alter table public.email_kinds enable row level security;
alter table public.email_recipients enable row level security;
alter table public.email_subscriptions enable row level security;
alter table public.email_outbox enable row level security;
create policy email_kinds_select on public.email_kinds for select to authenticated using (true);
create policy email_recipients_select on public.email_recipients for select to authenticated
  using (app.has_org_permission('settings.manage', organization_id));
create policy email_subscriptions_select on public.email_subscriptions for select to authenticated
  using (app.has_org_permission('settings.manage', organization_id));
-- Outbox payloads contain financial data: owners/admins only.
create policy email_outbox_select on public.email_outbox for select to authenticated
  using (app.has_org_permission('settings.manage', organization_id));

-- ---------------------------------------------------------------------
-- Recipients (owners / settings.manage at company level)
-- ---------------------------------------------------------------------
create or replace function public.save_email_recipient(p_org uuid, p_id uuid, p_name text, p_email text, p_location uuid,
                                                       p_active boolean, p_kinds text[])
returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_bad text;
begin
  perform app.require_org_permission('settings.manage', p_org);
  if p_location is not null and app.location_org(p_location) is distinct from p_org then raise exception 'Location not in organization'; end if;
  select k into v_bad from unnest(coalesce(p_kinds, '{}')) k where k not in (select key from public.email_kinds) limit 1;
  if v_bad is not null then raise exception 'Unknown email type %', v_bad; end if;
  if p_id is null then
    insert into public.email_recipients (organization_id, location_id, name, email, active, created_by)
    values (p_org, p_location, btrim(p_name), lower(btrim(p_email)), coalesce(p_active, true), auth.uid()) returning id into v_id;
  else
    update public.email_recipients set name = btrim(p_name), email = lower(btrim(p_email)), location_id = p_location, active = coalesce(p_active, active)
    where id = p_id and organization_id = p_org returning id into v_id;
    if v_id is null then raise exception 'Recipient not found'; end if;
  end if;
  delete from public.email_subscriptions where recipient_id = v_id and not (kind = any(coalesce(p_kinds, '{}')));
  insert into public.email_subscriptions (recipient_id, organization_id, kind)
  select v_id, p_org, k from unnest(coalesce(p_kinds, '{}')) k on conflict do nothing;
  perform app.audit(p_org, p_location, 'subscriptions', 'email_recipient', v_id::text, 'Email settings for ' || lower(btrim(p_email)),
                    null, jsonb_build_object('kinds', p_kinds, 'active', p_active));
  return v_id;
end $$;

-- ---------------------------------------------------------------------
-- Queue an email. Recipients are resolved now (who was subscribed when it
-- happened). No subscribers -> stored as "skipped" so it is still visible.
-- ---------------------------------------------------------------------
create or replace function app.queue_email(p_org uuid, p_location uuid, p_kind text, p_dedupe text, p_subject text, p_payload jsonb,
                                           p_extra_locations uuid[] default '{}', p_rate_limit integer default null)
returns uuid
language plpgsql security definer set search_path = public as $$
declare v_to text[]; v_id uuid; v_recent integer; v_status text := 'pending'; v_err text;
begin
  select array_agg(distinct r.email order by r.email) into v_to
  from public.email_recipients r join public.email_subscriptions s on s.recipient_id = r.id and s.kind = p_kind
  where r.organization_id = p_org and r.active
    and (r.location_id is null or r.location_id = p_location or r.location_id = any(coalesce(p_extra_locations, '{}')));
  if v_to is null then v_status := 'skipped'; v_err := 'No recipients are subscribed to this email'; end if;
  if v_status = 'pending' and p_rate_limit is not null then
    select count(*) into v_recent from public.email_outbox
     where location_id is not distinct from p_location and kind = p_kind and status in ('pending', 'sending', 'sent') and created_at > now() - interval '1 hour';
    if v_recent >= p_rate_limit then v_status := 'skipped'; v_err := format('Rate limited (%s %s emails in the last hour); included in the daily report', v_recent, p_kind); end if;
  end if;
  insert into public.email_outbox (organization_id, location_id, kind, dedupe_key, subject, payload, recipients, status, last_error)
  values (p_org, p_location, p_kind, p_dedupe, p_subject,
          p_payload || jsonb_build_object('location', (select jsonb_build_object('id', l.id, 'code', l.code, 'name', l.name, 'timezone', l.timezone)
                                                       from public.locations l where l.id = p_location),
                                          'organization', (select name from public.organizations where id = p_org)),
          coalesce(v_to, '{}'), v_status, v_err)
  on conflict (dedupe_key) do nothing
  returning id into v_id;
  return v_id;
end $$;

-- Immediate alert emails: queued when an alert is first raised (not when it is refreshed).
create or replace function app.alert_email_kind(p_type public.alert_type) returns text
language sql immutable as $$
  select case p_type
    when 'high_waste' then 'waste_alert'
    when 'high_variance' then 'variance_alert'
    when 'short_delivery' then 'delivery_discrepancy'
    when 'invoice_difference' then 'delivery_discrepancy'
    when 'temperature_failure' then 'delivery_discrepancy'
    when 'price_increase' then 'price_alert'
  end
$$;

create or replace function app.raise_alert(
  p_location uuid, p_type public.alert_type, p_severity text, p_title text, p_message text,
  p_dedupe text, p_product uuid default null, p_entity_type text default null, p_entity_id uuid default null,
  p_data jsonb default '{}'::jsonb
) returns void
language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_new boolean; v_kind text := app.alert_email_kind(p_type);
begin
  insert into public.alerts (organization_id, location_id, alert_type, severity, title, message, product_id, entity_type, entity_id, dedupe_key, data)
  values (app.location_org(p_location), p_location, p_type, p_severity, p_title, p_message, p_product, p_entity_type, p_entity_id, p_dedupe, p_data)
  on conflict (location_id, dedupe_key) where status <> 'resolved'
  do update set title = excluded.title, message = excluded.message, severity = excluded.severity, data = excluded.data
  returning id, (xmax = 0) into v_id, v_new;
  if v_new and v_kind is not null then
    perform app.queue_email(app.location_org(p_location), p_location, v_kind, 'alert:' || v_id, p_title,
      jsonb_build_object('template', 'alert', 'alert_type', p_type, 'severity', p_severity, 'title', p_title, 'message', p_message,
                         'entity_type', p_entity_type, 'entity_id', p_entity_id, 'product_id', p_product, 'data', p_data,
                         'raised_at', now()),
      '{}', 10);
  end if;
end $$;

-- ---------------------------------------------------------------------
-- Report data (jsonb snapshots stored in the outbox payload)
-- ---------------------------------------------------------------------
create or replace function app.local_ts(p_location uuid, p_date date, p_time time default '00:00') returns timestamptz
language sql stable security definer set search_path = public as $$
  select (p_date::timestamp + p_time) at time zone (select timezone from public.locations where id = p_location)
$$;

-- Food-cost window for a period: count to count when posted counts bracket the
-- period (the usual Sunday-night count), otherwise book inventory at the edges.
create or replace function app.period_food_cost(p_location uuid, p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_start timestamptz := app.local_ts(p_location, p_from);
  v_end timestamptz := app.local_ts(p_location, p_to + 1);
  v_b public.count_sessions; v_e public.count_sessions; v_f timestamptz; v_t timestamptz; v jsonb;
begin
  select * into v_b from public.count_sessions where location_id = p_location and status = 'posted'
     and count_at <= v_start + interval '12 hours' and count_at >= v_start - interval '3 days' order by count_at desc limit 1;
  select * into v_e from public.count_sessions where location_id = p_location and status = 'posted'
     and count_at <= v_end + interval '12 hours' and count_at > coalesce(v_b.count_at, v_start) order by count_at desc limit 1;
  v_f := coalesce(v_b.count_at, v_start);
  v_t := coalesce(v_e.count_at, least(v_end, now()));
  v := public.food_cost_summary(p_location, v_f, v_t, array['food']);
  return v || jsonb_build_object('basis', case when v_b.id is not null and v_e.id is not null then 'count_to_count' else 'book' end,
                                 'begin_count', v_b.name, 'end_count', v_e.name, 'window_from', v_f, 'window_to', v_t);
end $$;

create or replace function app.attention_items(p_location uuid, p_limit integer default 8) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('title', a.title, 'message', a.message, 'severity', a.severity, 'type', a.alert_type)
                            order by case a.severity when 'critical' then 0 when 'warning' then 1 else 2 end, a.created_at desc), '[]'::jsonb)
  from (select * from public.alerts where location_id = p_location and status = 'open'
          and alert_type not in ('low_stock')
        order by case severity when 'critical' then 0 when 'warning' then 1 else 2 end, created_at desc limit p_limit) a
$$;

create or replace function app.daily_report_data(p_location uuid, p_day date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_sales public.sales_imports; v jsonb;
begin
  select * into v_sales from public.sales_imports where location_id = p_location and business_date = p_day and status = 'posted';
  select jsonb_build_object(
    'template', 'daily', 'date', p_day,
    'sales', v_sales.net_sales, 'guests', v_sales.guest_count,
    'theoretical_cost', v_sales.theoretical_cost,
    'theoretical_pct', case when v_sales.net_sales > 0 then round(v_sales.theoretical_cost / v_sales.net_sales * 100, 1) end,
    'waste', (select coalesce(sum(total_cost), 0) from public.waste_logs where location_id = p_location and business_date = p_day),
    'waste_entries', (select count(*) from public.waste_logs where location_id = p_location and business_date = p_day),
    'deliveries', (select count(*) from public.receipts where location_id = p_location and delivery_date = p_day and status in ('received', 'posted')),
    'delivery_issues', (select count(distinct r.id) from public.receipts r join public.receipt_items ri on ri.receipt_id = r.id
                         where r.location_id = p_location and r.delivery_date = p_day and r.status in ('received', 'posted') and cardinality(ri.exception_codes) > 0),
    'delivery_issue_list', (select coalesce(jsonb_agg(x), '[]'::jsonb) from (
                         select v.name as vendor, r.invoice_number, r.receipt_number,
                                (select string_agg(distinct c, ', ') from public.receipt_items ri, unnest(ri.exception_codes) c where ri.receipt_id = r.id) as issues
                         from public.receipts r join public.vendors v on v.id = r.vendor_id
                         where r.location_id = p_location and r.delivery_date = p_day and r.status in ('received', 'posted')
                           and exists (select 1 from public.receipt_items ri where ri.receipt_id = r.id and cardinality(ri.exception_codes) > 0)) x),
    'low_stock', (select count(*) from public.current_inventory where location_id = p_location and active and stock_status = 'low'),
    'critical_stock', (select count(*) from public.current_inventory where location_id = p_location and active and stock_status in ('critical', 'out', 'negative')),
    'commissary', app.commissary_summary(p_location, p_day, p_day),
    'attention', app.attention_items(p_location, 8)
  ) into v;
  return v;
end $$;

create or replace function app.period_report_data(p_location uuid, p_from date, p_to date, p_template text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_start timestamptz := app.local_ts(p_location, p_from);
  v_end timestamptz := app.local_ts(p_location, p_to + 1);
  v_fc jsonb := app.period_food_cost(p_location, p_from, p_to);
  v jsonb;
begin
  select jsonb_build_object(
    'template', p_template, 'from', p_from, 'to', p_to,
    'sales', (select coalesce(sum(net_sales), 0) from public.sales_imports where location_id = p_location and status = 'posted' and business_date between p_from and p_to),
    'sales_days', (select count(*) from public.sales_imports where location_id = p_location and status = 'posted' and business_date between p_from and p_to),
    'purchases', (select coalesce(sum(coalesce(r.invoice_total, (public.receipt_totals(r.id) ->> 'calculated_total')::numeric)), 0)
                  from public.receipts r where r.location_id = p_location and r.status = 'posted' and r.delivery_date between p_from and p_to),
    'food_cost', v_fc,
    'waste', (select coalesce(sum(total_cost), 0) from public.waste_logs where location_id = p_location and business_date between p_from and p_to),
    'top_waste', (select coalesce(jsonb_agg(x order by x.cost desc), '[]'::jsonb) from (
        select coalesce(p.name, r.name) as name, round(sum(w.total_cost), 2) as cost from public.waste_logs w
        left join public.products p on p.id = w.product_id left join public.recipes r on r.id = w.recipe_id
        where w.location_id = p_location and w.business_date between p_from and p_to group by 1 order by 2 desc limit 5) x),
    'inventory_variance', (select coalesce(sum(pl.variance_value), 0) from public.count_posting_lines pl join public.count_sessions s on s.id = pl.session_id
                           where s.location_id = p_location and s.status = 'posted' and s.count_at >= v_start and s.count_at < v_end + interval '12 hours'),
    'top_variances', (select coalesce(jsonb_agg(x order by x.value), '[]'::jsonb) from (
        select p.name, u.code as unit, round(sum(pl.variance_qty), 2) as qty, round(sum(pl.variance_value), 2) as value
        from public.count_posting_lines pl join public.count_sessions s on s.id = pl.session_id
        join public.products p on p.id = pl.product_id join public.units u on u.id = p.inventory_unit_id
        where s.location_id = p_location and s.status = 'posted' and s.count_at >= v_start and s.count_at < v_end + interval '12 hours'
        group by p.name, u.code having sum(pl.variance_value) < 0 order by 4 limit 5) x),
    'vendor_spending', (select coalesce(jsonb_agg(x order by x.total desc), '[]'::jsonb) from (
        select v.name as vendor, count(*) as deliveries,
               round(sum(coalesce(r.invoice_total, (public.receipt_totals(r.id) ->> 'calculated_total')::numeric)), 2) as total
        from public.receipts r join public.vendors v on v.id = r.vendor_id
        where r.location_id = p_location and r.status = 'posted' and r.delivery_date between p_from and p_to group by v.name) x),
    'commissary', app.commissary_summary(p_location, p_from, p_to),
    'price_alerts', (select coalesce(jsonb_agg(jsonb_build_object('title', a.title, 'message', a.message) order by a.created_at desc), '[]'::jsonb)
                     from public.alerts a where a.location_id = p_location and a.alert_type = 'price_increase' and a.created_at >= v_start and a.created_at < v_end),
    'delivery_discrepancies', (select coalesce(jsonb_agg(x order by x.delivery_date), '[]'::jsonb) from (
        select v.name as vendor, r.invoice_number, r.receipt_number, r.delivery_date,
               (select string_agg(distinct c, ', ') from public.receipt_items ri, unnest(ri.exception_codes) c where ri.receipt_id = r.id) as issues
        from public.receipts r join public.vendors v on v.id = r.vendor_id
        where r.location_id = p_location and r.delivery_date between p_from and p_to and r.status in ('received', 'posted')
          and exists (select 1 from public.receipt_items ri where ri.receipt_id = r.id and cardinality(ri.exception_codes) > 0)) x),
    'low_stock', (select coalesce(jsonb_agg(jsonb_build_object('name', product_name, 'on_hand', round(on_hand, 2), 'unit', inventory_unit, 'status', stock_status)
                                            order by case stock_status when 'negative' then 0 when 'out' then 1 when 'critical' then 2 else 3 end, product_name), '[]'::jsonb)
                  from public.current_inventory where location_id = p_location and active and stock_status <> 'ok'),
    'counts', (select coalesce(jsonb_agg(jsonb_build_object('name', s.name, 'status', s.status, 'count_at', s.count_at, 'type', s.count_type) order by s.count_at), '[]'::jsonb)
               from public.count_sessions s where s.location_id = p_location and s.count_at >= v_start and s.count_at < v_end + interval '12 hours' and s.status <> 'cancelled')
  ) into v;
  return v;
end $$;

create or replace function app.monthly_report_data(p_location uuid, p_month date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_from date := date_trunc('month', p_month)::date;
  v_to date := (date_trunc('month', p_month) + interval '1 month - 1 day')::date;
  v_prev_from date := (date_trunc('month', p_month) - interval '1 month')::date;
  v_prev_to date := (date_trunc('month', p_month) - interval '1 day')::date;
  v jsonb; v_prev jsonb; v_weeks jsonb; w date;
begin
  v := app.period_report_data(p_location, v_from, v_to, 'monthly');
  v_prev := app.period_report_data(p_location, v_prev_from, v_prev_to, 'monthly');
  -- weeks (Mon-Sun) that end inside the month, each with its own count-to-count food cost
  select coalesce(jsonb_agg(x order by x ->> 'from'), '[]'::jsonb) into v_weeks from (
    select jsonb_build_object('from', d::date, 'to', (d + interval '6 days')::date,
             'sales', (select coalesce(sum(net_sales), 0) from public.sales_imports where location_id = p_location and status = 'posted' and business_date between d::date and (d + interval '6 days')::date),
             'food_cost', app.period_food_cost(p_location, d::date, (d + interval '6 days')::date)) as x
    from generate_series(date_trunc('week', v_from::timestamp), v_to::timestamp, interval '7 days') d
    where (d + interval '6 days')::date between v_from and v_to) q;
  return v || jsonb_build_object(
    'template', 'monthly', 'month', to_char(v_from, 'YYYY-MM'),
    'previous', jsonb_build_object('sales', v_prev -> 'sales', 'purchases', v_prev -> 'purchases', 'waste', v_prev -> 'waste',
                                   'actual_pct', v_prev -> 'food_cost' -> 'actual_pct', 'theoretical_pct', v_prev -> 'food_cost' -> 'theoretical_pct',
                                   'inventory_variance', v_prev -> 'inventory_variance'),
    'weeks', v_weeks,
    'turnover', case when ((v -> 'food_cost' ->> 'begin_inventory')::numeric + (v -> 'food_cost' ->> 'end_inventory')::numeric) > 0
                     then round((v -> 'food_cost' ->> 'actual_cost')::numeric
                                / (((v -> 'food_cost' ->> 'begin_inventory')::numeric + (v -> 'food_cost' ->> 'end_inventory')::numeric) / 2), 2) end,
    'price_trends', (select coalesce(jsonb_agg(x order by abs((x ->> 'pct')::numeric) desc), '[]'::jsonb) from (
        select jsonb_build_object('product', p.name, 'vendor', v2.name, 'unit', u.code, 'first', f.base_unit_price, 'last', l.base_unit_price,
                                  'pct', round((l.base_unit_price / nullif(f.base_unit_price, 0) - 1) * 100, 1)) as x
        from (select distinct product_id, vendor_id from public.price_history
              where location_id = p_location and effective_at >= app.local_ts(p_location, v_from) and effective_at < app.local_ts(p_location, v_to + 1)) pv
        join public.products p on p.id = pv.product_id join public.units u on u.id = p.inventory_unit_id
        left join public.vendors v2 on v2.id = pv.vendor_id
        cross join lateral (select base_unit_price from public.price_history ph where ph.location_id = p_location and ph.product_id = pv.product_id
                              and ph.vendor_id is not distinct from pv.vendor_id and ph.effective_at < app.local_ts(p_location, v_to + 1)
                              and ph.effective_at < app.local_ts(p_location, v_from) order by effective_at desc limit 1) f
        cross join lateral (select base_unit_price from public.price_history ph where ph.location_id = p_location and ph.product_id = pv.product_id
                              and ph.vendor_id is not distinct from pv.vendor_id and ph.effective_at < app.local_ts(p_location, v_to + 1)
                              order by effective_at desc limit 1) l
        where f.base_unit_price is distinct from l.base_unit_price
        limit 10) q));
end $$;

-- ---------------------------------------------------------------------
-- Schedule: called every 15 minutes by the server job (service role).
-- ---------------------------------------------------------------------
create or replace function public.run_email_schedule() returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  l record; v_local timestamp; v_today date; v_n int := 0; v_id uuid; v_data jsonb; s record; v_week_start date;
  v_items jsonb;
begin
  if not app.is_trusted_caller() then raise exception 'Server job only' using errcode = '42501'; end if;
  for l in select * from public.locations where active loop
    begin
      v_local := now() at time zone l.timezone;
      v_today := v_local::date;
      perform public.refresh_stock_alerts(l.id);
      perform public.refresh_operational_alerts(l.id);
      if extract(hour from v_local) >= 6 then
        -- daily report for yesterday
        if not exists (select 1 from public.email_outbox where dedupe_key = 'daily:' || l.id || ':' || (v_today - 1)) then
          v_data := app.daily_report_data(l.id, v_today - 1);
          v_id := app.queue_email(l.organization_id, l.id, 'daily_report', 'daily:' || l.id || ':' || (v_today - 1),
                    format('Daily Restaurant Operations — %s', to_char(v_today - 1, 'FMMonth FMDD')), v_data);
          v_n := v_n + (v_id is not null)::int;
        end if;
        -- weekly report on Monday for Mon..Sun last week
        if extract(isodow from v_today) = 1 then
          v_week_start := v_today - 7;
          if not exists (select 1 from public.email_outbox where dedupe_key = 'weekly:' || l.id || ':' || v_week_start) then
            v_data := app.period_report_data(l.id, v_week_start, v_today - 1, 'weekly');
            v_id := app.queue_email(l.organization_id, l.id, 'weekly_report', 'weekly:' || l.id || ':' || v_week_start,
                      format('Weekly Restaurant Inventory Report — %s–%s', to_char(v_week_start, 'Mon FMDD'),
                             case when extract(month from v_week_start) = extract(month from v_today - 1) then to_char(v_today - 1, 'FMDD') else to_char(v_today - 1, 'Mon FMDD') end),
                      v_data);
            v_n := v_n + (v_id is not null)::int;
          end if;
        end if;
        -- monthly owner report on the 1st for last month
        if extract(day from v_today) = 1 and not exists (select 1 from public.email_outbox where dedupe_key = 'monthly:' || l.id || ':' || to_char(v_today - 1, 'YYYY-MM')) then
          v_data := app.monthly_report_data(l.id, v_today - 1);
          v_id := app.queue_email(l.organization_id, l.id, 'monthly_report', 'monthly:' || l.id || ':' || to_char(v_today - 1, 'YYYY-MM'),
                    format('Monthly Owner Report — %s', to_char(v_today - 1, 'FMMonth YYYY')), v_data);
          v_n := v_n + (v_id is not null)::int;
        end if;
        -- once-a-day stock digests
        select jsonb_agg(jsonb_build_object('name', product_name, 'on_hand', round(on_hand, 2), 'unit', inventory_unit, 'par', effective_par, 'status', stock_status) order by product_name)
          into v_items from public.current_inventory where location_id = l.id and active and stock_status in ('critical', 'out', 'negative');
        if v_items is not null then
          v_id := app.queue_email(l.organization_id, l.id, 'critical_stock', 'critical_stock:' || l.id || ':' || v_today,
                    format('Critical stock — %s item%s', jsonb_array_length(v_items), case when jsonb_array_length(v_items) = 1 then '' else 's' end),
                    jsonb_build_object('template', 'stock', 'level', 'critical', 'items', v_items, 'date', v_today));
          v_n := v_n + (v_id is not null)::int;
        end if;
        select jsonb_agg(jsonb_build_object('name', product_name, 'on_hand', round(on_hand, 2), 'unit', inventory_unit, 'par', effective_par, 'status', stock_status) order by product_name)
          into v_items from public.current_inventory where location_id = l.id and active and stock_status = 'low';
        if v_items is not null then
          v_id := app.queue_email(l.organization_id, l.id, 'low_stock', 'low_stock:' || l.id || ':' || v_today,
                    format('Low stock — %s item%s', jsonb_array_length(v_items), case when jsonb_array_length(v_items) = 1 then '' else 's' end),
                    jsonb_build_object('template', 'stock', 'level', 'low', 'items', v_items, 'date', v_today));
          v_n := v_n + (v_id is not null)::int;
        end if;
        if exists (select 1 from public.alerts where location_id = l.id and alert_type = 'inventory_due' and status = 'open') then
          v_id := app.queue_email(l.organization_id, l.id, 'inventory_due', 'inventory_due:' || l.id || ':' || v_today,
                    'Inventory due', jsonb_build_object('template', 'alert', 'title', 'Weekly inventory is due',
                    'message', 'No inventory count has been posted in the last 7 days.', 'severity', 'warning', 'link', '/counts'));
          v_n := v_n + (v_id is not null)::int;
        end if;
      end if;
      -- vendor cutoffs in the next 4 hours with nothing marked as ordered
      for s in select w.*, v.name as vendor_name from public.vendors v
               join public.location_vendor_settings lvs on lvs.vendor_id = v.id and lvs.location_id = l.id and lvs.active
               cross join lateral app.vendor_order_window(l.id, v.id) w
               where v.kind = 'distributor' and w.order_by between now() and now() + interval '4 hours'
                 and not exists (select 1 from public.purchase_orders po where po.location_id = l.id and po.vendor_id = v.id
                                   and po.expected_delivery_date = w.delivery_date and po.status not in ('draft', 'ready_to_submit', 'cancelled')) loop
        v_id := app.queue_email(l.organization_id, l.id, 'vendor_order_reminder', 'order_reminder:' || l.id || ':' || s.vendor_name || ':' || s.delivery_date,
                  format('Place %s order by %s', s.vendor_name, to_char(s.order_by at time zone l.timezone, 'FMHH12:MI AM')),
                  jsonb_build_object('template', 'alert', 'title', format('%s order due by %s', s.vendor_name, to_char(s.order_by at time zone l.timezone, 'FMDay FMHH12:MI AM')),
                                     'message', format('Delivery %s. Nothing is marked as ordered yet. Review the suggested order, place it on the %s website, then mark it as ordered.',
                                                       to_char(s.delivery_date, 'FMDay, Mon FMDD'), s.vendor_name),
                                     'severity', 'warning', 'link', '/ordering'));
        v_n := v_n + (v_id is not null)::int;
      end loop;
    exception when others then
      raise warning 'email schedule failed for location %: %', l.id, sqlerrm;
    end;
  end loop;
  return jsonb_build_object('queued', v_n);
end $$;

-- Owners can generate a report now (preview / resend). Same data, new dedupe key.
create or replace function public.generate_report_now(p_location uuid, p_kind text, p_date date default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_org uuid := app.location_org(p_location); v_local date; v_data jsonb; v_subject text; v_from date;
begin
  perform app.require_org_permission('settings.manage', v_org);
  v_local := (now() at time zone (select timezone from public.locations where id = p_location))::date;
  if p_kind = 'daily_report' then
    v_from := coalesce(p_date, v_local - 1);
    v_data := app.daily_report_data(p_location, v_from);
    v_subject := format('Daily Restaurant Operations — %s', to_char(v_from, 'FMMonth FMDD'));
  elsif p_kind = 'weekly_report' then
    v_from := coalesce(p_date, v_local - (extract(isodow from v_local)::int - 1) - 7);   -- last Monday-start week
    v_data := app.period_report_data(p_location, v_from, v_from + 6, 'weekly');
    v_subject := format('Weekly Restaurant Inventory Report — %s–%s', to_char(v_from, 'Mon FMDD'), to_char(v_from + 6, 'Mon FMDD'));
  elsif p_kind = 'monthly_report' then
    v_from := date_trunc('month', coalesce(p_date, (date_trunc('month', v_local) - interval '1 day')::date))::date;
    v_data := app.monthly_report_data(p_location, v_from);
    v_subject := format('Monthly Owner Report — %s', to_char(v_from, 'FMMonth YYYY'));
  else
    raise exception 'Only daily, weekly and monthly reports can be generated on demand';
  end if;
  perform app.audit(v_org, p_location, 'generate', 'email', p_kind, 'Generated ' || v_subject, null, null);
  return app.queue_email(v_org, p_location, p_kind, format('manual:%s:%s:%s', p_kind, p_location, gen_random_uuid()), v_subject || ' (manual)', v_data);
end $$;

-- ---------------------------------------------------------------------
-- Sender protocol (service role only)
-- ---------------------------------------------------------------------
create or replace function public.claim_email_batch(p_limit integer default 20)
returns setof public.email_outbox
language plpgsql security definer set search_path = public as $$
begin
  if not app.is_trusted_caller() then raise exception 'Server job only' using errcode = '42501'; end if;
  -- a crashed sender leaves rows "sending": retry them after 10 minutes
  return query
  update public.email_outbox o set status = 'sending', attempts = o.attempts + 1, claimed_at = now()
  where o.id in (select id from public.email_outbox
                 where (status = 'pending' or (status = 'sending' and claimed_at < now() - interval '10 minutes'))
                   and attempts < 5
                 order by created_at limit p_limit for update skip locked)
  returning o.*;
end $$;

-- p_permanent: the provider rejected it for good (bad address, unverified sender) -> failed now, no retries.
create or replace function public.complete_email(p_id uuid, p_ok boolean, p_error text default null, p_provider_id text default null,
                                                 p_permanent boolean default false) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not app.is_trusted_caller() then raise exception 'Server job only' using errcode = '42501'; end if;
  update public.email_outbox set
    status = case when p_ok then 'sent' when p_permanent or attempts >= 5 then 'failed' else 'pending' end,
    sent_at = case when p_ok then now() end, last_error = p_error, provider_id = coalesce(p_provider_id, provider_id)
  where id = p_id and status = 'sending';
end $$;

-- Owners can retry a failed email.
create or replace function public.retry_email(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v public.email_outbox;
begin
  select * into v from public.email_outbox where id = p_id;
  if v.id is null then raise exception 'Email not found'; end if;
  perform app.require_org_permission('settings.manage', v.organization_id);
  if v.status not in ('failed', 'skipped') then raise exception 'Only failed or skipped emails can be retried'; end if;
  update public.email_outbox set status = 'pending', attempts = 0, last_error = null,
    recipients = case when cardinality(recipients) = 0 then
      coalesce((select array_agg(distinct r.email) from public.email_recipients r join public.email_subscriptions s on s.recipient_id = r.id and s.kind = v.kind
                where r.organization_id = v.organization_id and r.active and (r.location_id is null or r.location_id = v.location_id)), '{}')
      else recipients end
  where id = p_id;
  perform app.audit(v.organization_id, v.location_id, 'retry', 'email', p_id::text, 'Retry: ' || v.subject, null, null);
end $$;

insert into app.private_functions values ('public.claim_email_batch(integer)'), ('public.complete_email(uuid,boolean,text,text,boolean)'), ('public.run_email_schedule()')
on conflict do nothing;

select app.apply_grants();
grant execute on function public.claim_email_batch(integer), public.complete_email(uuid, boolean, text, text, boolean), public.run_email_schedule() to service_role;
