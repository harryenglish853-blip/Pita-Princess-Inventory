-- =====================================================================
-- DASHBOARD KPIs, MULTI-LOCATION SCORECARD, REPORTS, FORECASTING (Phase 7)
-- =====================================================================

-- ---------------------------------------------------------------------
-- Forecasting. Initial model: same-weekday average of the last N weeks,
-- scaled by the recent trend (last 2 weeks vs the prior 2). Stored so the
-- forecast used for a decision is reproducible; the table has room for
-- weather / holiday / event adjustments later.
-- ---------------------------------------------------------------------
create table public.sales_forecasts (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  location_id     uuid not null references public.locations(id) on delete cascade,
  business_date   date not null,
  net_sales       numeric(14,2) not null,
  guest_count     integer not null,
  method          text not null,
  factors         jsonb not null default '{}'::jsonb,   -- {weekday_avg, trend, weather, holiday, event, manual}
  manual_adjustment_pct numeric(6,2) not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (location_id, business_date)
);
create table public.demand_forecasts (
  location_id     uuid not null references public.locations(id) on delete cascade,
  product_id      uuid not null references public.products(id) on delete cascade,
  business_date   date not null,
  quantity        numeric(18,4) not null,
  method          text not null,
  created_at      timestamptz not null default now(),
  primary key (location_id, product_id, business_date)
);
insert into app.write_protected_tables values ('demand_forecasts');
alter table public.sales_forecasts enable row level security;
alter table public.demand_forecasts enable row level security;
create policy sf_select on public.sales_forecasts for select to authenticated using (location_id in (select app.user_location_ids()));
create policy sf_write on public.sales_forecasts for update to authenticated
  using (app.has_permission('forecast.edit', location_id)) with check (app.has_permission('forecast.edit', location_id));
create policy df_select on public.demand_forecasts for select to authenticated using (location_id in (select app.user_location_ids()));

create or replace function public.forecast_sales(p_location uuid, p_date date, p_weeks integer default 4) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_avg numeric; v_guests numeric; v_n int; v_recent numeric; v_prior numeric; v_trend numeric := 1; v_manual numeric;
begin
  if not (p_location in (select app.user_location_ids())) then raise exception 'Location not found' using errcode = '42501'; end if;
  select avg(net_sales), avg(guest_count), count(*) into v_avg, v_guests, v_n
  from public.sales_imports where location_id = p_location and status = 'posted'
    and extract(dow from business_date) = extract(dow from p_date) and business_date < p_date and business_date >= p_date - p_weeks * 7;
  select sum(net_sales) filter (where business_date >= p_date - 14), sum(net_sales) filter (where business_date < p_date - 14 and business_date >= p_date - 28)
    into v_recent, v_prior
  from public.sales_imports where location_id = p_location and status = 'posted' and business_date < p_date and business_date >= p_date - 28;
  if coalesce(v_prior, 0) > 0 and v_recent is not null then v_trend := greatest(0.8, least(1.2, v_recent / v_prior)); end if;
  select manual_adjustment_pct into v_manual from public.sales_forecasts where location_id = p_location and business_date = p_date;
  return jsonb_build_object('date', p_date, 'net_sales', round(coalesce(v_avg, 0) * v_trend * (1 + coalesce(v_manual, 0) / 100), 2),
    'guest_count', round(coalesce(v_guests, 0) * v_trend * (1 + coalesce(v_manual, 0) / 100)), 'weeks_used', v_n,
    'weekday_avg', round(coalesce(v_avg, 0), 2), 'trend', round(v_trend, 3), 'manual_adjustment_pct', coalesce(v_manual, 0),
    'method', format('Average of the last %s %ss × recent trend', v_n, trim(to_char(p_date, 'Day'))));
end $$;

-- Product demand by weekday: each weekday's average usage over the last 4 weeks
-- (POS + recipe consumption + waste + count variance), scaled by the sales forecast
-- ratio for that day. Replaces the flat 28-day average used by suggested orders.
create or replace function app.forecast_usage(p_location uuid, p_product uuid, p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_total numeric := 0; d date; v_day numeric; v_dow_avg numeric; v_flat numeric; v_ratio numeric; v_hist numeric; v_fc numeric;
  v_has_sales boolean;
begin
  v_flat := app.avg_daily_usage(p_location, p_product, 28);
  if p_to <= p_from then return jsonb_build_object('qty', 0, 'daily', round(v_flat, 4), 'method', 'no days'); end if;
  v_has_sales := exists (select 1 from public.sales_imports where location_id = p_location and status = 'posted' and business_date >= current_date - 28);
  d := p_from;
  while d < p_to loop
    select greatest(0, -coalesce(sum(t.quantity), 0)) / 4 into v_dow_avg
    from public.inventory_transactions t
    where t.location_id = p_location and t.product_id = p_product
      and t.txn_type in ('POS_CONSUMPTION', 'RECIPE_CONSUMPTION', 'WASTE', 'PHYSICAL_VARIANCE', 'MANUAL_ADJUSTMENT')
      and t.business_date >= current_date - 28 and t.business_date < current_date
      and extract(dow from t.business_date) = extract(dow from d);
    v_day := coalesce(v_dow_avg, v_flat);
    -- counted variance lands on count days only; blend with the flat average so it is spread across the week
    v_day := 0.6 * v_day + 0.4 * v_flat;
    if v_has_sales then
      select avg(net_sales) into v_hist from public.sales_imports where location_id = p_location and status = 'posted'
        and extract(dow from business_date) = extract(dow from d) and business_date >= current_date - 28;
      v_fc := (public.forecast_sales(p_location, d) ->> 'net_sales')::numeric;
      v_ratio := case when coalesce(v_hist, 0) > 0 then greatest(0.5, least(1.5, v_fc / v_hist)) else 1 end;
      v_day := v_day * v_ratio;
    end if;
    v_total := v_total + v_day;
    d := d + 1;
  end loop;
  return jsonb_build_object('qty', round(v_total, 4), 'daily', round(v_total / (p_to - p_from), 4),
    'method', case when v_has_sales then 'Day-of-week usage (last 4 weeks) × sales forecast' else '28-day average daily usage' end);
end $$;

-- Dynamic par = forecast usage over lead time + coverage + safety days.
create or replace function public.refresh_dynamic_pars(p_location uuid) returns integer
language plpgsql security definer set search_path = public as $$
declare r record; v_days int; v_par numeric; n int := 0;
begin
  perform app.require_permission('inventory.view', p_location);
  for r in
    select lp.id, lp.product_id, lp.safety_stock_days,
           coalesce(v.lead_time_days, 1) as lead, coalesce(array_length(coalesce(lv.delivery_days, v.delivery_days), 1), 1) as deliveries
    from public.location_products lp
    join public.products p on p.id = lp.product_id
    left join public.vendors v on v.id = coalesce(lp.local_vendor_id, p.default_vendor_id)
    left join public.location_vendors lv on lv.vendor_id = v.id and lv.location_id = p_location
    where lp.location_id = p_location and lp.par_mode = 'dynamic' and lp.active
  loop
    v_days := r.lead + ceil(7.0 / greatest(r.deliveries, 1))::int;
    v_par := (app.forecast_usage(p_location, r.product_id, current_date, current_date + v_days) ->> 'qty')::numeric
             + coalesce(r.safety_stock_days, 0) * app.avg_daily_usage(p_location, r.product_id, 28);
    update public.location_products set dynamic_par_qty = round(v_par, 2), dynamic_par_at = now() where id = r.id;
    n := n + 1;
  end loop;
  return n;
end $$;

-- ---------------------------------------------------------------------
-- Dashboard (one round trip)
-- ---------------------------------------------------------------------
create or replace function public.dashboard_kpis(p_location uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_tz text; v_today date; v_week_start date; v jsonb; v_last public.count_sessions; v_prev public.count_sessions; v_fc jsonb := null;
  v_28 jsonb; v_inv_value numeric;
begin
  if not (p_location in (select app.user_location_ids())) then raise exception 'Location not found' using errcode = '42501'; end if;
  perform public.refresh_stock_alerts(p_location);
  select timezone into v_tz from public.locations where id = p_location;
  v_today := (now() at time zone v_tz)::date;
  v_week_start := v_today - ((extract(isodow from v_today)::int) - 1);
  select * into v_last from public.count_sessions where location_id = p_location and status = 'posted' order by count_at desc limit 1;
  select * into v_prev from public.count_sessions where location_id = p_location and status = 'posted' and count_at < v_last.count_at order by count_at desc limit 1;
  if v_prev.id is not null then v_fc := public.food_cost_summary(p_location, v_prev.count_at, v_last.count_at); end if;
  v_28 := public.food_cost_summary(p_location, now() - interval '28 days', now(), array['food', 'beverage', 'alcohol', 'paper', 'supplies', 'other']);
  select coalesce(sum(extended_value), 0) into v_inv_value from public.current_inventory where location_id = p_location and active;

  select jsonb_build_object(
    'today', v_today,
    'inventory_value', v_inv_value,
    'stock', (select jsonb_build_object('low', count(*) filter (where stock_status = 'low'), 'critical', count(*) filter (where stock_status = 'critical'),
                                        'out', count(*) filter (where stock_status = 'out'), 'negative', count(*) filter (where stock_status = 'negative'))
              from public.current_inventory where location_id = p_location and active),
    'food_cost', v_fc,
    'food_cost_period', case when v_prev.id is not null then jsonb_build_object('from', v_prev.count_at, 'to', v_last.count_at, 'from_id', v_prev.id, 'to_id', v_last.id) end,
    'turns_28d', case when ((v_28 ->> 'begin_inventory')::numeric + (v_28 ->> 'end_inventory')::numeric) > 0
                      then round((v_28 ->> 'actual_cost')::numeric / (((v_28 ->> 'begin_inventory')::numeric + (v_28 ->> 'end_inventory')::numeric) / 2), 2) end,
    'waste_today', (select coalesce(sum(total_cost), 0) from public.waste_logs where location_id = p_location and business_date = v_today),
    'waste_week', (select coalesce(sum(total_cost), 0) from public.waste_logs where location_id = p_location and business_date >= v_week_start),
    'waste_7d', (select coalesce(sum(total_cost), 0) from public.waste_logs where location_id = p_location and business_date > v_today - 7),
    'sales_7d', (select coalesce(sum(net_sales), 0) from public.sales_imports where location_id = p_location and status = 'posted' and business_date > v_today - 7),
    'sales_today', (select net_sales from public.sales_imports where location_id = p_location and status = 'posted' and business_date = v_today),
    'sales_yesterday', (select jsonb_build_object('net_sales', net_sales, 'guests', guest_count, 'checks', check_count, 'theoretical_cost', theoretical_cost)
                        from public.sales_imports where location_id = p_location and status = 'posted' and business_date = v_today - 1),
    'forecast_today', public.forecast_sales(p_location, v_today),
    'forecast_week', (select jsonb_agg(public.forecast_sales(p_location, d::date) order by d) from generate_series(v_today, v_today + 6, interval '1 day') d),
    'open_pos', (select count(*) from public.purchase_orders where location_id = p_location and status in ('draft', 'ready_to_submit')),
    'pending_deliveries', (select count(*) from public.purchase_orders where location_id = p_location and status in ('submitted', 'confirmed', 'back_ordered')),
    'late_deliveries', (select count(*) from public.purchase_orders where location_id = p_location and status in ('submitted', 'confirmed') and expected_delivery_date < v_today),
    'to_reconcile', (select count(*) from public.receipts where location_id = p_location and status in ('draft', 'received')),
    'last_count', case when v_last.id is not null then jsonb_build_object('id', v_last.id, 'name', v_last.name, 'count_at', v_last.count_at,
        'variance_value', (select coalesce(sum(variance_value), 0) from public.count_posting_lines where session_id = v_last.id),
        'loss_value', (select coalesce(sum(least(variance_value, 0)), 0) from public.count_posting_lines where session_id = v_last.id)) end,
    'top_waste', (select coalesce(jsonb_agg(x order by x.cost desc), '[]'::jsonb) from (
        select coalesce(p.name, r.name) as name, sum(w.total_cost) as cost from public.waste_logs w
        left join public.products p on p.id = w.product_id left join public.recipes r on r.id = w.recipe_id
        where w.location_id = p_location and w.business_date > v_today - 7 group by 1 order by 2 desc limit 5) x),
    'largest_variances', case when v_last.id is not null then (select coalesce(jsonb_agg(x order by x.value), '[]'::jsonb) from (
        select p.id, p.name, pl.variance_qty as qty, u.code as unit, pl.variance_value as value from public.count_posting_lines pl
        join public.products p on p.id = pl.product_id join public.units u on u.id = p.inventory_unit_id
        where pl.session_id = v_last.id and pl.variance_value < 0 order by pl.variance_value limit 5) x) end,
    'price_increases', (select coalesce(jsonb_agg(x order by x.created_at desc), '[]'::jsonb) from (
        select a.title, a.message, a.product_id, a.created_at from public.alerts a
        where a.location_id = p_location and a.alert_type = 'price_increase' and a.status <> 'resolved' order by a.created_at desc limit 5) x),
    'tasks', (select jsonb_build_object(
        'due_today', count(*) filter (where status = 'open' and (due_at at time zone v_tz)::date = v_today),
        'overdue', count(*) filter (where status = 'open' and due_at < now() and (due_at at time zone v_tz)::date < v_today),
        'upcoming', count(*) filter (where status = 'open' and (due_at at time zone v_tz)::date > v_today))
        from public.tasks where location_id = p_location),
    'alerts', (select coalesce(jsonb_agg(x order by case x.severity when 'critical' then 0 when 'warning' then 1 else 2 end, x.created_at desc), '[]'::jsonb) from (
        select id, alert_type, severity, title, message, product_id, entity_type, entity_id, created_at from public.alerts
        where location_id = p_location and status = 'open' order by created_at desc limit 12) x),
    'open_counts', (select count(*) from public.count_sessions where location_id = p_location and status in ('not_started', 'in_progress', 'awaiting_review', 'reviewed'))
  ) into v;
  return v;
end $$;

-- Multi-location scorecard for the trailing N days (actual from ledger begin/end, theoretical from POS).
create or replace function public.location_scorecard(p_org uuid, p_days integer default 28)
returns table (location_id uuid, code text, name text, region text, district text, market text,
               net_sales numeric, actual_cost numeric, theoretical_cost numeric, actual_pct numeric, theoretical_pct numeric,
               variance_pts numeric, waste numeric, waste_pct numeric, count_variance numeric, inventory_value numeric, open_alerts bigint)
language plpgsql stable security definer set search_path = public as $$
declare l record; s jsonb;
begin
  for l in select loc.*, r.name as region_name, d.name as district_name from public.locations loc
           left join public.regions r on r.id = loc.region_id left join public.districts d on d.id = loc.district_id
           where loc.organization_id = p_org and loc.active and loc.id in (select app.user_location_ids()) order by loc.code
  loop
    s := public.food_cost_summary(l.id, now() - make_interval(days => p_days), now(), array['food']);
    location_id := l.id; code := l.code; name := l.name; region := l.region_name; district := l.district_name; market := l.market;
    net_sales := (s ->> 'net_sales')::numeric; actual_cost := (s ->> 'actual_cost')::numeric; theoretical_cost := (s ->> 'theoretical_cost')::numeric;
    actual_pct := (s ->> 'actual_pct')::numeric; theoretical_pct := (s ->> 'theoretical_pct')::numeric; variance_pts := (s ->> 'variance_pct_points')::numeric;
    waste := (s ->> 'waste')::numeric; waste_pct := (s ->> 'waste_pct')::numeric; count_variance := (s ->> 'count_variance')::numeric;
    select coalesce(sum(extended_value), 0) into inventory_value from public.current_inventory ci where ci.location_id = l.id and ci.active;
    select count(*) into open_alerts from public.alerts a where a.location_id = l.id and a.status = 'open';
    return next;
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- Reports
-- ---------------------------------------------------------------------
-- Usage, turns, days on hand and aging per product.
create or replace function public.report_inventory_efficiency(p_location uuid, p_days integer default 28)
returns table (product_id uuid, product_name text, category_name text, inventory_unit text, on_hand numeric, value numeric,
               usage_qty numeric, usage_value numeric, avg_daily_usage numeric, days_on_hand numeric, turns_annualized numeric,
               last_receipt_at timestamptz, days_since_receipt integer, last_counted_at timestamptz, shelf_life_days integer, aging_flag text)
language sql stable security definer set search_path = public as $$
  select ci.product_id, ci.product_name, ci.category_name, ci.inventory_unit, ci.on_hand, ci.extended_value,
         u.qty, u.val, round(u.qty / p_days, 4),
         case when u.qty > 0 then round(greatest(ci.on_hand, 0) / (u.qty / p_days), 1) end,
         case when ci.extended_value > 0 then round(u.val / ci.extended_value * (365.0 / p_days), 1) end,
         r.last_at, (now()::date - r.last_at::date), ci.last_counted_at, p.shelf_life_days,
         case when p.shelf_life_days is not null and r.last_at is not null and now()::date - r.last_at::date > p.shelf_life_days and ci.on_hand > 0 then 'past shelf life'
              when u.qty = 0 and ci.on_hand > 0 then 'no movement'
              when u.qty > 0 and greatest(ci.on_hand, 0) / (u.qty / p_days) > 30 then 'overstocked' else 'ok' end
  from public.current_inventory ci
  join public.products p on p.id = ci.product_id
  left join lateral (
    select coalesce(-sum(t.quantity), 0) as qty, coalesce(-sum(t.extended_cost), 0) as val from public.inventory_transactions t
    where t.location_id = p_location and t.product_id = ci.product_id and t.txn_at > now() - make_interval(days => p_days)
      and t.txn_type in ('POS_CONSUMPTION', 'RECIPE_CONSUMPTION', 'WASTE', 'PHYSICAL_VARIANCE', 'MANUAL_ADJUSTMENT')) u on true
  left join lateral (select max(t.txn_at) as last_at from public.inventory_transactions t where t.location_id = p_location and t.product_id = ci.product_id and t.txn_type = 'RECEIPT') r on true
  where ci.location_id = p_location and ci.active and p_location in (select app.user_location_ids())
$$;

-- Every received invoice line in a period (purchases by vendor/product/category, price variance).
create or replace function public.report_purchases(p_location uuid, p_from date, p_to date)
returns table (receipt_id uuid, receipt_number text, invoice_number text, delivery_date date, vendor_name text, product_id uuid, product_name text,
               category_name text, unit_code text, ordered_qty numeric, received_qty numeric, invoiced_qty numeric, contract_price numeric,
               invoice_price numeric, price_variance numeric, extended numeric, exceptions text)
language sql stable security definer set search_path = public as $$
  select r.id, r.receipt_number, r.invoice_number, r.delivery_date, v.name, p.id, p.name, c.name, u.code,
         ri.ordered_qty, ri.received_qty, ri.invoiced_qty, ri.contract_price, ri.invoice_price,
         case when ri.contract_price is not null and ri.invoice_price is not null then round((ri.invoice_price - ri.contract_price) * coalesce(ri.invoiced_qty, 0), 2) end,
         coalesce(ri.invoice_extended, round(coalesce(ri.invoiced_qty, 0) * coalesce(ri.invoice_price, 0), 2)),
         array_to_string(ri.exception_codes, ', ')
  from public.receipts r
  join public.vendors v on v.id = r.vendor_id
  join public.receipt_items ri on ri.receipt_id = r.id
  join public.products p on p.id = ri.product_id
  join public.units u on u.id = ri.unit_id
  left join public.categories c on c.id = p.category_id
  where r.location_id = p_location and r.status = 'posted' and r.delivery_date between p_from and p_to
    and p_location in (select app.user_location_ids())
$$;

-- Vendor delivery & invoice accuracy.
create or replace function public.report_vendor_performance(p_location uuid, p_from date, p_to date)
returns table (vendor_name text, receipts bigint, lines bigint, short_lines bigint, over_lines bigint, back_orders bigint, substitutions bigint,
               price_variance_lines bigint, rejected_lines bigint, temp_failures bigint, fill_rate_pct numeric, late_deliveries bigint,
               invoice_over_short numeric, purchases numeric)
language sql stable security definer set search_path = public as $$
  select v.name, count(distinct r.id), count(ri.id),
         count(*) filter (where 'short' = any(ri.exception_codes) or 'missing' = any(ri.exception_codes)),
         count(*) filter (where 'over' = any(ri.exception_codes)),
         count(*) filter (where 'back_order' = any(ri.exception_codes)),
         count(*) filter (where 'substitution' = any(ri.exception_codes)),
         count(*) filter (where 'price_variance' = any(ri.exception_codes)),
         count(*) filter (where 'rejected' = any(ri.exception_codes)),
         count(*) filter (where 'temp_out_of_range' = any(ri.exception_codes)),
         round(100.0 * sum(least(coalesce(ri.received_qty, 0), ri.ordered_qty)) filter (where ri.ordered_qty > 0) / nullif(sum(ri.ordered_qty) filter (where ri.ordered_qty > 0), 0), 1),
         count(distinct r.id) filter (where po.expected_delivery_date < r.delivery_date),
         (select coalesce(sum(r2.invoice_total), 0) - coalesce(sum((public.receipt_totals(r2.id) ->> 'calculated_total')::numeric), 0)
            from public.receipts r2 where r2.vendor_id = v.id and r2.location_id = p_location and r2.status = 'posted' and r2.delivery_date between p_from and p_to),
         sum(coalesce(ri.invoice_extended, coalesce(ri.invoiced_qty, 0) * coalesce(ri.invoice_price, 0)))
  from public.receipts r
  join public.vendors v on v.id = r.vendor_id
  join public.receipt_items ri on ri.receipt_id = r.id
  left join public.purchase_orders po on po.id = r.purchase_order_id
  where r.location_id = p_location and r.status = 'posted' and r.delivery_date between p_from and p_to
    and p_location in (select app.user_location_ids())
  group by v.id, v.name
$$;

-- System suggestion vs manager order (ordering behaviour analysis).
create or replace function public.report_order_accuracy(p_location uuid, p_from date, p_to date)
returns table (po_id uuid, po_number text, vendor_name text, delivery_date date, product_name text, unit_code text,
               suggested_qty numeric, ordered_qty numeric, difference numeric, difference_value numeric)
language sql stable security definer set search_path = public as $$
  select po.id, po.po_number, v.name, po.expected_delivery_date, p.name, u.code, i.suggested_qty, i.order_qty,
         i.order_qty - i.suggested_qty, round((i.order_qty - i.suggested_qty) * i.unit_price, 2)
  from public.purchase_orders po
  join public.vendors v on v.id = po.vendor_id
  join public.purchase_order_items i on i.po_id = po.id
  join public.products p on p.id = i.product_id
  join public.units u on u.id = i.unit_id
  where po.location_id = p_location and po.status not in ('draft', 'ready_to_submit', 'cancelled') and i.suggested_qty is not null
    and po.expected_delivery_date between p_from and p_to and p_location in (select app.user_location_ids())
$$;

select app.apply_grants();
