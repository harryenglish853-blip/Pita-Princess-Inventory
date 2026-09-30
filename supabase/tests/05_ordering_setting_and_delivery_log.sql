-- Ordering is optional: the organization setting, and a delivery logged from
-- its invoice with no purchase order (ordered in the vendor's own app).
begin;
do $$
declare
  v_owner uuid; v_gm uuid; v_org uuid; v_loc uuid; v_vendor uuid; v_vp public.vendor_products; v_rcpt uuid;
  v_before numeric; v_after numeric; v_ctx jsonb; v_item public.receipt_items; v_factor numeric;
begin
  select id into v_owner from auth.users where email = 'owner@example.com';
  select id into v_gm from auth.users where email = 'gm@example.com';
  select id, organization_id into v_loc, v_org from public.locations where code = '101';
  if v_owner is null or v_loc is null then raise notice 'SKIPPED: demo seed not loaded'; return; end if;

  -- ---------------------------------------------------------------- setting
  perform tests.login(v_gm);
  v_ctx := public.get_session_context();
  perform tests.assert(coalesce((v_ctx -> 'organizations' -> 0 -> 'settings' ->> 'ordering_enabled')::boolean, false) = false, 'ordering is off by default');
  begin
    perform public.set_organization_setting(v_org, 'ordering_enabled', 'true'::jsonb);
    perform tests.assert(false, 'store GM cannot change org settings');
  exception when insufficient_privilege then perform tests.assert(true, 'a store manager cannot change organization settings');
  end;
  perform tests.logout();

  perform tests.login(v_owner);
  perform public.set_organization_setting(v_org, 'ordering_enabled', 'true'::jsonb);
  v_ctx := public.get_session_context();
  perform tests.assert((select (o -> 'settings' ->> 'ordering_enabled')::boolean from jsonb_array_elements(v_ctx -> 'organizations') o where (o ->> 'id')::uuid = v_org), 'owner turns ordering on; session context shows it');
  perform tests.assert(exists (select 1 from public.audit_logs where entity_type = 'organization_settings' and entity_id = v_org::text), 'setting change is audited');
  begin
    perform public.set_organization_setting(v_org, 'ordering_enabled', '"yes"'::jsonb);
    perform tests.assert(false, 'non-boolean rejected');
  exception when raise_exception then perform tests.assert(true, 'ordering_enabled must be true/false');
  end;
  begin
    perform public.set_organization_setting(v_org, 'currency_hack', '1'::jsonb);
    perform tests.assert(false, 'unknown key rejected');
  exception when raise_exception then perform tests.assert(true, 'unknown settings are rejected');
  end;
  perform public.set_organization_setting(v_org, 'ordering_enabled', 'false'::jsonb);
  perform tests.logout();

  -- ---------------------------------------------------------------- delivery with no purchase order
  select id into v_vendor from public.vendors where organization_id = v_org and name = 'Local Produce Company';
  select vp.* into v_vp from public.vendor_products vp join public.products p on p.id = vp.product_id
   where vp.vendor_id = v_vendor and p.product_number = '2002';   -- tomatoes
  perform tests.login(v_gm);
  v_before := app.book_qty(v_loc, v_vp.product_id, now());
  v_rcpt := public.create_receipt(v_loc, v_vendor, null, null);
  perform public.save_receipt(v_rcpt,
    jsonb_build_object('invoice_number', 'LPC-NOPO-1', 'invoice_total', '63.00'),
    jsonb_build_array(jsonb_build_object('product_id', v_vp.product_id, 'vendor_product_id', v_vp.id, 'line_type', 'unordered',
                                         'invoiced_qty', '2', 'received_qty', '2', 'invoice_price', '31.50')));
  select * into v_item from public.receipt_items where receipt_id = v_rcpt;
  perform tests.assert(v_item.line_type = 'unordered' and v_item.ordered_qty = 0, 'line recorded without an order');
  perform tests.assert(not (v_item.exception_codes && array['short', 'over', 'missing']), 'no short/over flags when nothing was ordered here');
  perform public.complete_receiving(v_rcpt);
  perform public.post_receipt(v_rcpt, null);
  v_factor := v_item.unit_factor;
  v_after := app.book_qty(v_loc, v_vp.product_id, now());
  perform tests.assert(v_after - v_before = 2 * v_factor, format('stock rises by the delivered amount (%s)', 2 * v_factor));
  perform tests.assert((select status from public.receipts where id = v_rcpt) = 'posted', 'delivery posted');
  perform tests.assert(exists (select 1 from public.price_history where product_id = v_vp.product_id and source_id = v_rcpt), 'price history recorded from the invoice');
  perform tests.logout();

  raise notice 'ALL ORDERING SETTING AND DELIVERY LOG TESTS PASSED';
end $$;
rollback;
