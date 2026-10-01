-- Email: recipients, dedupe, rate limits, report data accuracy, sender protocol.
begin;
-- the sender protocol is exercised as the server (service_role) inside this rolled-back transaction
grant usage on schema tests to service_role;
grant execute on all functions in schema tests to service_role;
do $$
declare
  v_owner uuid; v_gm uuid; v_maria uuid; v_org uuid; v_loc uuid; v_rec uuid; v_id uuid; v_id2 uuid; v jsonb; v_n int;
  v_day date; v_sales numeric; v_waste numeric; v_from date; v_to date; v_purch numeric; r record; v_alert uuid;
begin
  select id into v_owner from auth.users where email = 'owner@example.com';
  select id into v_gm from auth.users where email = 'gm@example.com';
  select id into v_maria from auth.users where email = 'maria@example.com';
  select id, organization_id into v_loc, v_org from public.locations where code = '101';
  if v_owner is null or v_loc is null then raise notice 'SKIPPED: demo seed not loaded'; return; end if;

  -- ---------------------------------------------------------------- recipients are owner-managed
  perform tests.login(v_gm);
  begin
    perform public.save_email_recipient(v_org, null, 'Sneaky', 'x@example.com', null, true, array['daily_report']);
    perform tests.assert(false, 'gm managed recipients');
  exception when insufficient_privilege then perform tests.assert(true, 'a store manager cannot change email recipients');
  end;
  select count(*) into v_n from public.email_outbox;
  perform tests.assert(v_n = 0, 'store manager cannot read the outbox (it holds financial data)');
  perform tests.logout();

  perform tests.login(v_owner);
  begin
    perform public.save_email_recipient(v_org, null, 'Bad', 'not-an-email', null, true, array['daily_report']);
    perform tests.assert(false, 'bad email');
  exception when check_violation then perform tests.assert(true, 'invalid email addresses are rejected');
  end;
  begin
    perform public.save_email_recipient(v_org, null, 'Bad', 'bad@example.com', null, true, array['nonsense']);
    perform tests.assert(false, 'bad kind');
  exception when raise_exception then perform tests.assert(true, 'unknown email types are rejected');
  end;
  v_rec := public.save_email_recipient(v_org, null, 'Test Person', 'Test.Person@Example.com', v_loc, true, array['price_alert', 'daily_report']);
  perform tests.assert((select email from public.email_recipients where id = v_rec) = 'test.person@example.com', 'emails are stored lower-case');
  perform tests.assert((select count(*) from public.email_subscriptions where recipient_id = v_rec) = 2, 'two subscriptions');
  perform public.save_email_recipient(v_org, v_rec, 'Test Person', 'test.person@example.com', v_loc, true, array['daily_report']);
  perform tests.assert((select array_agg(kind) from public.email_subscriptions where recipient_id = v_rec) = array['daily_report'], 'unticked subscriptions are removed');
  perform tests.logout();

  -- ---------------------------------------------------------------- queue: recipients, dedupe, skip, rate limit
  v_id := app.queue_email(v_org, v_loc, 'daily_report', 'test:daily:1', 'Test', '{"template":"daily"}');
  perform tests.assert(exists (select 1 from public.email_outbox where id = v_id and 'test.person@example.com' = any(recipients)), 'store-specific recipient included');
  perform tests.assert(exists (select 1 from public.email_outbox where id = v_id and 'owner@example.com' = any(recipients)), 'all-location recipient included');
  v_id2 := app.queue_email(v_org, v_loc, 'daily_report', 'test:daily:1', 'Test again', '{"template":"daily"}');
  perform tests.assert(v_id2 is null and (select count(*) from public.email_outbox where dedupe_key = 'test:daily:1') = 1, 'same dedupe key never queues twice');
  v_id := app.queue_email(v_org, (select id from public.locations where code = '105'), 'low_stock', 'test:low:105', 'Low', '{}');
  perform tests.assert((select status from public.email_outbox where id = v_id) = 'skipped', 'no subscribers: stored as skipped, not sent');
  for i in 1..12 loop
    perform app.queue_email(v_org, v_loc, 'waste_alert', 'test:waste:' || i, 'Waste ' || i, '{}', '{}', 10);
  end loop;
  select count(*) into v_n from public.email_outbox where dedupe_key like 'test:waste:%' and status = 'pending';
  perform tests.assert(v_n = 10, format('immediate alerts are rate limited to 10 per hour per store (got %s)', v_n));

  -- an alert emails once when raised, not on every refresh
  perform app.raise_alert(v_loc, 'high_waste', 'warning', 'Test waste alert', 'x', 'test_waste_alert');
  select id into v_alert from public.alerts where location_id = v_loc and dedupe_key = 'test_waste_alert' and status <> 'resolved';
  perform app.raise_alert(v_loc, 'high_waste', 'warning', 'Test waste alert', 'y', 'test_waste_alert');
  perform tests.assert((select count(*) from public.email_outbox where dedupe_key = 'alert:' || v_alert) = 1, 'refreshing an open alert does not email again');

  -- ---------------------------------------------------------------- report data matches the source tables
  select business_date, net_sales into v_day, v_sales from public.sales_imports where location_id = v_loc and status = 'posted' order by business_date desc limit 1;
  select coalesce(sum(total_cost), 0) into v_waste from public.waste_logs where location_id = v_loc and business_date = v_day;
  v := app.daily_report_data(v_loc, v_day);
  perform tests.assert((v ->> 'sales')::numeric = v_sales, format('daily report sales = POS net sales (%s)', v_sales));
  perform tests.assert((v ->> 'waste')::numeric = v_waste, format('daily report waste = waste log (%s)', v_waste));
  perform tests.assert((v ->> 'theoretical_pct')::numeric = round((select theoretical_cost / net_sales * 100 from public.sales_imports where location_id = v_loc and business_date = v_day and status = 'posted'), 1),
                       'daily theoretical food cost % = theoretical cost ÷ sales');

  v_to := (select max(business_date) from public.sales_imports where location_id = v_loc and status = 'posted' and extract(isodow from business_date) = 7);
  v_from := v_to - 6;
  v := app.period_report_data(v_loc, v_from, v_to, 'weekly');
  perform tests.assert((v ->> 'sales')::numeric = (select sum(net_sales) from public.sales_imports where location_id = v_loc and status = 'posted' and business_date between v_from and v_to),
                       'weekly sales = sum of the 7 days');
  select coalesce(sum(coalesce(invoice_total, (public.receipt_totals(id) ->> 'calculated_total')::numeric)), 0) into v_purch
    from public.receipts where location_id = v_loc and status = 'posted' and delivery_date between v_from and v_to;
  perform tests.assert((v ->> 'purchases')::numeric = v_purch, format('weekly purchases = posted invoices (%s)', v_purch));
  perform tests.assert((select sum((x ->> 'total')::numeric) from jsonb_array_elements(v -> 'vendor_spending') x) = v_purch, 'vendor spending adds up to purchases');
  perform tests.assert(v -> 'food_cost' ->> 'basis' = 'count_to_count', 'weekly food cost runs count to count (Sunday-night counts)');
  perform tests.assert((v -> 'food_cost' ->> 'actual_cost')::numeric = (v -> 'food_cost' ->> 'begin_inventory')::numeric + (v -> 'food_cost' ->> 'purchases')::numeric
                       + (v -> 'food_cost' ->> 'transfers')::numeric - (v -> 'food_cost' ->> 'end_inventory')::numeric, 'actual = begin + purchases + transfers - end');
  perform tests.assert((v ->> 'waste')::numeric = (select coalesce(sum(total_cost), 0) from public.waste_logs where location_id = v_loc and business_date between v_from and v_to),
                       'weekly waste = waste log');

  v := app.monthly_report_data(v_loc, current_date);
  perform tests.assert(v ? 'previous' and v ? 'weeks' and v ? 'price_trends', 'monthly report has month-over-month, weeks and price trends');

  -- ---------------------------------------------------------------- on-demand report: owners only
  perform tests.login(v_gm);
  begin
    perform public.generate_report_now(v_loc, 'weekly_report');
    perform tests.assert(false, 'gm generated');
  exception when insufficient_privilege then perform tests.assert(true, 'only owners generate reports on demand');
  end;
  perform tests.logout();
  perform tests.login(v_owner);
  v_id := public.generate_report_now(v_loc, 'weekly_report');
  perform tests.assert((select status from public.email_outbox where id = v_id) = 'pending', 'owner generates the weekly report now');
  perform tests.logout();

  -- ---------------------------------------------------------------- sender protocol is server-only
  perform tests.login(v_owner);
  begin
    perform * from public.claim_email_batch(5);
    perform tests.assert(false, 'user claimed');
  exception when insufficient_privilege then perform tests.assert(true, 'signed-in users cannot claim emails to send');
  end;
  begin
    perform public.run_email_schedule();
    perform tests.assert(false, 'user ran schedule');
  exception when insufficient_privilege then perform tests.assert(true, 'signed-in users cannot run the email schedule');
  end;
  perform tests.logout();

  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  perform set_config('role', 'service_role', true);
  select count(*) into v_n from public.claim_email_batch(500);
  perform tests.assert(v_n > 0, format('server job claims pending emails (%s)', v_n));
  perform tests.assert(not exists (select 1 from public.email_outbox where status = 'pending' and attempts < 5), 'claimed rows are no longer pending');
  select count(*) into v_n from public.claim_email_batch(500);
  perform tests.assert(v_n = 0, 'a second sender gets nothing (no double send)');
  perform public.complete_email(v_id, true, null, 'msg_123');
  perform tests.assert((select status from public.email_outbox where id = v_id) = 'sent', 'success recorded');
  select id into v_id2 from public.email_outbox where status = 'sending' limit 1;
  perform public.complete_email(v_id2, false, 'timeout', null);
  perform tests.assert((select status from public.email_outbox where id = v_id2) = 'pending', 'a failed send goes back to pending for retry');
  select id into v_id2 from public.email_outbox where status = 'sending' limit 1;
  perform public.complete_email(v_id2, false, '422 validation_error invalid to address', null, true);
  perform tests.assert((select status from public.email_outbox where id = v_id2) = 'failed', 'a permanent rejection fails at once (no retry storm)');
  v := public.run_email_schedule();
  v := public.run_email_schedule();
  perform tests.assert((v ->> 'queued')::int = 0, 'running the schedule again queues nothing new');
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', '', true);

  raise notice 'ALL EMAIL TESTS PASSED';
end $$;
rollback;
