-- =====================================================================
-- Food cost reconciles to the cent: each component is rounded first and
-- actual cost = begin + purchases + transfers - end of the ROUNDED values
-- (previously the unrounded total could differ from the printed parts by $0.01).
-- Same logic otherwise; access now also allows the server's report job.
-- =====================================================================

create or replace function public.food_cost_summary(p_location uuid, p_from timestamptz, p_to timestamptz, p_cost_groups text[] default array['food'])
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v jsonb;
begin
  perform app.require_location_access(p_location);
  with prods as (
    select p.id from public.products p left join public.categories c on c.id = p.category_id
    where p.organization_id = app.location_org(p_location) and coalesce(c.cost_group, 'food') = any(p_cost_groups)
  ),
  t as (
    select t.* from public.inventory_transactions t join prods on prods.id = t.product_id
    where t.location_id = p_location
  ),
  agg_raw as (
    select
      coalesce(sum(extended_cost) filter (where txn_at <= p_from), 0) as begin_value,
      coalesce(sum(extended_cost) filter (where txn_at <= p_to), 0) as end_value,
      coalesce(sum(extended_cost) filter (where txn_at > p_from and txn_at <= p_to and txn_type in ('RECEIPT', 'RETURN_TO_VENDOR')), 0) as purchases,
      coalesce(sum(extended_cost) filter (where txn_at > p_from and txn_at <= p_to and txn_type in ('TRANSFER_IN', 'TRANSFER_OUT')), 0) as transfers,
      coalesce(-sum(extended_cost) filter (where txn_at > p_from and txn_at <= p_to and txn_type = 'POS_CONSUMPTION'), 0) as pos_usage,
      coalesce(-sum(extended_cost) filter (where txn_at > p_from and txn_at <= p_to and txn_type = 'WASTE'), 0) as waste,
      coalesce(-sum(extended_cost) filter (where txn_at > p_from and txn_at <= p_to and txn_type = 'PHYSICAL_VARIANCE'), 0) as count_variance,
      coalesce(-sum(extended_cost) filter (where txn_at > p_from and txn_at <= p_to and txn_type in ('MANUAL_ADJUSTMENT', 'CORRECTION')), 0) as adjustments,
      coalesce(-sum(extended_cost) filter (where txn_at > p_from and txn_at <= p_to and txn_type in ('RECIPE_CONSUMPTION', 'PRODUCTION')), 0) as production_net
    from t
  ),
  -- Round each component to cents first, then derive actual cost from the
  -- rounded figures so the printed report always adds up exactly.
  agg as (
    select round(begin_value, 2) as begin_value, round(end_value, 2) as end_value, round(purchases, 2) as purchases,
           round(transfers, 2) as transfers, round(pos_usage, 2) as pos_usage, round(waste, 2) as waste,
           round(count_variance, 2) as count_variance, round(adjustments, 2) as adjustments, round(production_net, 2) as production_net
    from agg_raw
  ),
  sales as (
    select coalesce(sum(s.net_sales), 0) as net_sales, coalesce(sum(s.guest_count), 0) as guests, coalesce(sum(s.check_count), 0) as checks,
           count(*) as days
    from public.sales_imports s
    where s.location_id = p_location and s.status = 'posted'
      and (s.business_date::timestamp + time '12:00') at time zone (select timezone from public.locations where id = p_location) > p_from
      and (s.business_date::timestamp + time '12:00') at time zone (select timezone from public.locations where id = p_location) <= p_to
  ),
  theo as (  -- menu items sold x CURRENT recipe cost (limited to the requested cost groups)
    select coalesce(sum(sl.quantity * mi.portion_qty * (
             select coalesce(sum(c.base_qty * app.current_unit_cost(p_location, c.product_id)), 0)
             from app.recipe_components(mi.recipe_id, 1, false) c join prods on prods.id = c.product_id)), 0) as theoretical
    from public.sales_imports s
    join public.sales_lines sl on sl.import_id = s.id
    join public.menu_items mi on mi.id = sl.menu_item_id and mi.recipe_id is not null
    where s.location_id = p_location and s.status = 'posted'
      and (s.business_date::timestamp + time '12:00') at time zone (select timezone from public.locations where id = p_location) > p_from
      and (s.business_date::timestamp + time '12:00') at time zone (select timezone from public.locations where id = p_location) <= p_to
  )
  select jsonb_build_object(
    'from', p_from, 'to', p_to, 'cost_groups', p_cost_groups,
    'net_sales', s.net_sales, 'guests', s.guests, 'checks', s.checks, 'sales_days', s.days,
    'begin_inventory', round(a.begin_value, 2), 'purchases', round(a.purchases, 2), 'transfers', round(a.transfers, 2),
    'end_inventory', round(a.end_value, 2),
    'actual_cost', round(a.begin_value + a.purchases + a.transfers - a.end_value, 2),
    'theoretical_cost', round(th.theoretical, 2),
    'pos_usage_at_post', round(a.pos_usage, 2),
    'waste', round(a.waste, 2), 'count_variance', round(a.count_variance, 2), 'adjustments', round(a.adjustments, 2),
    'production_net', round(a.production_net, 2),
    'variance', round(a.begin_value + a.purchases + a.transfers - a.end_value - round(th.theoretical, 2), 2),
    'actual_pct', case when s.net_sales > 0 then round((a.begin_value + a.purchases + a.transfers - a.end_value) / s.net_sales * 100, 2) end,
    'theoretical_pct', case when s.net_sales > 0 then round(round(th.theoretical, 2) / s.net_sales * 100, 2) end,
    'waste_pct', case when s.net_sales > 0 then round(a.waste / s.net_sales * 100, 2) end
  ) into v
  from agg a, sales s, theo th;
  return v || jsonb_build_object('variance_pct_points',
    case when (v ->> 'actual_pct') is not null then round((v ->> 'actual_pct')::numeric - (v ->> 'theoretical_pct')::numeric, 2) end);
end $$;


select app.apply_grants();
