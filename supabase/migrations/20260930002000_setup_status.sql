-- =====================================================================
-- Getting-started checklist: what a store has set up so far, in one call.
-- =====================================================================
create or replace function public.setup_status(p_location uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_org uuid := app.location_org(p_location);
begin
  if not (p_location in (select app.user_location_ids())) then raise exception 'Location not found' using errcode = '42501'; end if;
  return jsonb_build_object(
    'address',        (select address_line1 is not null and btrim(address_line1) <> '' from public.locations where id = p_location),
    'storage_areas',  (select count(*) from public.storage_locations where location_id = p_location and active),
    'vendors',        (select count(*) from public.vendors where organization_id = v_org and active),
    'products',       (select count(*) from public.products where organization_id = v_org and active and deleted_at is null),
    'products_placed',(select count(distinct psl.product_id) from public.product_storage_locations psl
                         join public.products p on p.id = psl.product_id
                        where psl.location_id = p_location and psl.active and p.active and p.deleted_at is null),
    'staff',          (select count(*) from public.organization_members where organization_id = v_org and active),
    'counts_posted',  (select count(*) from public.count_sessions where location_id = p_location and status = 'posted'),
    'deliveries',     (select count(*) from public.receipts where location_id = p_location and status = 'posted'),
    'recipes',        (select count(*) from public.recipes where organization_id = v_org and active),
    'menu_items',     (select count(*) from public.menu_items where organization_id = v_org and active and pos_item_id is not null),
    'sales_days',     (select count(*) from public.sales_imports where location_id = p_location and status = 'posted'));
end $$;

select app.apply_grants();
