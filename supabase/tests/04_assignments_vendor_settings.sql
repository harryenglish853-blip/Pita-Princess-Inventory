-- Count assignments and per-store vendor settings, against the seeded demo restaurant.
begin;
do $$
declare
  v_gm uuid; v_maria uuid; v_john uuid; v_loc uuid; v_other uuid; v_s uuid; v_cooler uuid; v_dry uuid; v_sysco uuid;
  v_sheet jsonb; v_n int; v_row public.location_vendor_settings;
begin
  select id into v_gm from auth.users where email = 'gm@example.com';
  select id into v_maria from auth.users where email = 'maria@example.com';
  select id into v_john from auth.users where email = 'john@example.com';
  select id into v_loc from public.locations where code = '101';
  select id into v_other from public.locations where code = '105';
  if v_gm is null or v_loc is null then raise notice 'SKIPPED: demo seed not loaded'; return; end if;
  select id into v_cooler from public.storage_locations where location_id = v_loc and name = 'Walk-In Cooler';
  select id into v_dry from public.storage_locations where location_id = v_loc and name = 'Dry Storage A';
  select id into v_sysco from public.vendors where name = 'Sysco';

  -- ---------------------------------------------------------------- assignments
  perform tests.login(v_gm);
  v_s := public.create_count_session(v_loc, 'weekly', 'Assignment test', null, null, null, null, null);
  perform tests.assert(exists (select 1 from public.count_assignable_users(v_s) u where u.user_id = v_maria), 'employees are assignable counters');

  v_n := public.set_count_assignments(v_s, jsonb_build_array(
    jsonb_build_object('user_id', v_maria, 'storage_location_ids', jsonb_build_array(v_cooler)),
    jsonb_build_object('user_id', v_john, 'storage_location_ids', jsonb_build_array(v_dry, null))));
  perform tests.assert(v_n = 3, 'three area assignments saved');
  perform tests.assert(exists (select 1 from public.audit_logs where entity_id = v_s::text and action = 'assign'), 'assignment is audited');

  -- Saving again replaces, never duplicates
  v_n := public.set_count_assignments(v_s, jsonb_build_array(jsonb_build_object('user_id', v_maria, 'storage_location_ids', jsonb_build_array(v_cooler, v_dry))));
  perform tests.assert((select count(*) from public.count_assignments where session_id = v_s) = 2, 'saving replaces the previous assignments');

  -- Foreign storage area is rejected
  begin
    perform public.set_count_assignments(v_s, jsonb_build_array(jsonb_build_object('user_id', v_maria,
      'storage_location_ids', jsonb_build_array((select id from public.storage_locations where location_id = v_other limit 1)))));
    perform tests.assert(false, 'other store area rejected');
  exception when raise_exception then perform tests.assert(true, 'another store''s storage area is rejected');
  end;

  -- Direct writes are blocked (only the RPC writes assignments)
  begin
    insert into public.count_assignments (session_id, user_id, storage_location_id) values (v_s, v_john, v_cooler);
    perform tests.assert(false, 'direct insert blocked');
  exception when insufficient_privilege then perform tests.assert(true, 'direct assignment writes are blocked');
  end;
  perform tests.logout();

  -- The counter sees their areas on the (offline-cacheable) sheet, but cannot assign
  perform tests.login(v_maria);
  v_sheet := public.get_count_sheet(v_s);
  perform tests.assert((v_sheet->>'me')::uuid = v_maria, 'sheet identifies the counter');
  perform tests.assert(jsonb_array_length(v_sheet->'assignments') = 2 and v_sheet ? 'lines', 'sheet carries assignments and lines');
  begin
    perform public.set_count_assignments(v_s, '[]'::jsonb);
    perform tests.assert(false, 'employee cannot assign');
  exception when insufficient_privilege then perform tests.assert(true, 'employees cannot change assignments');
  end;
  perform tests.logout();

  -- ---------------------------------------------------------------- store vendor settings
  perform tests.login(v_gm);
  insert into public.location_vendors (organization_id, location_id, vendor_id, lead_time_days, delivery_days, account_number)
  values (app.location_org(v_loc), v_loc, v_sysco, 3, '{2}', 'STORE-101');
  select * into v_row from public.location_vendor_settings where location_id = v_loc and vendor_id = v_sysco;
  perform tests.assert(v_row.lead_time_days = 3 and v_row.delivery_days = '{2}' and v_row.account_number = 'STORE-101' and v_row.has_override, 'store override wins over company settings');
  perform tests.assert(v_row.order_cutoff is not distinct from (select order_cutoff from public.vendors where id = v_sysco), 'blank override falls back to company value');
  perform tests.assert(extract(dow from app.next_vendor_delivery(v_loc, v_sysco, current_date)) = 2, 'next delivery uses the store''s delivery days');
  perform tests.assert(exists (select 1 from public.audit_logs where entity_type = 'location_vendors' and action = 'insert'), 'store vendor change is audited');

  update public.location_vendors set active = false where location_id = v_loc and vendor_id = v_sysco;
  perform tests.assert(not (select active from public.location_vendor_settings where location_id = v_loc and vendor_id = v_sysco), 'store can stop using a vendor');
  perform tests.logout();

  -- Employees cannot change store vendor settings (RLS filters the update to nothing)
  perform tests.login(v_maria);
  update public.location_vendors set lead_time_days = 9 where location_id = v_loc and vendor_id = v_sysco;
  perform tests.logout();
  perform tests.assert((select lead_time_days from public.location_vendors where location_id = v_loc and vendor_id = v_sysco) = 3, 'employees cannot change store vendor settings');

  raise notice 'ALL ASSIGNMENT AND VENDOR SETTINGS TESTS PASSED';
end $$;
rollback;
