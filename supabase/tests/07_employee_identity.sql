-- Shared employee login: "Who are you?" + PIN. Nothing can be changed from a
-- shared login until a person is identified, and every change records them.
begin;
do $$
declare
  v_owner uuid; v_gm uuid; v_maria uuid; v_shared uuid; v_org uuid; v_loc uuid;
  v_carlos uuid; v_alex uuid; v_res jsonb; v_token text; v_prod uuid; v_unit uuid; v_waste jsonb; v_ctx jsonb;
  v_n integer;
begin
  select id into v_owner from auth.users where email = 'owner@example.com';
  select id into v_gm from auth.users where email = 'gm@example.com';
  select id into v_maria from auth.users where email = 'maria@example.com';
  select id, organization_id into v_loc, v_org from public.locations where code = '101';
  if v_owner is null or v_loc is null then raise notice 'SKIPPED: demo seed not loaded'; return; end if;
  select p.id, p.inventory_unit_id into v_prod, v_unit from public.products p
   join public.location_products lp on lp.product_id = p.id and lp.location_id = v_loc
   where p.organization_id = v_org and p.active order by p.product_number limit 1;

  v_shared := tests.create_user('frontcounter@example.com', 'Front counter tablet');

  -- ---------------------------------------------------------------- setup by the owner
  perform tests.login(v_owner);
  perform public.assign_role(v_org, v_shared, 'employee', 'location', v_loc);
  perform public.set_shared_login(v_org, v_shared, true);
  perform tests.assert((select shared_login from public.organization_members where organization_id = v_org and user_id = v_shared), 'owner marks the login as shared');
  begin
    perform public.set_shared_login(v_org, v_gm, true);
    perform tests.assert(false, 'manager login cannot be shared');
  exception when raise_exception then perform tests.assert(true, 'manager logins cannot be made shared');
  end;
  begin
    perform public.assign_role(v_org, v_shared, 'general_manager', 'location', v_loc);
    perform tests.assert(false, 'shared login cannot get a manager role');
  exception when insufficient_privilege then perform tests.assert(true, 'a shared login cannot be given a manager role');
  end;
  begin
    perform public.save_employee(v_org, null, 'Weak', v_loc, '1111', true);
    perform tests.assert(false, 'weak PIN rejected');
  exception when invalid_parameter_value then perform tests.assert(true, 'repeated-digit PIN is rejected');
  end;
  begin
    perform public.save_employee(v_org, null, 'Short', v_loc, '12', true);
    perform tests.assert(false, 'short PIN rejected');
  exception when invalid_parameter_value then perform tests.assert(true, 'PIN must be 4 digits');
  end;
  v_carlos := public.save_employee(v_org, null, 'Carlos Test', v_loc, '4826', true);
  v_alex := public.save_employee(v_org, null, 'Alex Test', null, '3917', true);
  begin
    perform public.save_employee(v_org, null, 'carlos test', v_loc, '5928', true);
    perform tests.assert(false, 'duplicate name rejected');
  exception when unique_violation then perform tests.assert(true, 'two employees cannot share a name on the picker');
  end;
  perform tests.assert(exists (select 1 from public.audit_logs where entity_type = 'employee' and entity_id = v_carlos::text and action = 'create'), 'adding an employee is audited');
  perform tests.logout();

  -- ---------------------------------------------------------------- an ordinary employee cannot manage employees
  perform tests.login(v_maria);
  begin
    perform public.save_employee(v_org, null, 'Sneaky', v_loc, '8253', true);
    perform tests.assert(false, 'employee cannot add employees');
  exception when insufficient_privilege then perform tests.assert(true, 'an employee cannot add employees');
  end;
  perform tests.logout();

  -- ---------------------------------------------------------------- PIN hashes are unreachable
  perform tests.login(v_gm);
  begin
    perform 1 from app.employee_pins limit 1;
    perform tests.assert(false, 'pin table readable');
  exception when insufficient_privilege then perform tests.assert(true, 'PIN hashes cannot be read even by a manager');
  end;
  perform tests.logout();

  -- ---------------------------------------------------------------- the shared login
  perform tests.login(v_shared);
  select count(*) into v_n from public.employees;
  perform tests.assert(v_n = 0, 'shared login cannot read the employee table directly');
  perform tests.assert(exists (select 1 from public.list_pin_employees(v_loc) where id = v_carlos)
                   and exists (select 1 from public.list_pin_employees(v_loc) where id = v_alex), '"Who are you?" lists store and all-location employees');
  v_ctx := public.get_session_context();
  perform tests.assert((v_ctx -> 'organizations' -> 0 ->> 'shared_login')::boolean and v_ctx -> 'employee' = 'null'::jsonb, 'session context says shared and nobody identified');

  begin
    perform public.log_waste(v_loc, v_prod, 1, v_unit, 'DROPPED');
    perform tests.assert(false, 'unidentified waste blocked');
  exception when insufficient_privilege then perform tests.assert(true, 'shared login cannot log waste before identifying');
  end;

  v_res := public.start_employee_session(v_carlos, '0000');
  perform tests.assert(not (v_res ->> 'ok')::boolean and (v_res ->> 'attempts_left')::int = 4, 'wrong PIN refused with attempts left');
  perform tests.logout();
  perform tests.assert((select failed_attempts from public.employees where id = v_carlos) = 1, 'failed attempt counted');
  perform tests.assert(exists (select 1 from public.audit_logs where action = 'pin_failed' and employee_id = v_carlos), 'failed PIN is audited');
  perform tests.login(v_shared);

  v_res := public.start_employee_session(v_carlos, '4826');
  perform tests.assert((v_res ->> 'ok')::boolean and length(v_res ->> 'token') = 64, 'correct PIN starts a session');
  v_token := v_res ->> 'token';
  perform tests.logout();
  perform tests.assert(not exists (select 1 from public.employee_sessions where token_hash = v_token), 'raw token is never stored');
  perform tests.assert((select failed_attempts from public.employees where id = v_carlos) = 0, 'success resets the counter');
  perform tests.login(v_shared);

  perform set_config('request.headers', json_build_object('x-employee-session', v_token)::text, true);
  perform tests.assert(app.current_employee_id() = v_carlos, 'token identifies Carlos');
  v_ctx := public.get_session_context();
  perform tests.assert(v_ctx -> 'employee' ->> 'display_name' = 'Carlos Test', 'session context shows Carlos');
  v_waste := public.log_waste(v_loc, v_prod, 1, v_unit, 'DROPPED');
  perform set_config('request.headers', '', true);
  perform tests.logout();
  perform tests.assert((select employee_id from public.waste_logs where id = (v_waste ->> 'id')::uuid) = v_carlos, 'waste log records Carlos');
  perform tests.assert((select employee_id from public.inventory_transactions where source_type = 'waste' and source_id = (v_waste ->> 'id')::uuid) = v_carlos, 'ledger row records Carlos');
  perform tests.assert((select employee_id from public.audit_logs where action = 'waste' and new_value ->> 'waste_id' = v_waste ->> 'id') = v_carlos, 'audit entry records Carlos');
  perform tests.assert((select user_id from public.audit_logs where action = 'waste' and new_value ->> 'waste_id' = v_waste ->> 'id') = v_shared, 'audit entry also records the shared login');
  perform tests.login(v_shared);
  perform set_config('request.headers', json_build_object('x-employee-session', v_token)::text, true);

  -- switch employee
  perform public.end_employee_session();
  perform tests.assert(app.current_employee_id() is null, 'switching ends the session');
  begin
    perform public.log_waste(v_loc, v_prod, 1, v_unit, 'DROPPED');
    perform tests.assert(false, 'ended session blocked');
  exception when insufficient_privilege then perform tests.assert(true, 'an ended session cannot be reused');
  end;
  perform set_config('request.headers', '', true);
  perform tests.logout();

  -- ---------------------------------------------------------------- a token is useless to anyone else
  perform tests.login(v_shared);
  v_token := public.start_employee_session(v_alex, '3917') ->> 'token';
  perform tests.logout();
  perform tests.login(v_maria);
  perform set_config('request.headers', json_build_object('x-employee-session', v_token)::text, true);
  perform tests.assert(app.current_employee_id() is null, 'another login cannot use the token');
  perform set_config('request.headers', '', true);
  perform tests.logout();

  -- ---------------------------------------------------------------- lockout
  perform tests.login(v_shared);
  for i in 1..5 loop perform public.start_employee_session(v_carlos, '9999'); end loop;
  v_res := public.start_employee_session(v_carlos, '4826');
  perform tests.assert(not (v_res ->> 'ok')::boolean and (v_res ->> 'locked')::boolean, 'five wrong PINs lock the employee, even the right PIN is refused');
  perform tests.logout();
  perform tests.login(v_owner);
  perform public.unlock_employee(v_carlos);
  perform tests.logout();
  perform tests.login(v_shared);
  perform tests.assert((public.start_employee_session(v_carlos, '4826') ->> 'ok')::boolean, 'manager unlock lets them in');
  perform tests.logout();

  -- ---------------------------------------------------------------- deactivation and PIN change end sessions
  perform tests.login(v_shared);
  v_token := public.start_employee_session(v_alex, '3917') ->> 'token';
  perform tests.logout();
  perform tests.login(v_owner);
  perform public.save_employee(v_org, v_alex, 'Alex Test', null, '6284', true);
  perform tests.logout();
  perform tests.login(v_shared);
  perform set_config('request.headers', json_build_object('x-employee-session', v_token)::text, true);
  perform tests.assert(app.current_employee_id() is null, 'a PIN change ends sessions started with the old PIN');
  perform set_config('request.headers', '', true);
  perform tests.assert(not (public.start_employee_session(v_alex, '3917') ->> 'ok')::boolean, 'old PIN no longer works');
  perform tests.assert((public.start_employee_session(v_alex, '6284') ->> 'ok')::boolean, 'new PIN works');
  perform tests.logout();
  perform tests.login(v_owner);
  perform public.save_employee(v_org, v_alex, 'Alex Test', null, null, false);
  perform tests.logout();
  perform tests.login(v_shared);
  perform tests.assert(not exists (select 1 from public.list_pin_employees(v_loc) where id = v_alex), 'inactive employees are not listed');
  perform tests.assert(not (public.start_employee_session(v_alex, '6284') ->> 'ok')::boolean, 'inactive employee cannot sign in');
  perform tests.logout();

  -- ---------------------------------------------------------------- personal logins are unaffected
  perform tests.login(v_maria);
  perform public.log_waste(v_loc, v_prod, 1, v_unit, 'DROPPED');
  perform tests.assert(true, 'a personal login works without a PIN');
  perform tests.logout();

  raise notice 'ALL EMPLOYEE IDENTITY TESTS PASSED';
end $$;
rollback;
