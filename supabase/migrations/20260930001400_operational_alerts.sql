-- =====================================================================
-- Operational alerts beyond stock levels. Each alert has a stable dedupe
-- key, so refreshing is idempotent and alerts resolve themselves when the
-- condition clears.
-- =====================================================================
create or replace function public.refresh_operational_alerts(p_location uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_tz text; v_today date; v_keep text[]; r record; v_last public.count_sessions; v_loc public.locations;
begin
  if not (p_location in (select app.user_location_ids())) then raise exception 'Location not found' using errcode = '42501'; end if;
  select * into v_loc from public.locations where id = p_location;
  v_tz := v_loc.timezone;
  v_today := (now() at time zone v_tz)::date;

  -- Late deliveries: submitted/confirmed orders past their expected date
  select array_agg('late:' || id) into v_keep from public.purchase_orders
   where location_id = p_location and status in ('submitted', 'confirmed') and expected_delivery_date < v_today;
  for r in select po.*, v.name as vendor from public.purchase_orders po join public.vendors v on v.id = po.vendor_id
           where po.location_id = p_location and po.status in ('submitted', 'confirmed') and po.expected_delivery_date < v_today loop
    perform app.raise_alert(p_location, 'late_delivery', 'warning', format('Late delivery: %s %s', r.vendor, r.po_number),
      format('Expected %s and not received yet.', to_char(r.expected_delivery_date, 'Mon DD')), 'late:' || r.id, null, 'purchase_order', r.id);
  end loop;
  perform app.resolve_alerts(p_location, 'late:', v_keep);

  -- Orders not submitted: drafts whose delivery is tomorrow or earlier
  select array_agg('unsubmitted:' || id) into v_keep from public.purchase_orders
   where location_id = p_location and status in ('draft', 'ready_to_submit') and expected_delivery_date <= v_today + 1;
  for r in select po.*, v.name as vendor from public.purchase_orders po join public.vendors v on v.id = po.vendor_id
           where po.location_id = p_location and po.status in ('draft', 'ready_to_submit') and po.expected_delivery_date <= v_today + 1 loop
    perform app.raise_alert(p_location, 'order_not_submitted', 'critical', format('Order not submitted: %s %s', r.vendor, r.po_number),
      format('Delivery is %s but the order is still %s.', to_char(r.expected_delivery_date, 'Mon DD'), replace(r.status::text, '_', ' ')), 'unsubmitted:' || r.id, null, 'purchase_order', r.id);
  end loop;
  perform app.resolve_alerts(p_location, 'unsubmitted:', v_keep);

  -- Expiring lots still likely on hand (received in the last 60 days, expiring within 2 days)
  select array_agg(distinct 'expiring:' || l.id) into v_keep
  from public.lots l join public.lot_receipts lr on lr.lot_id = l.id
  where lr.location_id = p_location and l.expiration_date between v_today - 1 and v_today + 2 and lr.received_at > now() - interval '60 days';
  for r in select distinct l.id, l.lot_number, l.expiration_date, l.product_id, p.name
           from public.lots l join public.lot_receipts lr on lr.lot_id = l.id join public.products p on p.id = l.product_id
           where lr.location_id = p_location and l.expiration_date between v_today - 1 and v_today + 2 and lr.received_at > now() - interval '60 days' loop
    perform app.raise_alert(p_location, 'expiring_product', 'warning', format('Expiring: %s lot %s', r.name, r.lot_number),
      format('Expires %s. Use first or log it as waste.', to_char(r.expiration_date, 'Mon DD')), 'expiring:' || r.id, r.product_id, 'lot', r.id);
  end loop;
  perform app.resolve_alerts(p_location, 'expiring:', v_keep);

  -- High waste: last 7 days above 2% of sales (or above $150 without sales data)
  declare v_waste numeric; v_sales numeric;
  begin
    select coalesce(sum(total_cost), 0) into v_waste from public.waste_logs where location_id = p_location and business_date > v_today - 7;
    select coalesce(sum(net_sales), 0) into v_sales from public.sales_imports where location_id = p_location and status = 'posted' and business_date > v_today - 7;
    if (v_sales > 0 and v_waste / v_sales > 0.02) or (v_sales = 0 and v_waste > 150) then
      perform app.raise_alert(p_location, 'high_waste', 'warning', 'High waste this week',
        format('$%s of waste in 7 days%s.', round(v_waste, 2), case when v_sales > 0 then format(' (%s%% of sales)', round(v_waste / v_sales * 100, 1)) else '' end), 'high_waste');
    else
      perform app.resolve_alerts(p_location, 'high_waste', null);
    end if;
  end;

  -- High variance: lines over tolerance on the most recent posted count (last 7 days)
  select * into v_last from public.count_sessions where location_id = p_location and status = 'posted' and count_at > now() - interval '7 days' order by count_at desc limit 1;
  v_keep := null;
  if v_last.id is not null then
    select array_agg('variance:' || v_last.id || ':' || pl.product_id) into v_keep
    from public.count_posting_lines pl where pl.session_id = v_last.id and pl.variance_value < -v_loc.count_variance_value_tolerance;
    for r in select pl.*, p.name, u.code from public.count_posting_lines pl join public.products p on p.id = pl.product_id join public.units u on u.id = p.inventory_unit_id
             where pl.session_id = v_last.id and pl.variance_value < -v_loc.count_variance_value_tolerance loop
      perform app.raise_alert(p_location, 'high_variance', 'warning', format('High inventory variance: %s', r.name),
        format('%s %s (%s) on %s.', round(r.variance_qty, 2), r.code, to_char(r.variance_value, 'FM$999,990.00'), v_last.name),
        'variance:' || v_last.id || ':' || r.product_id, r.product_id, 'count_session', v_last.id);
    end loop;
  end if;
  perform app.resolve_alerts(p_location, 'variance:', v_keep);

  -- Unexpected consumption: yesterday's theoretical usage of an item is > 3x its daily average
  select array_agg('unexpected:' || x.product_id) into v_keep from (
    select t.product_id from public.inventory_transactions t
    where t.location_id = p_location and t.business_date = v_today - 1 and t.txn_type in ('POS_CONSUMPTION', 'RECIPE_CONSUMPTION')
    group by t.product_id
    having -sum(t.quantity) > 3 * greatest(app.avg_daily_usage(p_location, t.product_id, 28), 0.0001) and app.avg_daily_usage(p_location, t.product_id, 28) > 0) x;
  for r in select t.product_id, p.name, -sum(t.quantity) as used, u.code from public.inventory_transactions t join public.products p on p.id = t.product_id join public.units u on u.id = p.inventory_unit_id
           where t.location_id = p_location and t.business_date = v_today - 1 and t.txn_type in ('POS_CONSUMPTION', 'RECIPE_CONSUMPTION')
           group by t.product_id, p.name, u.code
           having -sum(t.quantity) > 3 * greatest(app.avg_daily_usage(p_location, t.product_id, 28), 0.0001) and app.avg_daily_usage(p_location, t.product_id, 28) > 0 loop
    perform app.raise_alert(p_location, 'unexpected_consumption', 'info', format('Unusual usage: %s', r.name),
      format('%s %s used yesterday, more than 3× the daily average. Check the POS mapping or recipe.', round(r.used, 2), r.code), 'unexpected:' || r.product_id, r.product_id);
  end loop;
  perform app.resolve_alerts(p_location, 'unexpected:', v_keep);
end $$;

-- Dashboard refreshes operational alerts along with stock alerts.
create or replace function public.refresh_stock_alerts_all(p_location uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform public.refresh_stock_alerts(p_location);
  perform public.refresh_operational_alerts(p_location);
end $$;

select app.apply_grants();
