-- Commissary orders: status workflow, permissions, ledger moves, discrepancies, email.
begin;
do $$
declare
  v_owner uuid; v_gm uuid; v_maria uuid; v_cmu uuid; v_org uuid; v_loc uuid; v_comm uuid; v_vendor uuid;
  v_dough uuid; v_meat uuid; ea uuid; pan uuid; v_order uuid; v_order2 uuid; v_key uuid := gen_random_uuid();
  v_c_before numeric; v_r_before numeric; v_res jsonb; v_lines jsonb; v_onorder numeric; v_n int;
begin
  select id into v_owner from auth.users where email = 'owner@example.com';
  select id into v_gm from auth.users where email = 'gm@example.com';
  select id into v_maria from auth.users where email = 'maria@example.com';
  select id into v_cmu from auth.users where email = 'commissary@example.com';
  select id, organization_id into v_loc, v_org from public.locations where code = '101';
  select id into v_comm from public.locations where code = 'C1';
  if v_cmu is null or v_comm is null then raise notice 'SKIPPED: demo seed not loaded'; return; end if;
  select id into v_vendor from public.vendors where organization_id = v_org and kind = 'commissary';
  select id into v_dough from public.products where organization_id = v_org and product_number = '8001';
  select id into v_meat from public.products where organization_id = v_org and product_number = '8003';
  select id into ea from public.units where code = 'EA' and organization_id is null;
  select id into pan from public.units where code = 'PAN' and organization_id is null;
  v_lines := jsonb_build_array(jsonb_build_object('product_id', v_dough, 'unit_id', pan, 'qty', 2),        -- 2 PAN = 24 EA
                               jsonb_build_object('product_id', v_meat, 'unit_id', ea, 'qty', 100));

  -- ---------------------------------------------------------------- permissions
  perform tests.login(v_maria);
  begin
    perform public.save_commissary_order(null, v_loc, v_vendor, current_date + 1, null, v_lines);
    perform tests.assert(false, 'employee created order');
  exception when insufficient_privilege then perform tests.assert(true, 'an employee cannot create commissary orders');
  end;
  perform tests.logout();
  perform tests.login(v_cmu);
  begin
    perform public.save_commissary_order(null, v_loc, v_vendor, current_date + 1, null, v_lines);
    perform tests.assert(false, 'commissary user ordered for #101');
  exception when insufficient_privilege then perform tests.assert(true, 'commissary staff cannot order on behalf of a restaurant');
  end;
  perform tests.logout();

  -- ---------------------------------------------------------------- create, duplicate submit, edit lock
  perform tests.login(v_gm);
  begin
    perform public.save_commissary_order(null, v_loc, v_vendor, current_date - 1, null, v_lines);
    perform tests.assert(false, 'past date');
  exception when raise_exception then perform tests.assert(true, 'needed date cannot be in the past');
  end;
  v_order := public.save_commissary_order(null, v_loc, v_vendor, current_date + 1, 'Test', v_lines, v_key);
  perform tests.assert(public.save_commissary_order(null, v_loc, v_vendor, current_date + 1, 'Test', v_lines, v_key) = v_order,
                       'a repeated submit of the same form does not create a second order');
  perform tests.assert((select count(*) from public.commissary_order_items where order_id = v_order) = 2, 'two lines saved');
  perform tests.assert((select unit_factor from public.commissary_order_items where order_id = v_order and product_id = v_dough) = 12, '1 PAN = 12 EA dough');
  begin
    perform public.ship_commissary_order(v_order);
    perform tests.assert(false, 'GM shipped');
  exception when insufficient_privilege then perform tests.assert(true, 'the restaurant cannot ship its own order');
  end;
  v_onorder := app.on_order_qty(v_loc, v_meat);
  perform public.submit_commissary_order(v_order);
  perform tests.assert(app.on_order_qty(v_loc, v_meat) = v_onorder + 100, 'submitted commissary order counts as incoming (100 meatballs)');
  begin
    perform public.submit_commissary_order(v_order);
    perform tests.assert(false, 'double submit');
  exception when sqlstate 'P0003' then perform tests.assert(true, 'an order cannot be submitted twice');
  end;
  begin
    perform public.save_commissary_order(v_order, v_loc, v_vendor, current_date + 1, null, v_lines);
    perform tests.assert(false, 'edit after submit');
  exception when sqlstate 'P0003' then perform tests.assert(true, 'a submitted order can no longer be edited');
  end;
  perform tests.logout();
  perform tests.assert(exists (select 1 from public.email_outbox where dedupe_key = 'commissary_order:' || v_order || ':submitted'
                               and 'commissary@example.com' = any(recipients) and status = 'pending'),
                       'submitting emails the commissary recipients');
  perform tests.assert(exists (select 1 from public.tasks where entity_id = v_order and location_id = v_comm and status = 'open'),
                       'the commissary gets a task to prepare it');

  -- ---------------------------------------------------------------- commissary workflow
  perform tests.login(v_cmu);
  perform public.set_commissary_status(v_order, 'accepted');
  perform public.set_commissary_status(v_order, 'preparing');
  begin
    perform public.set_commissary_status(v_order, 'accepted');
    perform tests.assert(false, 'went backwards');
  exception when sqlstate 'P0003' then perform tests.assert(true, 'status only moves forward');
  end;
  perform public.set_commissary_status(v_order, 'ready');
  v_c_before := app.book_qty(v_comm, v_meat, now());
  -- short-ship dough: only 1 PAN ready
  v_res := public.ship_commissary_order(v_order, jsonb_build_array(jsonb_build_object('id',
             (select id from public.commissary_order_items where order_id = v_order and product_id = v_dough), 'qty_shipped', 1)));
  perform tests.assert(v_res ->> 'status' = 'in_transit', 'shipped: in transit');
  perform tests.assert(app.book_qty(v_comm, v_meat, now()) = v_c_before - 100, 'commissary meatballs down 100 when shipped');
  perform tests.assert((select qty_shipped from public.commissary_order_items where order_id = v_order and product_id = v_dough) = 1, 'dough shipped 1 PAN');
  perform tests.assert(app.on_order_qty(v_loc, v_dough) >= 12 and app.in_transit_qty(v_loc, v_meat) >= 100, 'in transit uses shipped quantities');
  begin
    perform public.ship_commissary_order(v_order);
    perform tests.assert(false, 'double ship');
  exception when sqlstate 'P0003' then perform tests.assert(true, 'an order cannot be shipped twice');
  end;
  perform tests.logout();

  -- ---------------------------------------------------------------- restaurant receives: 95 of 100 meatballs, 1 PAN dough
  perform tests.login(v_maria);
  v_r_before := app.book_qty(v_loc, v_meat, now());
  begin
    perform public.receive_commissary_order(v_order, jsonb_build_array(jsonb_build_object('id',
      (select id from public.commissary_order_items where order_id = v_order and product_id = v_meat), 'qty_received', 95)));
    perform tests.assert(false, 'partial lines');
  exception when raise_exception then perform tests.assert(true, 'every line needs a received quantity');
  end;
  v_res := public.receive_commissary_order(v_order, (select jsonb_agg(jsonb_build_object('id', i.id,
             'qty_received', case when i.product_id = v_meat then 95 else 1 end)) from public.commissary_order_items i where i.order_id = v_order));
  perform tests.assert(app.book_qty(v_loc, v_meat, now()) = v_r_before + 95, 'restaurant in: 95 meatballs');
  perform tests.assert(app.book_qty(v_comm, v_meat, now()) = v_c_before - 95, 'commissary out: 95 (5 not received go back on its books)');
  perform tests.assert(jsonb_array_length(v_res -> 'issues') = 2, 'two discrepancies: meatballs short 5, dough short 1 PAN vs ordered');
  perform tests.assert((select status from public.commissary_orders where id = v_order) = 'received', 'order received');
  begin
    perform public.receive_commissary_order(v_order, '[]'::jsonb);
    perform tests.assert(false, 'double receive');
  exception when sqlstate 'P0003' then perform tests.assert(true, 'an order cannot be received twice');
  end;
  perform tests.logout();
  perform tests.assert(exists (select 1 from public.alerts where dedupe_key = 'co_exc:' || v_order and alert_type = 'short_delivery'),
                       'discrepancy raises a delivery alert');
  perform tests.assert(exists (select 1 from public.email_outbox o join public.alerts a on o.dedupe_key = 'alert:' || a.id
                               where a.dedupe_key = 'co_exc:' || v_order and o.kind = 'delivery_discrepancy' and 'gm@example.com' = any(o.recipients)),
                       'management is emailed about the discrepancy');
  perform tests.assert((select count(*) from public.inventory_transactions where source_type = 'commissary_order' and source_id = v_order and employee_id is null and created_by = v_maria) > 0,
                       'ledger rows record who received');

  -- ---------------------------------------------------------------- cancel rules
  perform tests.login(v_gm);
  v_order2 := public.save_commissary_order(null, v_loc, v_vendor, current_date + 2, null, v_lines);
  perform public.submit_commissary_order(v_order2);
  begin
    perform public.set_commissary_status(v_order2, 'cancelled');
    perform tests.assert(false, 'cancel without reason');
  exception when raise_exception then perform tests.assert(true, 'cancelling a submitted order needs a reason');
  end;
  perform public.set_commissary_status(v_order2, 'cancelled', 'Changed plans');
  perform tests.assert((select status from public.commissary_orders where id = v_order2) = 'cancelled', 'restaurant cancels before it ships');
  perform tests.assert(not exists (select 1 from public.tasks where entity_id = v_order2 and status = 'open'), 'cancelled order closes the commissary task');
  perform tests.logout();

  -- ---------------------------------------------------------------- visibility
  perform tests.login(v_cmu);
  select count(*) into v_n from public.commissary_orders where id in (v_order, v_order2);
  perform tests.assert(v_n = 2, 'commissary staff see orders addressed to them');
  perform tests.assert((select unit_cost from public.commissary_order_lines(v_order) limit 1) is not null, 'kitchen manager sees cost');
  perform tests.logout();
  perform tests.login(v_maria);
  perform tests.assert((select bool_and(unit_cost is null) from public.commissary_order_lines(v_order)), 'employees do not see commissary costs');
  perform tests.logout();

  raise notice 'ALL COMMISSARY TESTS PASSED';
end $$;
rollback;
