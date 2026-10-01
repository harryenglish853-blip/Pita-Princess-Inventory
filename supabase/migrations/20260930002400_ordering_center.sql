-- =====================================================================
-- ORDERING CENTER: what to order from each vendor, when it must be
-- ordered, and a link to the vendor's own ordering website. Orders are
-- placed on the vendor's site (no vendor API/EDI needed); "Mark as ordered"
-- records a submitted purchase order so the quantity counts as incoming and
-- the delivery can be checked against it.
-- =====================================================================

-- Distributors (Sysco, Greco), the internal commissary, or anything else.
alter table public.vendors add column if not exists kind text not null default 'distributor'
  check (kind in ('distributor', 'commissary', 'other'));

-- Ordering links open in a new tab: only http(s) URLs (never javascript:, data:, …).
update public.vendors set order_website = null where order_website is not null and order_website !~* '^https?://[^\s]+$';
alter table public.vendors add constraint vendors_order_website_http check (order_website is null or order_website ~* '^https?://[^\s]+$');

-- Next delivery that can still be ordered, the order-by deadline and the one after.
-- A delivery on day D can be ordered until (D - lead time) at the cutoff time
-- (end of that day when no cutoff is set), in the store's time zone.
create or replace function app.vendor_order_window(p_location uuid, p_vendor uuid)
returns table (delivery_date date, order_by timestamptz, next_delivery_date date)
language plpgsql stable security definer set search_path = public as $$
declare
  s public.location_vendor_settings;
  v_tz text;
  v_now timestamp;
  d date;
  v_deadline timestamp;
begin
  select * into s from public.location_vendor_settings where location_id = p_location and vendor_id = p_vendor;
  select timezone into v_tz from public.locations where id = p_location;
  v_now := now() at time zone v_tz;
  for i in 0..21 loop
    d := v_now::date + i;
    continue when coalesce(array_length(s.delivery_days, 1), 0) > 0 and not (extract(dow from d)::smallint = any(s.delivery_days));
    v_deadline := (d - coalesce(s.lead_time_days, 1))::timestamp + coalesce(s.order_cutoff, time '23:59');
    if v_deadline > v_now then
      delivery_date := d;
      order_by := v_deadline at time zone v_tz;
      next_delivery_date := app.next_vendor_delivery(p_location, p_vendor, d);
      return next;
      return;
    end if;
  end loop;
end $$;

create or replace function public.vendor_order_schedule(p_location uuid)
returns table (vendor_id uuid, vendor_name text, kind text, order_website text, account_number text, minimum_order numeric,
               delivery_days smallint[], order_cutoff time, lead_time_days integer,
               delivery_date date, order_by timestamptz, next_delivery_date date,
               ordered_po_id uuid, ordered_po_number text, ordered_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
begin
  perform app.require_permission('orders.view', p_location);
  return query
  select s.vendor_id, s.vendor_name, v.kind, v.order_website, s.account_number, s.minimum_order,
         s.delivery_days, s.order_cutoff, s.lead_time_days,
         w.delivery_date, w.order_by, w.next_delivery_date,
         po.id, po.po_number, po.submitted_at
  from public.location_vendor_settings s
  join public.vendors v on v.id = s.vendor_id
  left join lateral app.vendor_order_window(p_location, s.vendor_id) w on true
  left join lateral (
    select p.id, p.po_number, p.submitted_at from public.purchase_orders p
    where p.location_id = p_location and p.vendor_id = s.vendor_id and p.expected_delivery_date = w.delivery_date
      and p.status not in ('draft', 'ready_to_submit', 'cancelled')
    order by p.submitted_at desc nulls last limit 1) po on true
  where s.location_id = p_location and s.active
  order by case v.kind when 'distributor' then 0 when 'commissary' then 1 else 2 end, s.vendor_name;
end $$;

select app.apply_grants();
