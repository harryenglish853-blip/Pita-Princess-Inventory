-- =====================================================================
-- Per-store vendor settings. The company sets a vendor's delivery days,
-- lead time, cutoff and account number; a store can override any of them
-- (e.g. Westside gets Sysco Tue/Fri on its own account) or stop using the
-- vendor. Blank override fields fall back to the company value.
-- =====================================================================
alter table public.location_vendors add column if not exists notes text;

create trigger trg_location_vendors_audit after insert or update or delete on public.location_vendors
  for each row execute function app.audit_row();

-- Effective schedule per store and vendor: what ordering screens use.
create or replace view public.location_vendor_settings with (security_invoker = true) as
select l.id as location_id, v.id as vendor_id, v.organization_id, v.name as vendor_name,
       coalesce(lv.delivery_days, v.delivery_days) as delivery_days,
       coalesce(lv.lead_time_days, v.lead_time_days) as lead_time_days,
       coalesce(lv.order_cutoff, v.order_cutoff) as order_cutoff,
       coalesce(lv.account_number, v.account_number) as account_number,
       v.minimum_order, v.ordering_email, v.active as company_active,
       (v.active and coalesce(lv.active, true)) as active,
       lv.id is not null as has_override,
       lv.delivery_days is not null as delivery_days_overridden,
       lv.lead_time_days is not null as lead_time_overridden,
       lv.order_cutoff is not null as cutoff_overridden,
       lv.account_number is not null as account_overridden
from public.locations l
join public.vendors v on v.organization_id = l.organization_id
left join public.location_vendors lv on lv.location_id = l.id and lv.vendor_id = v.id;

-- Dynamic pars honor the store's lead time as well as its delivery days.
create or replace function public.refresh_dynamic_pars(p_location uuid) returns integer
language plpgsql security definer set search_path = public as $$
declare r record; v_days int; v_par numeric; n int := 0;
begin
  perform app.require_permission('inventory.view', p_location);
  for r in
    select lp.id, lp.product_id, lp.safety_stock_days,
           coalesce(lv.lead_time_days, v.lead_time_days, 1) as lead, coalesce(array_length(coalesce(lv.delivery_days, v.delivery_days), 1), 1) as deliveries
    from public.location_products lp
    join public.products p on p.id = lp.product_id
    left join public.vendors v on v.id = coalesce(lp.local_vendor_id, p.default_vendor_id)
    left join public.location_vendors lv on lv.vendor_id = v.id and lv.location_id = p_location
    where lp.location_id = p_location and lp.par_mode = 'dynamic' and lp.active
  loop
    v_days := r.lead + ceil(7.0 / greatest(r.deliveries, 1))::int;
    v_par := (app.forecast_usage(p_location, r.product_id, current_date, current_date + v_days) ->> 'qty')::numeric
             + coalesce(r.safety_stock_days, 0) * app.avg_daily_usage(p_location, r.product_id, 28);
    update public.location_products set dynamic_par_qty = round(v_par, 2), dynamic_par_at = now() where id = r.id;
    n := n + 1;
  end loop;
  return n;
end $$;

select app.apply_grants();
