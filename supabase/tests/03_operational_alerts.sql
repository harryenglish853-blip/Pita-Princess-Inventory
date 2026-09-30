-- Operational alerts against the seeded demo restaurant: raised when the
-- condition holds, resolved automatically when it clears.
begin;
do $$
declare v_gm uuid; v_loc uuid; v_po uuid;
begin
  select id into v_gm from auth.users where email = 'gm@example.com';
  select id into v_loc from public.locations where code = '101';
  if v_gm is null or v_loc is null then raise notice 'SKIPPED: demo seed not loaded'; return; end if;

  select id into v_po from public.purchase_orders where location_id = v_loc and status in ('submitted', 'confirmed') order by created_at desc limit 1;
  perform tests.assert(v_po is not null, 'seed has an open order');

  -- Order is now overdue
  update public.purchase_orders set expected_delivery_date = current_date - 2 where id = v_po;
  perform tests.login(v_gm);
  perform public.refresh_operational_alerts(v_loc);
  perform tests.assert(exists (select 1 from public.alerts where location_id = v_loc and alert_type = 'late_delivery' and dedupe_key = 'late:' || v_po and status <> 'resolved'), 'late delivery alert raised');
  perform public.refresh_operational_alerts(v_loc);
  perform tests.assert((select count(*) from public.alerts where location_id = v_loc and dedupe_key = 'late:' || v_po and status <> 'resolved') = 1, 'refresh is idempotent (no duplicate alert)');
  perform tests.logout();

  -- Delivery moves back to the future: alert resolves
  update public.purchase_orders set expected_delivery_date = current_date + 3 where id = v_po;
  perform tests.login(v_gm);
  perform public.refresh_operational_alerts(v_loc);
  perform tests.assert(not exists (select 1 from public.alerts where location_id = v_loc and dedupe_key = 'late:' || v_po and status <> 'resolved'), 'late delivery alert resolves when cleared');

  -- (cleanup)
  perform tests.logout();
  perform tests.assert(true, 'done');
  raise notice 'ALL OPERATIONAL ALERT TESTS PASSED';
end $$;
rollback;
