-- =====================================================================
-- FINANCIAL DATA IS PERMISSION-CHECKED IN THE DATABASE
--
-- Report functions used to check only that the caller belonged to the
-- location, so any employee could call them through the API and read sales,
-- food cost and vendor spending. They are now private (callable only from
-- other database functions, which run as their owner) and the app calls
-- gated get_* wrappers:
--   reports.view_cost  sales, food cost, purchases, vendor spending, recipe cost
--   reports.view       operational reports without dollars
-- =====================================================================

-- Functions listed here never get EXECUTE for API roles (apply_grants honours it).
create table if not exists app.private_functions (signature text primary key);

create or replace function app.apply_grants() returns void
language plpgsql as $$
declare t text;
begin
  execute 'grant select, insert, update, delete on all tables in schema public to authenticated, service_role';
  execute 'grant usage, select on all sequences in schema public to authenticated, service_role';
  execute 'grant execute on all functions in schema public to authenticated, service_role';
  execute 'revoke execute on all functions in schema public from anon, public';
  execute 'grant execute on all functions in schema app to authenticated, service_role';
  for t in select table_name from app.write_protected_tables loop
    execute format('revoke insert, update, delete on public.%I from authenticated', t);
  end loop;
  for t in select signature from app.private_functions loop
    if to_regprocedure(t) is not null then
      execute format('revoke execute on function %s from authenticated, anon, public', t);
    end if;
  end loop;
end $$;

insert into app.private_functions values
  ('public.dashboard_kpis(uuid)'),
  ('public.food_cost_summary(uuid,timestamptz,timestamptz,text[])'),
  ('public.avt_by_product(uuid,timestamptz,timestamptz)'),
  ('public.location_scorecard(uuid,integer)'),
  ('public.report_inventory_efficiency(uuid,integer)'),
  ('public.report_purchases(uuid,date,date)'),
  ('public.report_vendor_performance(uuid,date,date)'),
  ('public.report_order_accuracy(uuid,date,date)'),
  ('public.recipe_costs(uuid)'),
  ('public.recipe_cost_breakdown(uuid,uuid)'),
  ('public.recipe_unit_cost(uuid,uuid)'),
  ('public.forecast_sales(uuid,date,integer)')
on conflict do nothing;

create or replace function app.require_report_access(p_perm text, p_location uuid) returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if app.is_system_caller() then return; end if;
  perform app.require_permission(p_perm, p_location);
end $$;

-- ---------------------------------------------------------------------
-- Dashboard: everyone with location access gets operational counts;
-- dollars only with reports.view_cost.
-- ---------------------------------------------------------------------
create or replace function public.get_dashboard(p_location uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v jsonb;
begin
  if not (p_location in (select app.user_location_ids())) then raise exception 'Location not found' using errcode = '42501'; end if;
  v := public.dashboard_kpis(p_location);
  if app.has_permission('reports.view_cost', p_location) then return v; end if;
  v := v - array['inventory_value', 'food_cost', 'food_cost_period', 'turns_28d', 'waste_today', 'waste_week', 'waste_7d',
                 'sales_7d', 'sales_today', 'sales_yesterday', 'forecast_today', 'forecast_week', 'top_waste', 'price_increases'];
  -- variance quantities stay, dollars go
  if v ? 'last_count' and v -> 'last_count' <> 'null'::jsonb then
    v := jsonb_set(v, '{last_count}', (v -> 'last_count') - array['variance_value', 'loss_value']);
  end if;
  if v ? 'largest_variances' and jsonb_typeof(v -> 'largest_variances') = 'array' then
    v := jsonb_set(v, '{largest_variances}', coalesce((select jsonb_agg(x - 'value') from jsonb_array_elements(v -> 'largest_variances') x), '[]'::jsonb));
  end if;
  return v || jsonb_build_object('cost_hidden', true);
end $$;

create or replace function public.get_food_cost(p_location uuid, p_from timestamptz, p_to timestamptz, p_cost_groups text[] default array['food'])
returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform app.require_report_access('reports.view_cost', p_location);
  return public.food_cost_summary(p_location, p_from, p_to, p_cost_groups);
end $$;

create or replace function public.get_avt_by_product(p_location uuid, p_from timestamptz, p_to timestamptz)
returns table (product_id uuid, product_name text, category_name text, cost_group text, inventory_unit text, begin_qty numeric, received_qty numeric,
               transfer_qty numeric, produced_qty numeric, theoretical_qty numeric, waste_qty numeric, adjusted_qty numeric, expected_end_qty numeric,
               physical_end_qty numeric, variance_qty numeric, unit_cost numeric, variance_value numeric, theoretical_value numeric, counted boolean)
language plpgsql stable security definer set search_path = public as $$
begin
  perform app.require_report_access('reports.view_cost', p_location);
  return query select * from public.avt_by_product(p_location, p_from, p_to);
end $$;

create or replace function public.get_location_scorecard(p_org uuid, p_days integer default 28)
returns table (location_id uuid, code text, name text, region text, district text, market text,
               net_sales numeric, actual_cost numeric, theoretical_cost numeric, actual_pct numeric, theoretical_pct numeric,
               variance_pts numeric, waste numeric, waste_pct numeric, count_variance numeric, inventory_value numeric, open_alerts bigint)
language sql stable security definer set search_path = public as $$
  select s.* from public.location_scorecard(p_org, p_days) s
  where app.has_permission('reports.view_cost', s.location_id) and app.has_permission('reports.view_corporate', s.location_id)
$$;

create or replace function public.get_report_inventory_efficiency(p_location uuid, p_days integer default 28)
returns table (product_id uuid, product_name text, category_name text, inventory_unit text, on_hand numeric, value numeric,
               usage_qty numeric, usage_value numeric, avg_daily_usage numeric, days_on_hand numeric, turns_annualized numeric,
               last_receipt_at timestamptz, days_since_receipt integer, last_counted_at timestamptz, shelf_life_days integer, aging_flag text)
language plpgsql stable security definer set search_path = public as $$
declare v_cost boolean;
begin
  perform app.require_report_access('reports.view', p_location);
  v_cost := app.is_system_caller() or app.has_permission('reports.view_cost', p_location);
  return query select r.product_id, r.product_name, r.category_name, r.inventory_unit, r.on_hand,
                      case when v_cost then r.value end, r.usage_qty, case when v_cost then r.usage_value end,
                      r.avg_daily_usage, r.days_on_hand, r.turns_annualized, r.last_receipt_at, r.days_since_receipt,
                      r.last_counted_at, r.shelf_life_days, r.aging_flag
               from public.report_inventory_efficiency(p_location, p_days) r;
end $$;

create or replace function public.get_report_purchases(p_location uuid, p_from date, p_to date)
returns table (receipt_id uuid, receipt_number text, invoice_number text, delivery_date date, vendor_name text, product_id uuid, product_name text,
               category_name text, unit_code text, ordered_qty numeric, received_qty numeric, invoiced_qty numeric, contract_price numeric,
               invoice_price numeric, price_variance numeric, extended numeric, exceptions text)
language plpgsql stable security definer set search_path = public as $$
begin
  perform app.require_report_access('reports.view_cost', p_location);
  return query select * from public.report_purchases(p_location, p_from, p_to);
end $$;

create or replace function public.get_report_vendor_performance(p_location uuid, p_from date, p_to date)
returns table (vendor_name text, receipts bigint, lines bigint, short_lines bigint, over_lines bigint, back_orders bigint, substitutions bigint,
               price_variance_lines bigint, rejected_lines bigint, temp_failures bigint, fill_rate_pct numeric, late_deliveries bigint,
               invoice_over_short numeric, purchases numeric)
language plpgsql stable security definer set search_path = public as $$
begin
  perform app.require_report_access('reports.view_cost', p_location);
  return query select * from public.report_vendor_performance(p_location, p_from, p_to);
end $$;

create or replace function public.get_report_order_accuracy(p_location uuid, p_from date, p_to date)
returns table (po_id uuid, po_number text, vendor_name text, delivery_date date, product_name text, unit_code text,
               suggested_qty numeric, ordered_qty numeric, difference numeric, difference_value numeric)
language plpgsql stable security definer set search_path = public as $$
declare v_cost boolean;
begin
  perform app.require_report_access('reports.view', p_location);
  v_cost := app.is_system_caller() or app.has_permission('reports.view_cost', p_location);
  return query select r.po_id, r.po_number, r.vendor_name, r.delivery_date, r.product_name, r.unit_code, r.suggested_qty, r.ordered_qty,
                      r.difference, case when v_cost then r.difference_value end
               from public.report_order_accuracy(p_location, p_from, p_to) r;
end $$;

-- Recipe cost is "detailed food cost": hidden (null) without reports.view_cost,
-- but the recipe itself stays readable for cooks.
create or replace function public.get_recipe_costs(p_location uuid)
returns table (recipe_id uuid, unit_cost numeric)
language plpgsql stable security definer set search_path = public as $$
begin
  if not (p_location in (select app.user_location_ids())) then raise exception 'Location not found' using errcode = '42501'; end if;
  if not app.has_permission('reports.view_cost', p_location) then return; end if;
  return query select * from public.recipe_costs(p_location);
end $$;

create or replace function public.get_recipe_unit_cost(p_recipe uuid, p_location uuid) returns numeric
language plpgsql stable security definer set search_path = public as $$
begin
  if not (p_location in (select app.user_location_ids())) then raise exception 'Location not found' using errcode = '42501'; end if;
  if not app.has_permission('reports.view_cost', p_location) then return null; end if;
  return public.recipe_unit_cost(p_recipe, p_location);
end $$;

create or replace function public.get_recipe_cost_breakdown(p_recipe uuid, p_location uuid)
returns table (ingredient_id uuid, kind text, name text, quantity numeric, unit_code text, yield_pct numeric, cost numeric)
language plpgsql stable security definer set search_path = public as $$
declare v_cost boolean;
begin
  if not (p_location in (select app.user_location_ids())) then raise exception 'Location not found' using errcode = '42501'; end if;
  v_cost := app.has_permission('reports.view_cost', p_location);
  return query select b.ingredient_id, b.kind, b.name, b.quantity, b.unit_code, b.yield_pct, case when v_cost then b.cost end
               from public.recipe_cost_breakdown(p_recipe, p_location) b;
end $$;

-- ---------------------------------------------------------------------
-- Sales are management information.
-- ---------------------------------------------------------------------
drop policy if exists sales_select on public.sales_imports;
create policy sales_select on public.sales_imports for select to authenticated
  using (location_id in (select app.user_location_ids())
         and (app.has_permission('sales.import', location_id) or app.has_permission('reports.view_cost', location_id)));

select app.apply_grants();
