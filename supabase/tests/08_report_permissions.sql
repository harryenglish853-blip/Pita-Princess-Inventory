-- Financial information is enforced by the database, not just hidden in the UI.
begin;
do $$
declare
  v_owner uuid; v_gm uuid; v_maria uuid; v_loc uuid; v_org uuid; v jsonb; v_n integer; v_recipe uuid;
begin
  select id into v_owner from auth.users where email = 'owner@example.com';
  select id into v_gm from auth.users where email = 'gm@example.com';
  select id into v_maria from auth.users where email = 'maria@example.com';
  select id, organization_id into v_loc, v_org from public.locations where code = '101';
  if v_owner is null or v_loc is null then raise notice 'SKIPPED: demo seed not loaded'; return; end if;
  select id into v_recipe from public.recipes where organization_id = v_org limit 1;

  perform tests.login(v_maria);
  -- the raw report functions are not callable through the API at all
  begin
    perform public.food_cost_summary(v_loc, now() - interval '7 days', now());
    perform tests.assert(false, 'raw food cost callable');
  exception when insufficient_privilege then perform tests.assert(true, 'raw food_cost_summary is not callable by API users');
  end;
  begin
    perform public.dashboard_kpis(v_loc);
    perform tests.assert(false, 'raw dashboard callable');
  exception when insufficient_privilege then perform tests.assert(true, 'raw dashboard_kpis is not callable by API users');
  end;
  begin
    perform public.get_food_cost(v_loc, now() - interval '7 days', now());
    perform tests.assert(false, 'employee food cost');
  exception when insufficient_privilege then perform tests.assert(true, 'employee cannot read food cost');
  end;
  begin
    perform * from public.get_report_vendor_performance(v_loc, current_date - 30, current_date);
    perform tests.assert(false, 'employee vendor spend');
  exception when insufficient_privilege then perform tests.assert(true, 'employee cannot read vendor spending');
  end;
  begin
    perform * from public.get_report_purchases(v_loc, current_date - 30, current_date);
    perform tests.assert(false, 'employee purchases');
  exception when insufficient_privilege then perform tests.assert(true, 'employee cannot read purchases report');
  end;
  begin
    perform * from public.get_report_inventory_efficiency(v_loc, 28);
    perform tests.assert(false, 'employee efficiency');
  exception when insufficient_privilege then perform tests.assert(true, 'employee cannot read operational reports');
  end;
  select count(*) into v_n from public.get_location_scorecard(v_org, 28);
  perform tests.assert(v_n = 0, 'employee gets no scorecard rows');
  v := public.get_dashboard(v_loc);
  perform tests.assert(not (v ? 'inventory_value') and not (v ? 'food_cost') and not (v ? 'sales_yesterday') and (v ->> 'cost_hidden')::boolean,
                       'employee dashboard has no dollars');
  perform tests.assert(v ? 'stock' and v ? 'tasks', 'employee dashboard keeps operational counts');
  select count(*) into v_n from public.sales_imports;
  perform tests.assert(v_n = 0, 'employee cannot read sales');
  if v_recipe is not null then
    perform tests.assert(public.get_recipe_unit_cost(v_recipe, v_loc) is null, 'recipe cost hidden from employee');
    perform tests.assert(not exists (select 1 from public.get_recipe_cost_breakdown(v_recipe, v_loc) where cost is not null), 'ingredient costs hidden from employee');
  end if;
  perform tests.logout();

  perform tests.login(v_gm);
  v := public.get_dashboard(v_loc);
  perform tests.assert(v ? 'inventory_value' and not (v ? 'cost_hidden'), 'manager dashboard has dollars');
  v := public.get_food_cost(v_loc, now() - interval '28 days', now());
  perform tests.assert(v ? 'actual_cost', 'manager reads food cost');
  perform * from public.get_report_vendor_performance(v_loc, current_date - 30, current_date);
  select count(*) into v_n from public.sales_imports;
  perform tests.assert(v_n > 0, 'manager reads sales');
  if v_recipe is not null then
    perform tests.assert(public.get_recipe_unit_cost(v_recipe, v_loc) is not null, 'manager sees recipe cost');
  end if;
  perform tests.logout();

  perform tests.login(v_owner);
  select count(*) into v_n from public.get_location_scorecard(v_org, 28);
  perform tests.assert(v_n >= 2, 'owner scorecard covers every store');
  perform tests.logout();

  raise notice 'ALL REPORT PERMISSION TESTS PASSED';
end $$;
rollback;
