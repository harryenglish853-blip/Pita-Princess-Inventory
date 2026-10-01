-- Toast order sync: no double counting through creates, repeats, updates, refunds, voids and mapping.
begin;
do $$
declare
  v_gm uuid; v_maria uuid; v_owner uuid; v_org uuid; v_loc uuid; v_beef uuid; v_bun uuid; v_burger uuid; v_today date; v_yday date;
  v_before numeric; v_bun_before numeric; v_res jsonb; v_imp public.sales_imports; v_cost numeric; v_order jsonb;
  v_ts bigint := 1790000000000;
begin
  select id into v_gm from auth.users where email = 'gm@example.com';
  select id into v_maria from auth.users where email = 'maria@example.com';
  select id into v_owner from auth.users where email = 'owner@example.com';
  select id, organization_id into v_loc, v_org from public.locations where code = '101';
  if v_gm is null or v_loc is null then raise notice 'SKIPPED: demo seed not loaded'; return; end if;
  select id into v_beef from public.products where organization_id = v_org and product_number = '1002';   -- 8 OZ per Cheeseburger
  select id into v_bun from public.products where organization_id = v_org and product_number = '4002';    -- 1 EA per Cheeseburger
  select recipe_id into v_burger from public.menu_items where organization_id = v_org and pos_item_id = 'P200';
  -- a business date with no sales yet (before the demo history); posted counts
  -- exist after it, so this also exercises the "late change after a count" path
  v_today := (now() at time zone 'America/New_York')::date - 40;
  v_yday := (select max(business_date) from public.sales_imports where location_id = v_loc and status = 'posted' and source <> 'toast_api');
  perform tests.assert(not exists (select 1 from public.sales_imports where location_id = v_loc and business_date = v_today and status = 'posted'), 'test day has no sales yet');

  perform tests.login(v_maria);
  begin
    perform public.ingest_toast_order(v_loc, jsonb_build_object('guid', 'x', 'business_date', v_today, 'modified_at', 1, 'selections', '[]'::jsonb));
    perform tests.assert(false, 'employee ingested');
  exception when insufficient_privilege then perform tests.assert(true, 'an employee cannot push sales into the system');
  end;
  perform tests.logout();

  perform tests.login(v_gm);
  v_before := app.book_qty(v_loc, v_beef, now() + interval '1 day');
  v_bun_before := app.book_qty(v_loc, v_bun, now() + interval '1 day');

  -- 1. new order: 2 cheeseburgers
  v_order := jsonb_build_object('guid', 'order-A', 'business_date', v_today, 'modified_at', v_ts, 'guest_count', 2,
    'selections', jsonb_build_array(jsonb_build_object('guid', 'sel-1', 'item_guid', 'P200', 'name', 'Cheeseburger', 'quantity', 2, 'net_sales', 17.90)));
  v_res := public.ingest_toast_order(v_loc, v_order, 'webhook');
  perform tests.assert(v_res ->> 'status' = 'applied', 'new order applied');
  perform tests.assert(app.book_qty(v_loc, v_beef, now() + interval '1 day') = v_before - 1, '2 cheeseburgers x 8 OZ = 1 LB beef used');
  perform tests.assert(app.book_qty(v_loc, v_bun, now() + interval '1 day') = v_bun_before - 2, '2 buns used');

  -- 2. the same webhook delivered again
  v_res := public.ingest_toast_order(v_loc, v_order, 'webhook');
  perform tests.assert(v_res ->> 'status' = 'unchanged', 'a repeated event is recognised');
  perform tests.assert(app.book_qty(v_loc, v_beef, now() + interval '1 day') = v_before - 1, 'repeat does not double count');

  -- 3. update: quantity 3
  v_order := jsonb_set(jsonb_set(v_order, '{modified_at}', to_jsonb(v_ts + 1000)), '{selections,0,quantity}', '3');
  v_order := jsonb_set(v_order, '{selections,0,net_sales}', '26.85');
  v_res := public.ingest_toast_order(v_loc, v_order, 'webhook');
  perform tests.assert(app.book_qty(v_loc, v_beef, now() + interval '1 day') = v_before - 1.5, 'quantity changed to 3: only the extra 0.5 LB is posted');

  -- 4. an out-of-order older event arrives late
  v_res := public.ingest_toast_order(v_loc, jsonb_set(v_order, '{modified_at}', to_jsonb(v_ts)), 'webhook');
  perform tests.assert(v_res ->> 'status' = 'stale', 'older event ignored');
  perform tests.assert(app.book_qty(v_loc, v_beef, now() + interval '1 day') = v_before - 1.5, 'stale event changes nothing');

  -- 5. refund of one burger
  v_order := jsonb_set(jsonb_set(v_order, '{modified_at}', to_jsonb(v_ts + 2000)), '{selections,0,refunded_quantity}', '1');
  perform public.ingest_toast_order(v_loc, v_order, 'webhook');
  perform tests.assert(app.book_qty(v_loc, v_beef, now() + interval '1 day') = v_before - 1.0, 'refunded burger: 0.5 LB put back');

  -- 6. second order with an unmapped item, plus a removed (voided) selection
  v_res := public.ingest_toast_order(v_loc, jsonb_build_object('guid', 'order-B', 'business_date', v_today, 'modified_at', v_ts, 'guest_count', 1,
    'selections', jsonb_build_array(
      jsonb_build_object('guid', 'sel-2', 'item_guid', 'TOAST-NEW-1', 'name', 'Smash Burger Special', 'quantity', 4, 'net_sales', 39.80),
      jsonb_build_object('guid', 'sel-3', 'item_guid', 'P200', 'name', 'Cheeseburger', 'quantity', 1, 'net_sales', 8.95, 'voided', true))), 'webhook');
  perform tests.assert((v_res ->> 'unmapped')::int = 1, 'unmapped Toast item reported');
  perform tests.assert(app.book_qty(v_loc, v_beef, now() + interval '1 day') = v_before - 1.0, 'unmapped and voided items deplete nothing');
  perform tests.assert(exists (select 1 from public.toast_sync_status(v_loc) s, jsonb_array_elements(s -> 'unmapped') u where u ->> 'item_guid' = 'TOAST-NEW-1'),
                       'UNMAPPED TOAST ITEM listed for management');
  perform tests.logout();

  -- 7. owner maps it to the Cheeseburger recipe -> reprocess posts the usage once
  perform tests.login(v_owner);
  perform public.map_pos_item(v_org, 'TOAST-NEW-1', 'Smash Burger Special', v_burger, 9.95);
  v_res := public.reprocess_toast_orders(v_loc);
  perform tests.assert(app.book_qty(v_loc, v_beef, now() + interval '1 day') = v_before - 3.0, 'after mapping: 4 x 8 OZ = 2 LB more beef');
  v_res := public.reprocess_toast_orders(v_loc);
  perform tests.assert(app.book_qty(v_loc, v_beef, now() + interval '1 day') = v_before - 3.0, 'reprocessing again changes nothing');
  perform tests.logout();

  -- 8. the day's sales row reflects the orders
  select * into v_imp from public.sales_imports where location_id = v_loc and business_date = v_today and status = 'posted';
  perform tests.assert(v_imp.source = 'toast_api', 'Toast day row exists');
  perform tests.assert(v_imp.net_sales = 26.85 + 39.80, format('net sales = non-voided selections (%s)', v_imp.net_sales));
  perform tests.assert(v_imp.check_count = 2 and v_imp.guest_count = 3, 'checks and guests');
  perform tests.assert(v_imp.unmapped_lines = 0, 'nothing unmapped after mapping');
  v_cost := public.recipe_unit_cost(v_burger, v_loc);
  perform tests.assert(v_imp.theoretical_cost = round((2 + 4) * v_cost, 4), format('theoretical cost = 6 burgers sold x recipe cost (%s)', v_imp.theoretical_cost));

  -- 9. void the first order entirely
  perform tests.login(v_gm);
  perform public.ingest_toast_order(v_loc, jsonb_set(jsonb_set(v_order, '{modified_at}', to_jsonb(v_ts + 3000)), '{voided}', 'true'), 'webhook');
  perform tests.assert(app.book_qty(v_loc, v_beef, now() + interval '1 day') = v_before - 2.0, 'voided order: its remaining 1 LB is put back');
  perform tests.assert((select net_sales from public.sales_imports where id = v_imp.id) = 39.80, 'voided order leaves sales');
  perform tests.assert((select coalesce(sum(quantity), 0) from public.inventory_transactions where source_type = 'toast_order' and product_id = v_beef and location_id = v_loc
                         and source_id in (select id from public.toast_orders where location_id = v_loc and toast_guid in ('order-A', 'order-B'))) = -2.0,
                       'ledger: Toast beef usage nets to exactly 2 LB');

  -- 10. reversal of the synced day is refused; a file-imported day holds sync
  begin
    perform public.reverse_sales_import(v_imp.id, 'test');
    perform tests.assert(false, 'reversed toast day');
  exception when raise_exception then perform tests.assert(true, 'a Toast-synced day cannot be reversed by hand');
  end;
  v_res := public.ingest_toast_order(v_loc, jsonb_build_object('guid', 'order-old', 'business_date', v_yday, 'modified_at', v_ts, 'selections', '[]'::jsonb), 'webhook');
  perform tests.assert(v_res ->> 'status' = 'held', 'orders for a day already imported from a file are held (no double count)');
  begin
    perform public.import_sales(v_loc, v_today, 'csv', 'x.csv', '{}'::jsonb, '[]'::jsonb);
    perform tests.assert(false, 'file import over toast day');
  exception when unique_violation then perform tests.assert(true, 'a file cannot be imported over a Toast-synced day');
  end;
  -- 11. malformed events are logged, not applied
  v_res := public.ingest_toast_order(v_loc, jsonb_build_object('guid', 'bad', 'business_date', 'not-a-date', 'modified_at', 1), 'webhook');
  perform tests.assert(v_res ->> 'status' = 'error', 'malformed event reported');
  perform tests.assert(exists (select 1 from public.toast_sync_log where toast_guid = 'bad' and status = 'error'), 'sync error logged');
  perform tests.logout();

  raise notice 'ALL TOAST ORDER TESTS PASSED';
end $$;
rollback;
