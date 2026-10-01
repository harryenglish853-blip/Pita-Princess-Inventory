-- The spec's sample restaurant week, end to end in the database:
-- Monday order (manager 5 vs suggestion), Tuesday short delivery + back order,
-- Wednesday POS depletion, Thursday waste, Sunday count (book 31 / physical 26),
-- plus nested recipes, recipe waste, production, location transfer and AvT.
begin;

do $$
declare
  v_owner uuid := tests.create_user('w-owner@test.local', 'Week Owner');
  v_emp uuid := tests.create_user('w-emp@test.local', 'Week Employee');
  v_org uuid; v_loc uuid; v_loc2 uuid;
  lb uuid; oz uuid; cs uuid; ea uuid; pk uuid;
  v_cat uuid; v_vendor uuid;
  chicken uuid; beef uuid; bun uuid; mayo uuid; tomato uuid; onion uuid; salsa_p uuid; cheese uuid;
  vp_chicken uuid; walkin uuid;
  r_sauce uuid; r_sandwich uuid; r_burger uuid; r_salsa uuid; r_nachos uuid;
  mi_sandwich uuid; mi_burger uuid;
  v_po uuid; v_rcv uuid; v_item uuid; v_cnt uuid; v_res jsonb; v_n numeric; v_cost1 numeric; v_cost2 numeric;
  v_open_at timestamptz; v_sun_at timestamptz; v_tr uuid; r record;
begin
  perform tests.login(v_owner);
  v_org := public.create_organization('Week Co', 'Store 101', '101');
  select id into v_loc from public.locations where organization_id = v_org;
  insert into public.locations (organization_id, code, name) values (v_org, '105', 'Store 105') returning id into v_loc2;
  perform public.assign_role(v_org, v_emp, 'employee', 'location', v_loc);
  select id into lb from public.units where code = 'LB' and organization_id is null;
  select id into oz from public.units where code = 'OZ' and organization_id is null;
  select id into cs from public.units where code = 'CASE' and organization_id is null;
  select id into ea from public.units where code = 'EA' and organization_id is null;
  select id into pk from public.units where code = 'PK' and organization_id is null;
  insert into public.categories (organization_id, name, cost_group) values (v_org, 'Food', 'food') returning id into v_cat;
  insert into public.vendors (organization_id, name, delivery_days) values (v_org, 'US Foods', '{2}') returning id into v_vendor;

  insert into public.products (organization_id, product_number, name, category_id, inventory_unit_id, purchase_unit_id, default_vendor_id)
    values (v_org, '1', 'Chicken Breast', v_cat, lb, cs, v_vendor) returning id into chicken;
  insert into public.product_units (organization_id, product_id, unit_id, factor, use_for_purchase) values (v_org, chicken, cs, 40, true);
  insert into public.products (organization_id, product_number, name, category_id, inventory_unit_id, standard_cost) values (v_org, '2', 'Ground Beef', v_cat, lb, 4.00) returning id into beef;
  insert into public.products (organization_id, product_number, name, category_id, inventory_unit_id, standard_cost) values (v_org, '3', 'Bun', v_cat, ea, 0.30) returning id into bun;
  insert into public.products (organization_id, product_number, name, category_id, inventory_unit_id, standard_cost) values (v_org, '4', 'Mayonnaise', v_cat, lb, 2.00) returning id into mayo;
  insert into public.products (organization_id, product_number, name, category_id, inventory_unit_id, standard_cost) values (v_org, '5', 'Tomatoes', v_cat, lb, 1.50) returning id into tomato;
  insert into public.products (organization_id, product_number, name, category_id, inventory_unit_id, standard_cost) values (v_org, '6', 'Onions', v_cat, lb, 0.60) returning id into onion;
  insert into public.products (organization_id, product_number, name, category_id, inventory_unit_id, is_prepped) values (v_org, '7', 'Salsa (prepped)', v_cat, lb, true) returning id into salsa_p;
  insert into public.products (organization_id, product_number, name, category_id, inventory_unit_id, standard_cost) values (v_org, '8', 'Cheddar Slice', v_cat, ea, 0.15) returning id into cheese;
  insert into public.vendor_products (organization_id, vendor_id, product_id, vendor_item_number, purchase_unit_id, current_price, is_preferred)
    values (v_org, v_vendor, chicken, '48219', cs, 128, true) returning id into vp_chicken;
  insert into public.storage_locations (organization_id, location_id, name, sort_order) values (v_org, v_loc, 'Walk-In', 1) returning id into walkin;
  perform public.set_storage_sequence(walkin, (select jsonb_agg(jsonb_build_object('product_id', id)) from public.products where organization_id = v_org));

  -- Recipes: house sauce (sub-recipe) inside sandwich and burger; salsa is prepped inventory
  insert into public.recipes (organization_id, name, recipe_type, yield_qty, yield_unit_id) values (v_org, 'House Sauce', 'sub_recipe', 1, lb) returning id into r_sauce;
  insert into public.recipe_ingredients (organization_id, recipe_id, product_id, quantity, unit_id) values (v_org, r_sauce, mayo, 1, lb);
  insert into public.recipes (organization_id, name, yield_qty, yield_unit_id) values (v_org, 'Grilled Chicken Sandwich', 1, ea) returning id into r_sandwich;
  insert into public.recipe_ingredients (organization_id, recipe_id, product_id, quantity, unit_id) values (v_org, r_sandwich, chicken, 8, oz), (v_org, r_sandwich, bun, 1, ea);
  insert into public.recipe_ingredients (organization_id, recipe_id, sub_recipe_id, quantity, unit_id) values (v_org, r_sandwich, r_sauce, 1, oz);
  insert into public.recipes (organization_id, name, yield_qty, yield_unit_id) values (v_org, 'Cheeseburger', 1, ea) returning id into r_burger;
  insert into public.recipe_ingredients (organization_id, recipe_id, product_id, quantity, unit_id) values (v_org, r_burger, beef, 8, oz), (v_org, r_burger, bun, 1, ea), (v_org, r_burger, cheese, 2, ea);
  insert into public.recipe_ingredients (organization_id, recipe_id, sub_recipe_id, quantity, unit_id) values (v_org, r_burger, r_sauce, 1, oz);
  insert into public.recipes (organization_id, name, recipe_type, yield_qty, yield_unit_id, product_id) values (v_org, 'Salsa', 'prep', 10, lb, salsa_p) returning id into r_salsa;
  insert into public.recipe_ingredients (organization_id, recipe_id, product_id, quantity, unit_id) values (v_org, r_salsa, tomato, 7, lb), (v_org, r_salsa, onion, 1, lb);
  insert into public.recipes (organization_id, name, yield_qty, yield_unit_id) values (v_org, 'Chips & Salsa', 1, ea) returning id into r_nachos;
  insert into public.recipe_ingredients (organization_id, recipe_id, sub_recipe_id, quantity, unit_id) values (v_org, r_nachos, r_salsa, 4, oz);

  begin
    insert into public.recipe_ingredients (organization_id, recipe_id, sub_recipe_id, quantity, unit_id) values (v_org, r_sauce, r_sandwich, 1, ea);
    perform tests.assert(false, 'cycle');
  exception when others then
    perform tests.assert(sqlerrm like '%cannot contain itself%', 'recipe cycles are rejected');
  end;

  -- Nested cost: sandwich = 0.5 LB chicken (standard cost 0 until received) + bun 0.30 + 1/16 LB mayo @2.00 = 0.425
  v_cost1 := public.get_recipe_unit_cost(r_sandwich, v_loc);
  perform tests.assert(v_cost1 = 0.425, format('sandwich cost before chicken receipt = 0.425 (got %s)', v_cost1));
  select sum(base_qty) into v_n from app.recipe_components(r_burger, 100, true) where product_id = beef;
  perform tests.assert(v_n = 50, '100 burgers x 8 OZ beef = 50 LB (theoretical usage)');

  -- Opening count (last Sunday): chicken 14 LB, others some stock
  v_open_at := now() - interval '6 days';
  v_cnt := public.create_count_session(v_loc, 'full', 'Opening', v_open_at);
  perform public.save_count_entries(v_cnt, (select jsonb_agg(jsonb_build_object('client_entry_id', gen_random_uuid(), 'product_id', p.id, 'storage_location_id', walkin,
      'breakdown', jsonb_build_array(jsonb_build_object('unit_id', p.inventory_unit_id, 'qty', case p.id when chicken then 14 when salsa_p then 0 else 200 end))))
    from public.products p where p.organization_id = v_org));
  perform public.submit_count_session(v_cnt);
  perform public.post_count_session(v_cnt, true);
  perform tests.assert((select on_hand from public.inventory_balances where location_id = v_loc and product_id = chicken) = 14, 'opening chicken 14 LB');

  -- MONDAY: manager orders 5 cases (system suggested less), TUESDAY: 4 delivered, invoice says 5, back order
  v_po := public.create_purchase_order(v_loc, v_vendor, current_date, jsonb_build_array(jsonb_build_object('product_id', chicken, 'vendor_product_id', vp_chicken, 'order_qty', 5, 'suggested_qty', 4)));
  perform public.set_purchase_order_status(v_po, 'submitted', null, null, true);
  v_rcv := public.create_receipt(v_loc, null, v_po);
  select id into v_item from public.receipt_items where receipt_id = v_rcv;
  perform public.save_receipt(v_rcv, jsonb_build_object('invoice_number', 'INV-1', 'invoice_total', 640),
    jsonb_build_array(jsonb_build_object('id', v_item, 'received_qty', 4, 'invoiced_qty', 5, 'back_order', true)));
  perform public.complete_receiving(v_rcv);
  perform tests.logout(); perform set_config('role', 'postgres', true);
  update public.receipts set received_at = now() - interval '5 days' where id = v_rcv;
  perform tests.login(v_owner);
  perform public.post_receipt(v_rcv);
  perform tests.assert((select on_hand from public.inventory_balances where location_id = v_loc and product_id = chicken) = 174, 'after receiving 4 cases: 174 LB');
  perform tests.assert((select status from public.purchase_orders where id = v_po) = 'back_ordered', 'PO back ordered');

  -- Nested cost update flows through: chicken now 3.20/LB -> sandwich 1.60 + 0.30 + 0.125
  v_cost2 := public.get_recipe_unit_cost(r_sandwich, v_loc);
  perform tests.assert(v_cost2 = 2.025, format('sandwich cost after receipt = 2.025 (got %s)', v_cost2));

  -- Menu items
  insert into public.menu_items (organization_id, name, pos_item_id, selling_price, recipe_id) values (v_org, 'Grilled Chicken Sandwich', 'P100', 12.00, r_sandwich) returning id into mi_sandwich;
  insert into public.menu_items (organization_id, name, pos_item_id, selling_price, recipe_id) values (v_org, 'Cheeseburger', 'P200', 11.00, r_burger) returning id into mi_burger;

  -- WEDNESDAY: POS import. 280 sandwiches x 8 OZ = 140 LB chicken
  v_res := public.import_sales(v_loc, (now() - interval '4 days')::date, 'csv', 'wed.csv',
    jsonb_build_object('net_sales', 6260, 'guest_count', 420, 'check_count', 300),
    jsonb_build_array(
      jsonb_build_object('pos_item_id', 'P100', 'item_name', 'Grilled Chicken Sandwich', 'quantity', 280, 'net_sales', 3360),
      jsonb_build_object('pos_item_id', 'P200', 'item_name', 'Cheeseburger', 'quantity', 100, 'net_sales', 1100),
      jsonb_build_object('pos_item_id', 'P999', 'item_name', 'Mystery Special', 'quantity', 10, 'net_sales', 1800)));
  perform tests.assert((v_res ->> 'unmapped')::int = 1, 'unmapped POS item reported');
  perform tests.assert((select on_hand from public.inventory_balances where location_id = v_loc and product_id = chicken) = 34, 'POS depletes 140 LB chicken -> 34');
  perform tests.assert((select on_hand from public.inventory_balances where location_id = v_loc and product_id = beef) = 150, '100 burgers deplete 50 LB beef');
  perform tests.assert((select on_hand from public.inventory_balances where location_id = v_loc and product_id = mayo) = 200 - 380.0 / 16, 'house sauce (nested) depletes mayo by 380 oz');
  begin
    perform public.import_sales(v_loc, (now() - interval '4 days')::date, 'csv', 'again.csv', '{}'::jsonb, '[]'::jsonb);
    perform tests.assert(false, 'dup import');
  exception when unique_violation then
    perform tests.assert(true, 'duplicate POS import for the same day is rejected');
  end;

  -- THURSDAY: employee logs 3 LB chicken waste; recipe waste of 1 cheeseburger
  perform tests.logout(); perform tests.login(v_emp);
  v_res := public.log_waste(v_loc, chicken, 3, lb, 'SPOILAGE', walkin, null, null, now() - interval '3 days', 'd0000000-0000-0000-0000-000000000001');
  perform tests.assert((v_res ->> 'cost')::numeric = 9.60, 'chicken waste costs 3 x 3.20 = 9.60');
  v_res := public.log_waste(v_loc, chicken, 3, lb, 'SPOILAGE', walkin, null, null, now() - interval '3 days', 'd0000000-0000-0000-0000-000000000001');
  perform tests.assert((v_res ->> 'duplicate')::boolean, 'double-tap waste is idempotent');
  v_res := public.log_waste(v_loc, null, 1, ea, 'DROPPED', null, null, null, null, null, r_burger);
  perform tests.assert((select on_hand from public.inventory_balances where location_id = v_loc and product_id = beef) = 149.5, 'recipe waste: 1 burger depletes 0.5 LB beef');
  perform tests.assert((select on_hand from public.inventory_balances where location_id = v_loc and product_id = bun) = 200 - 380 - 1, 'recipe waste depletes the bun');
  perform tests.assert((select count(*) from public.inventory_transactions where source_type = 'waste' and product_id = cheese) = 1, 'recipe waste depletes cheese');
  perform tests.logout(); perform tests.login(v_owner);

  -- Production: 20 LB salsa planned, 19 LB actual -> 14 LB tomato, 2 LB onion depleted; +19 LB salsa
  v_res := public.record_production(v_loc, r_salsa, 20, 19);
  perform tests.assert((select on_hand from public.inventory_balances where location_id = v_loc and product_id = tomato) = 186, 'production depletes 14 LB tomatoes');
  perform tests.assert((select on_hand from public.inventory_balances where location_id = v_loc and product_id = salsa_p) = 19, 'production creates 19 LB salsa');
  perform tests.assert((select actual_qty - expected_qty from public.production_batches where location_id = v_loc limit 1) = -1, 'yield variance -1 LB');

  -- Location transfer 10 LB beef 101 -> 105: sender loses at send, receiver gains only at reconciliation
  v_tr := public.create_location_transfer(v_loc, v_loc2, jsonb_build_array(jsonb_build_object('product_id', beef, 'unit_id', lb, 'qty', 10)));
  perform public.send_transfer(v_tr);
  perform tests.assert((select on_hand from public.inventory_balances where location_id = v_loc and product_id = beef) = 139.5, 'sender loses 10 LB on send');
  perform tests.assert(coalesce((select on_hand from public.inventory_balances where location_id = v_loc2 and product_id = beef), 0) = 0, 'receiver has nothing while in transit');
  perform tests.assert(app.in_transit_qty(v_loc2, beef) = 10, '10 LB in transit to 105');
  perform public.receive_transfer(v_tr, (select jsonb_agg(jsonb_build_object('id', id, 'qty_received', 10)) from public.inventory_transfer_items where transfer_id = v_tr), true);
  perform tests.assert((select on_hand from public.inventory_balances where location_id = v_loc2 and product_id = beef) = 10, 'receiver gains 10 LB at reconciliation');

  -- SUNDAY: count. Book chicken = 174 - 140 - 3 = 31; physical 26 -> variance -5 LB = -16.00
  v_sun_at := now() - interval '1 hour';
  v_cnt := public.create_count_session(v_loc, 'weekly', 'Sunday Count', v_sun_at);
  perform public.save_count_entries(v_cnt, jsonb_build_array(jsonb_build_object('client_entry_id', gen_random_uuid(), 'product_id', chicken, 'storage_location_id', walkin,
    'breakdown', jsonb_build_array(jsonb_build_object('unit_id', lb, 'qty', 26)))));
  perform public.submit_count_session(v_cnt);
  select * into r from public.count_review_lines(v_cnt) where product_id = chicken;
  perform tests.assert(r.book_qty = 31 and r.physical_qty = 26 and r.variance_qty = -5, format('Sunday chicken: book 31, physical 26, variance -5 (got %s/%s/%s)', r.book_qty, r.physical_qty, r.variance_qty));
  perform tests.assert(r.variance_value = -16.00, format('variance value -$16.00 (got %s)', r.variance_value));
  perform tests.assert(r.begin_qty = 14 and r.received_qty = 160 and r.consumed_qty = -140 and r.waste_qty = -3, 'review movements begin 14 / received 160 / sold 140 / waste 3');
  perform public.post_count_session(v_cnt, true);

  -- Actual vs theoretical for the week
  v_res := public.get_food_cost(v_loc, v_open_at, v_sun_at);
  perform tests.assert((v_res ->> 'net_sales')::numeric = 6260, 'net sales from POS');
  perform tests.assert(round((v_res ->> 'actual_cost')::numeric, 2) = round((v_res ->> 'pos_usage_at_post')::numeric + (v_res ->> 'waste')::numeric + (v_res ->> 'count_variance')::numeric
                        + (v_res ->> 'adjustments')::numeric + (v_res ->> 'production_net')::numeric, 2),
                       format('actual = POS usage + waste + variance + adjustments + production (%s)', v_res));
  perform tests.assert((v_res ->> 'actual_cost')::numeric = (v_res ->> 'begin_inventory')::numeric + (v_res ->> 'purchases')::numeric + (v_res ->> 'transfers')::numeric - (v_res ->> 'end_inventory')::numeric,
                       'actual = begin + purchases + transfers - end');
  perform tests.assert((v_res ->> 'theoretical_cost')::numeric > 0 and (v_res ->> 'actual_pct') is not null, 'AvT percentages computed');
  select * into r from public.get_avt_by_product(v_loc, v_open_at, v_sun_at) where product_id = chicken;
  perform tests.assert(r.begin_qty = 14 and r.received_qty = 160 and r.theoretical_qty = 140 and r.expected_end_qty = 31 and r.physical_end_qty = 26 and r.variance_qty = -5,
                       'product AvT: begin 14 + received 160 - theoretical 140 - waste 3 = expected 31; physical 26; variance -5');

  -- Reversing a POS import that a posted count already covered is blocked
  begin
    perform public.reverse_sales_import((select id from public.sales_imports where location_id = v_loc), 'test');
    perform tests.assert(false, 'reverse after count');
  exception when others then
    perform tests.assert(sqlerrm like '%physical count was posted after%', 'cannot reverse sales already covered by a posted count');
  end;
  perform tests.logout();
  raise notice 'SAMPLE WEEK TESTS PASSED';
end $$;

rollback;
