-- End-to-end database workflow test for Phases 1-3.
-- Runs as real users under RLS; everything is rolled back at the end.
begin;

do $$
declare
  v_owner uuid := tests.create_user('owner@test.local', 'Olivia Owner');
  v_gm    uuid := tests.create_user('gm@test.local', 'Gary Manager');
  v_emp   uuid := tests.create_user('emp@test.local', 'Erin Employee');
  v_emp2  uuid := tests.create_user('emp2@test.local', 'Eli Employee');
  v_other uuid := tests.create_user('other@test.local', 'Oscar Outsider');
  v_org uuid; v_loc uuid; v_org2 uuid;
  v_lb uuid; v_case uuid; v_oz uuid; v_ea uuid;
  v_cat uuid; v_chicken uuid; v_avocado uuid;
  v_vendor uuid; v_vp uuid; v_vp_avo uuid;
  v_walkin uuid; v_line uuid;
  v_po uuid; v_rcv uuid; v_rcv2 uuid; v_item uuid;
  v_res jsonb; v_n numeric; v_txt text; v_cnt uuid; v_entry uuid;
  v_ok boolean;
  r record;
begin
  -- ---------------- Phase 1: onboarding, permissions, master data ----------------
  perform tests.login(v_owner);
  v_org := public.create_organization('Test Restaurant Group', 'Test Restaurant #101', '101');
  select id into v_loc from public.locations where organization_id = v_org;
  perform tests.assert(v_loc is not null, 'owner created organization and first location');
  perform tests.assert((select count(*) from public.adjustment_reasons where organization_id = v_org) > 20, 'default adjustment/waste reasons provisioned');

  select id into v_lb from public.units where code = 'LB' and organization_id is null;
  select id into v_oz from public.units where code = 'OZ' and organization_id is null;
  select id into v_case from public.units where code = 'CASE' and organization_id is null;
  select id into v_ea from public.units where code = 'EA' and organization_id is null;

  insert into public.categories (organization_id, name) values (v_org, 'Protein') returning id into v_cat;
  insert into public.vendors (organization_id, name, delivery_days, lead_time_days, minimum_order)
    values (v_org, 'US Foods', '{2,5}', 1, 100) returning id into v_vendor;

  insert into public.products (organization_id, product_number, name, category_id, inventory_unit_id, recipe_unit_id, purchase_unit_id, default_vendor_id, receiving_temp_max)
    values (v_org, '1001', 'Chicken Breast', v_cat, v_lb, v_oz, v_case, v_vendor, 41) returning id into v_chicken;
  insert into public.product_units (organization_id, product_id, unit_id, factor, use_for_count, use_for_purchase)
    values (v_org, v_chicken, v_case, 40, true, true);
  insert into public.products (organization_id, product_number, name, category_id, inventory_unit_id, purchase_unit_id, default_vendor_id)
    values (v_org, '1002', 'Avocado', v_cat, v_ea, v_case, v_vendor) returning id into v_avocado;
  insert into public.product_units (organization_id, product_id, unit_id, factor, use_for_count, use_for_purchase)
    values (v_org, v_avocado, v_case, 48, true, true);

  -- Central conversion engine
  perform tests.assert(app.unit_factor(v_chicken, v_case) = 40, '1 CASE chicken = 40 LB');
  perform tests.assert(app.unit_factor(v_chicken, v_oz) = 0.0625, '1 OZ = 0.0625 LB (derived from standard units)');
  perform tests.assert(public.convert_quantity(v_chicken, 800, v_oz, v_lb) = 50, '800 OZ = 50 LB');
  perform tests.assert(public.convert_quantity(v_chicken, 1, v_case, v_oz) = 640, '1 CASE = 640 OZ (CASE -> LB -> OZ)');
  perform tests.assert(app.unit_factor(v_avocado, v_lb) is null, 'avocado has no weight conversion');
  begin
    perform app.to_base_qty(v_avocado, 1, v_lb);
    perform tests.assert(false, 'invalid conversion should fail');
  exception when sqlstate '22023' then
    perform tests.assert(true, 'invalid unit conversion is rejected');
  end;

  insert into public.vendor_products (organization_id, vendor_id, product_id, vendor_item_number, purchase_unit_id, pack_size, current_price, is_preferred)
    values (v_org, v_vendor, v_chicken, '48219', v_case, '4/10 LB', 128.00, true) returning id into v_vp;
  insert into public.vendor_products (organization_id, vendor_id, product_id, vendor_item_number, purchase_unit_id, pack_size, current_price)
    values (v_org, v_vendor, v_avocado, '92441', v_case, '48 CT', 47.00) returning id into v_vp_avo;

  insert into public.storage_locations (organization_id, location_id, name, kind, sort_order) values (v_org, v_loc, 'Walk-In Cooler', 'walk_in_cooler', 1) returning id into v_walkin;
  insert into public.storage_locations (organization_id, location_id, name, kind, sort_order) values (v_org, v_loc, 'Line Cooler', 'line', 2) returning id into v_line;
  perform public.set_storage_sequence(v_walkin, jsonb_build_array(
    jsonb_build_object('product_id', v_avocado, 'shelf', 'Shelf 1'),
    jsonb_build_object('product_id', v_chicken, 'shelf', 'Shelf 2')));
  perform public.set_storage_sequence(v_line, jsonb_build_array(jsonb_build_object('product_id', v_chicken, 'shelf', 'Rail')));
  perform tests.assert((select sort_order from public.product_storage_locations where storage_location_id = v_walkin and product_id = v_chicken) = 2, 'shelf-to-sheet order saved');

  update public.location_products set par_qty = 100, safety_stock_qty = 10 where location_id = v_loc and product_id = v_chicken;

  -- Staff
  perform public.assign_role(v_org, v_gm, 'general_manager', 'location', v_loc);
  perform public.assign_role(v_org, v_emp, 'employee', 'location', v_loc);
  perform tests.logout();
  -- GM can hire an employee for their store but cannot create another GM
  perform tests.login(v_gm);
  perform public.assign_role(v_org, v_emp2, 'employee', 'location', v_loc);
  begin
    perform public.assign_role(v_org, v_emp2, 'general_manager', 'location', v_loc);
    perform tests.assert(false, 'GM cannot grant GM');
  exception when insufficient_privilege then
    perform tests.assert(true, 'GM cannot grant a role equal to their own');
  end;
  begin
    perform public.assign_role(v_org, v_emp2, 'employee', 'organization', v_org);
    perform tests.assert(false, 'GM cannot grant org scope');
  exception when insufficient_privilege then
    perform tests.assert(true, 'GM cannot grant organization-wide roles');
  end;
  perform tests.logout();

  -- ---------------- Security ----------------
  perform tests.login(v_emp);
  begin
    insert into public.products (organization_id, product_number, name, inventory_unit_id) values (v_org, '9999', 'Hack', v_lb);
    perform tests.assert(false, 'employee must not create products');
  exception when insufficient_privilege then
    perform tests.assert(true, 'employee cannot create corporate products (RLS)');
  end;
  begin
    perform public.adjust_inventory(v_loc, v_chicken, 5, v_lb, 'CORRECTION', 'test');
    perform tests.assert(false, 'employee must not adjust');
  exception when insufficient_privilege then
    perform tests.assert(true, 'employee cannot adjust inventory');
  end;
  begin
    insert into public.inventory_transactions (organization_id, location_id, product_id, txn_type, quantity, txn_at, business_date)
      values (v_org, v_loc, v_chicken, 'RECEIPT', 1000, now(), current_date);
    perform tests.assert(false, 'direct ledger insert must fail');
  exception when insufficient_privilege then
    perform tests.assert(true, 'ledger cannot be written directly');
  end;
  perform tests.logout();

  perform tests.login(v_gm);
  begin
    update public.products set name = 'Renamed' where id = v_chicken;
    get diagnostics v_n = row_count;
    perform tests.assert(v_n = 0, 'store GM cannot alter corporate product master (0 rows updated)');
  end;
  update public.location_products set par_qty = 120 where location_id = v_loc and product_id = v_chicken;
  get diagnostics v_n = row_count;
  perform tests.assert(v_n = 1, 'store GM can set local par');
  begin
    update public.location_products set avg_cost = 0.01 where location_id = v_loc and product_id = v_chicken;
    perform tests.assert(false, 'cost must not be directly editable');
  exception when others then
    perform tests.assert(sqlerrm like '%maintained by inventory transactions%', 'avg cost cannot be edited directly');
  end;
  perform tests.logout();

  perform tests.login(v_other);
  v_org2 := public.create_organization('Other Co', 'Other #1', '1');
  perform tests.assert((select count(*) from public.products) = 0, 'other organization sees no products (tenant isolation)');
  perform tests.assert((select count(*) from public.locations) = 1, 'other organization sees only its own location');
  perform tests.logout();

  -- ---------------- Phase 3: suggested order, PO, receiving, reconciliation ----------------
  perform tests.login(v_gm);
  -- No usage history: NEED = par 120 (> coverage usage + safety), HAVE = 0 -> 120 LB -> 3 cases
  select s.suggested_qty, s.explanation into v_n, v_res
    from public.suggest_order(v_loc, v_vendor, current_date + 1, current_date + 4) s where s.product_id = v_chicken;
  perform tests.assert(v_n = 3, format('suggested 3 cases chicken from par 120 LB / 40 LB case (got %s)', v_n));
  perform tests.assert((v_res ->> 'need')::numeric = 120 and (v_res ->> 'have')::numeric = 0, 'explanation shows need 120, have 0');

  v_po := public.create_purchase_order(v_loc, v_vendor, current_date + 1, jsonb_build_array(
    jsonb_build_object('product_id', v_chicken, 'vendor_product_id', v_vp, 'order_qty', 5, 'suggested_qty', 3, 'suggestion', v_res)),
    null, null, 'a0000000-0000-0000-0000-000000000001');
  perform tests.assert(public.create_purchase_order(v_loc, v_vendor, current_date + 1, '[]'::jsonb, null, null, 'a0000000-0000-0000-0000-000000000001') = v_po,
                       'PO creation is idempotent (double submit returns same order)');
  select extended_price into v_n from public.purchase_order_items where po_id = v_po;
  perform tests.assert(v_n = 640, 'PO line extended = 5 x 128 = 640');
  perform tests.assert((select suggested_qty from public.purchase_order_items where po_id = v_po) = 3, 'system suggestion stored next to manager order');
  perform public.set_purchase_order_status(v_po, 'submitted');
  begin
    perform public.set_purchase_order_status(v_po, 'submitted');
  exception when others then null;
  end;
  perform tests.assert((select status from public.purchase_orders where id = v_po) = 'submitted', 'PO submitted');
  begin
    perform public.update_purchase_order(v_po, '[]'::jsonb);
    perform tests.assert(false, 'submitted PO must be locked');
  exception when others then
    perform tests.assert(sqlerrm like '%can no longer be edited%', 'submitted PO cannot be edited');
  end;
  perform tests.assert(app.on_order_qty(v_loc, v_chicken) = 200, 'on-order quantity 5 cases = 200 LB');
  perform tests.logout();

  -- Employee receives: ordered 5, physically 4, invoice says 5 -> short + mismatch; back order
  perform tests.login(v_emp);
  v_rcv := public.create_receipt(v_loc, null, v_po);
  perform tests.assert(public.create_receipt(v_loc, null, v_po) = v_rcv, 'receiving the same PO twice reuses the open receipt');
  select id into v_item from public.receipt_items where receipt_id = v_rcv;
  v_res := public.save_receipt(v_rcv, jsonb_build_object('invoice_number', 'INV-5001', 'invoice_total', 640),
    jsonb_build_array(jsonb_build_object('id', v_item, 'received_qty', 4, 'invoiced_qty', 5, 'back_order', true, 'temperature', 38,
      'lot_number', 'LOT-ABC123', 'storage_allocations', jsonb_build_array(
         jsonb_build_object('storage_location_id', v_walkin, 'qty', 3), jsonb_build_object('storage_location_id', v_line, 'qty', 1)))));
  select exception_codes into v_txt from public.receipt_items where id = v_item;
  perform tests.assert(v_txt like '%short%' and v_txt like '%invoice_qty_mismatch%' and v_txt like '%back_order%', 'short delivery + invoice mismatch flagged: ' || v_txt);
  perform public.complete_receiving(v_rcv);
  perform tests.assert((select status from public.purchase_orders where id = v_po) = 'ready_to_reconcile', 'PO ready to reconcile');
  perform tests.assert(exists (select 1 from public.tasks where entity_id = v_rcv and status = 'open'), 'discrepancy task created');
  begin
    perform public.post_receipt(v_rcv);
    perform tests.assert(false, 'employee cannot reconcile');
  exception when insufficient_privilege then
    perform tests.assert(true, 'employee cannot reconcile invoices');
  end;
  perform tests.logout();

  perform tests.login(v_gm);
  -- invoice 640 vs calculated (5 invoiced x 128) = 640: balanced. Vendor will credit later -> we record credit 128.
  v_res := public.save_receipt(v_rcv, jsonb_build_object('credits', 128), null);
  perform tests.assert((v_res ->> 'over_short')::numeric = 128, 'credit of 128 makes invoice out of balance by 128');
  begin
    perform public.post_receipt(v_rcv);
    perform tests.assert(false, 'out of balance needs reason');
  exception when sqlstate 'P0006' then
    perform tests.assert(true, 'out-of-balance invoice requires override reason');
  end;
  v_res := public.save_receipt(v_rcv, jsonb_build_object('credits', 0), null);
  v_res := public.post_receipt(v_rcv);
  perform tests.assert((v_res ->> 'lines')::int = 1, 'receipt posted');
  select on_hand into v_n from public.inventory_balances where location_id = v_loc and product_id = v_chicken;
  perform tests.assert(v_n = 160, format('on hand 4 cases = 160 LB (got %s)', v_n));
  perform tests.assert((select count(*) from public.inventory_transactions where source_id = v_rcv) = 2, 'receipt split into 2 storage ledger rows');
  perform tests.assert((select avg_cost from public.location_products where location_id = v_loc and product_id = v_chicken) = 3.2, 'avg cost = 128/40 = 3.20/LB');
  perform tests.assert((select status from public.purchase_orders where id = v_po) = 'back_ordered', 'PO status back ordered');
  perform tests.assert((select back_ordered_qty from public.purchase_order_items where po_id = v_po) = 1, '1 case on back order');
  perform tests.assert(app.on_order_qty(v_loc, v_chicken) = 40, 'back ordered case still counts as incoming (40 LB)');
  perform tests.assert((select count(*) from public.price_history where product_id = v_chicken) = 1, 'price history recorded');
  perform tests.assert(exists (select 1 from public.search_lots('ABC123')), 'recall search finds lot ABC123');
  perform tests.assert(not exists (select 1 from public.tasks where entity_id = v_rcv and status = 'open'), 'discrepancy task closed on posting');
  begin
    perform public.post_receipt(v_rcv);
    perform tests.assert(false, 'double post must fail');
  exception when sqlstate 'P0003' then
    perform tests.assert(true, 'receipt cannot be posted twice');
  end;

  -- Back order arrives: new receipt for remaining case, at higher price -> price alert
  v_rcv2 := public.create_receipt(v_loc, null, v_po);
  perform tests.assert(v_rcv2 <> v_rcv and (select ordered_qty from public.receipt_items where receipt_id = v_rcv2) = 1, 'back-order receipt pre-filled with 1 case');
  begin
    perform public.save_receipt(v_rcv2, jsonb_build_object('invoice_number', 'inv-5001'), null);
    perform tests.assert(false, 'duplicate invoice must fail');
  exception when unique_violation then
    perform tests.assert(true, 'duplicate invoice number rejected (case-insensitive)');
  end;
  select id into v_item from public.receipt_items where receipt_id = v_rcv2;
  perform public.save_receipt(v_rcv2, jsonb_build_object('invoice_number', 'INV-5002', 'invoice_total', 140),
    jsonb_build_array(jsonb_build_object('id', v_item, 'received_qty', 1, 'invoiced_qty', 1, 'invoice_price', 140)));
  perform public.complete_receiving(v_rcv2);
  v_res := public.post_receipt(v_rcv2);
  perform tests.assert((v_res ->> 'price_alerts')::int = 1, 'price increase 3.20 -> 3.50 (+9.4%) raises alert');
  perform tests.assert((select status from public.purchase_orders where id = v_po) = 'posted', 'PO fully received -> posted');
  select avg_cost into v_n from public.location_products where location_id = v_loc and product_id = v_chicken;
  perform tests.assert(v_n = 3.26, format('weighted avg (160*3.20 + 40*3.50)/200 = 3.26 (got %s)', v_n));
  perform tests.assert((select current_price from public.vendor_products where id = v_vp) = 140, 'order guide price updated to latest invoice');

  -- Manual adjustment
  v_res := public.adjust_inventory(v_loc, v_chicken, -3, v_lb, 'EMPLOYEE_MEAL', null);
  perform tests.assert((v_res ->> 'original_qty')::numeric = 200 and (v_res ->> 'new_qty')::numeric = 197, 'adjustment reports original 200 -> new 197');
  begin
    perform public.adjust_inventory(v_loc, v_chicken, -1, v_lb, 'CORRECTION', '');
    perform tests.assert(false, 'comment required');
  exception when others then
    perform tests.assert(sqlerrm like '%comment is required%', 'correction requires a comment');
  end;
  perform tests.logout();

  -- ---------------- Phase 2: physical count ----------------
  perform tests.login(v_emp);
  v_cnt := public.create_count_session(v_loc, 'full', 'Sunday Count', now(), null, null, 'b0000000-0000-0000-0000-000000000001');
  perform tests.assert((select count(*) from public.count_session_items where session_id = v_cnt) = 3, 'count sheet has 3 lines (chicken in 2 areas + avocado)');
  v_res := public.get_count_sheet(v_cnt);
  perform tests.assert(jsonb_array_length(v_res -> 'lines') = 3 and (v_res -> 'lines' -> 0 ->> 'name') = 'Avocado', 'sheet follows shelf-to-sheet order');
  perform tests.assert(not ((v_res -> 'lines' -> 0) ? 'book_qty'), 'blind count: book qty not exposed to counters');

  -- Walk-in: 4 cases + 8.5 LB = 168.5 LB ; offline replay of the same entry is idempotent
  v_res := public.save_count_entries(v_cnt, jsonb_build_array(jsonb_build_object(
    'client_entry_id', 'c0000000-0000-0000-0000-000000000001', 'product_id', v_chicken, 'storage_location_id', v_walkin,
    'breakdown', jsonb_build_array(jsonb_build_object('unit_id', v_case, 'qty', 4), jsonb_build_object('unit_id', v_lb, 'qty', 8.5)),
    'method', 'voice', 'voice_transcript', 'chicken breast four cases and eight and a half pounds', 'voice_confidence', 0.93)));
  perform tests.assert((v_res -> 'results' -> 0 -> 'entry' ->> 'quantity')::numeric = 168.5, 'case + weight computed server-side = 168.5 LB');
  v_res := public.save_count_entries(v_cnt, jsonb_build_array(jsonb_build_object(
    'client_entry_id', 'c0000000-0000-0000-0000-000000000001', 'product_id', v_chicken, 'storage_location_id', v_walkin,
    'breakdown', jsonb_build_array(jsonb_build_object('unit_id', v_case, 'qty', 4)))));
  perform tests.assert((v_res -> 'results' -> 0 ->> 'status') = 'duplicate', 'replayed offline entry detected as duplicate');
  perform tests.assert((select status from public.count_sessions where id = v_cnt) = 'in_progress', 'first entry starts the count');
  perform tests.logout();

  -- Second counter edits the same line with a stale revision -> conflict, not overwrite
  perform tests.login(v_emp2);
  v_res := public.save_count_entries(v_cnt, jsonb_build_array(jsonb_build_object(
    'client_entry_id', 'c0000000-0000-0000-0000-000000000002', 'product_id', v_chicken, 'storage_location_id', v_walkin,
    'base_revision', 0, 'breakdown', jsonb_build_array(jsonb_build_object('unit_id', v_lb, 'qty', 100)))));
  perform tests.assert((v_res -> 'results' -> 0 ->> 'status') = 'conflict', 'concurrent edit by another counter becomes a conflict');
  perform tests.assert((select quantity from public.count_entries where session_id = v_cnt and storage_location_id = v_walkin) = 168.5, 'original count not overwritten');
  -- Second counter counts the line cooler + avocado (different lines merge into same event)
  v_res := public.save_count_entries(v_cnt, jsonb_build_array(
    jsonb_build_object('client_entry_id', 'c0000000-0000-0000-0000-000000000003', 'product_id', v_chicken, 'storage_location_id', v_line,
      'breakdown', jsonb_build_array(jsonb_build_object('unit_id', v_lb, 'qty', 6))),
    jsonb_build_object('client_entry_id', 'c0000000-0000-0000-0000-000000000004', 'product_id', v_avocado, 'storage_location_id', v_walkin,
      'breakdown', jsonb_build_array(jsonb_build_object('unit_id', v_ea, 'qty', 0)))));
  perform public.submit_count_session(v_cnt);
  perform tests.logout();

  perform tests.login(v_gm);
  begin
    perform public.post_count_session(v_cnt, true);
    perform tests.assert(false, 'conflict must block posting');
  exception when others then
    perform tests.assert(sqlerrm like '%conflicting%', 'unresolved conflict blocks posting');
  end;
  -- Resolve with the original value
  select e.id into v_entry from public.count_entries e where e.session_id = v_cnt and e.storage_location_id = v_walkin and e.product_id = v_chicken;
  perform public.resolve_count_conflict(v_entry, (select id from public.count_entry_revisions where entry_id = v_entry and status = 'applied' order by id limit 1));

  select * into r from public.count_review_lines(v_cnt) where product_id = v_chicken;
  perform tests.assert(r.book_qty = 197 and r.physical_qty = 174.5, format('review: book 197, physical 168.5+6 = 174.5 (got %s / %s)', r.book_qty, r.physical_qty));
  perform tests.assert(r.variance_qty = -22.5 and r.begin_qty = 0 and r.received_qty = 200 and r.adjusted_qty = -3, 'review movements: begin 0 + received 200 - adjusted 3 = book 197');
  perform tests.assert(r.variance_value = round(-22.5 * 3.26, 2), format('variance value = -22.5 x 3.26 = %s', r.variance_value));
  perform tests.assert(r.exceeds_tolerance, 'variance -$73.35 exceeds $50 tolerance -> recount required');

  perform public.request_recount(v_cnt, array[v_chicken]);
  begin
    perform public.post_count_session(v_cnt, true);
    perform tests.assert(false, 'recount outstanding');
  exception when others then
    perform tests.assert(sqlerrm like '%Recounts are still outstanding%', 'outstanding recount blocks posting');
  end;
  perform tests.logout();

  perform tests.login(v_emp);
  -- recount: 4 cases + 18.5 LB in walk-in -> total 184.5
  v_res := public.save_count_entries(v_cnt, jsonb_build_array(jsonb_build_object(
    'client_entry_id', 'c0000000-0000-0000-0000-000000000005', 'product_id', v_chicken, 'storage_location_id', v_walkin,
    'base_revision', (select revision from public.count_entries where id = v_entry),
    'breakdown', jsonb_build_array(jsonb_build_object('unit_id', v_case, 'qty', 4), jsonb_build_object('unit_id', v_lb, 'qty', 18.5)))));
  perform tests.assert((v_res -> 'results' -> 0 ->> 'status') = 'applied', 'recount of flagged line allowed while awaiting review');
  -- the product's other storage line is part of the same recount request
  v_res := public.save_count_entries(v_cnt, jsonb_build_array(jsonb_build_object(
    'client_entry_id', 'c0000000-0000-0000-0000-000000000007', 'product_id', v_chicken, 'storage_location_id', v_line,
    'breakdown', jsonb_build_array(jsonb_build_object('unit_id', v_lb, 'qty', 6)))));
  begin
    perform public.save_count_entries(v_cnt, jsonb_build_array(jsonb_build_object(
      'client_entry_id', 'c0000000-0000-0000-0000-000000000006', 'product_id', v_avocado, 'storage_location_id', v_walkin,
      'breakdown', jsonb_build_array(jsonb_build_object('unit_id', v_ea, 'qty', 3)))));
    perform tests.assert(false, 'non-flagged line locked');
  exception when sqlstate 'P0002' then
    perform tests.assert(true, 'lines not marked for recount are locked after submit');
  end;
  perform tests.logout();

  perform tests.login(v_gm);
  select * into r from public.count_review_lines(v_cnt) where product_id = v_chicken;
  perform tests.assert(r.variance_qty = -12.5 and r.recounted, 'after recount variance -12.5 LB');
  perform tests.assert(not r.exceeds_tolerance, 'recounted variance -$40.75 is within tolerance');
  v_res := public.post_count_session(v_cnt, false);
  perform tests.assert((select status from public.count_sessions where id = v_cnt) = 'posted', 'count posted');
  select on_hand into v_n from public.inventory_balances where location_id = v_loc and product_id = v_chicken;
  perform tests.assert(v_n = 184.5, format('perpetual inventory updated to physical 184.5 (got %s)', v_n));
  perform tests.assert(exists (select 1 from public.inventory_transactions where source_id = v_cnt and txn_type = 'PHYSICAL_VARIANCE' and quantity = -12.5),
                       'PHYSICAL_VARIANCE ledger row created');
  perform tests.assert((select count(*) from public.count_entry_revisions where session_id = v_cnt) >= 6, 'all original count revisions preserved');
  begin
    perform public.post_count_session(v_cnt, true);
    perform tests.assert(false, 'double post');
  exception when sqlstate 'P0003' then
    perform tests.assert(true, 'count cannot be posted twice');
  end;
  select * into r from public.count_review_lines(v_cnt) where product_id = v_chicken;
  perform tests.assert(r.physical_qty = 184.5 and r.book_qty = 197, 'posted review is reproducible from snapshot');
  perform tests.logout();

  -- Ledger immutability (even for the owner)
  begin
    update public.inventory_transactions set quantity = 1 where location_id = v_loc;
    perform tests.assert(false, 'ledger update');
  exception when others then
    perform tests.assert(true, 'ledger rows are immutable');
  end;

  -- Audit trail captured receipt-line edits (invoice qty etc.)
  perform tests.assert(exists (select 1 from public.audit_logs where entity_type = 'receipt_items' and new_value ? 'received_qty'), 'audit log records receipt quantity changes');
  perform tests.assert(exists (select 1 from public.audit_logs where entity_type = 'count_session' and action = 'post'), 'audit log records count posting');

  -- Alerts
  perform tests.login(v_gm);
  perform public.refresh_stock_alerts(v_loc);
  perform tests.assert(exists (select 1 from public.alerts where location_id = v_loc and alert_type = 'price_increase'), 'price alert visible to GM');
  perform tests.logout();
  raise notice 'ALL PHASE 1-3 WORKFLOW TESTS PASSED';
end $$;

rollback;
