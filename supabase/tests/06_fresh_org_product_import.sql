-- A brand-new organization (how a real restaurant starts) and the product
-- spreadsheet import: preview writes nothing, import creates what's missing,
-- re-importing updates instead of duplicating, bad rows are skipped.
begin;
do $$
declare
  v_owner uuid; v_org uuid; v_loc uuid; v_r jsonb; v_rows jsonb; v_chicken public.products; v_n int;
begin
  v_owner := tests.create_user('newowner@pita.test', 'New Owner');
  perform tests.login(v_owner);
  v_org := public.create_organization('Pita Princess', 'Main Street', '1', 'America/Chicago');
  select id into v_loc from public.locations where organization_id = v_org;
  perform tests.assert(v_loc is not null, 'onboarding creates the organization and first location');
  perform tests.assert(not exists (select 1 from public.products where organization_id = v_org), 'new organization starts with no products');

  v_rows := jsonb_build_array(
    jsonb_build_object('name', 'Chicken Breast', 'category', 'Protein', 'count_unit', 'lbs', 'case_unit', 'cs', 'per_case', '40',
                       'vendor', 'Sysco', 'vendor_item_number', 'SY-1', 'case_price', '$131.50', 'storage_area', 'Walk-In Cooler', 'shelf', 'Shelf 2', 'par', '80'),
    jsonb_build_object('name', 'Pita Bread', 'category', 'Bakery', 'count_unit', 'each', 'case_unit', 'bag', 'per_case', '12',
                       'vendor', 'Local Bakery', 'case_price', '6.00', 'storage_area', 'Dry Storage'),
    jsonb_build_object('name', 'Napkins', 'category', 'Paper', 'type', 'Paper', 'count_unit', 'PK', 'storage_area', 'Dry Storage'),
    jsonb_build_object('name', 'Mystery Item', 'count_unit', 'furlongs'),
    jsonb_build_object('name', '', 'count_unit', 'EA'));

  -- Preview: full report, nothing saved
  v_r := public.import_products(v_loc, v_rows, false);
  perform tests.assert((v_r #>> '{summary,create}')::int = 3 and (v_r #>> '{summary,skip}')::int = 2, 'preview: 3 new, 2 skipped');
  perform tests.assert(v_r -> 'summary' -> 'vendors' ? 'Sysco' and v_r -> 'summary' -> 'storage_areas' ? 'Walk-In Cooler', 'preview lists vendors and storage areas it would create');
  perform tests.assert(v_r -> 'rows' -> 3 -> 'errors' ->> 0 like 'Unknown count unit%', 'unknown unit is explained');
  perform tests.assert(not exists (select 1 from public.products where organization_id = v_org), 'preview saved nothing');
  perform tests.assert(not exists (select 1 from public.vendors where organization_id = v_org), 'preview created no vendors');

  -- Import
  v_r := public.import_products(v_loc, v_rows, true);
  perform tests.assert((select count(*) from public.products where organization_id = v_org) = 3, 'three products imported');
  select * into v_chicken from public.products where organization_id = v_org and name = 'Chicken Breast';
  perform tests.assert((select code from public.units where id = v_chicken.inventory_unit_id) = 'LB', '"lbs" understood as LB');
  perform tests.assert(app.unit_factor(v_chicken.id, app.resolve_unit(v_org, 'CASE')) = 40, '1 CASE = 40 LB');
  perform tests.assert(v_chicken.standard_cost = round(131.50 / 40, 6), 'cost per LB from the case price ($3.2875)');
  perform tests.assert((select par_qty from public.location_products where location_id = v_loc and product_id = v_chicken.id) = 80, 'par set');
  perform tests.assert(exists (select 1 from public.vendor_products vp join public.vendors v on v.id = vp.vendor_id
                               where vp.product_id = v_chicken.id and v.name = 'Sysco' and vp.current_price = 131.50 and vp.vendor_item_number = 'SY-1'), 'vendor item and case price saved');
  perform tests.assert(exists (select 1 from public.product_storage_locations psl join public.storage_locations s on s.id = psl.storage_location_id
                               where psl.product_id = v_chicken.id and s.name = 'Walk-In Cooler' and s.kind = 'walk_in_cooler' and psl.shelf = 'Shelf 2'), 'placed in the walk-in on shelf 2');
  perform tests.assert((select cost_group from public.categories where organization_id = v_org and name = 'Paper') = 'paper', 'Paper category is not counted as food');
  perform tests.assert((select count(*) from public.storage_locations where location_id = v_loc and name = 'Dry Storage') = 1, 'one Dry Storage area even though two rows use it');
  perform tests.assert(exists (select 1 from public.audit_logs where entity_type = 'products' and action = 'import' and organization_id = v_org), 'import is audited');

  -- Re-import with a new price: update, no duplicates
  v_rows := jsonb_build_array(jsonb_build_object('name', 'chicken breast', 'count_unit', 'LB', 'case_unit', 'CASE', 'per_case', '40',
                                                 'vendor', 'Sysco', 'vendor_item_number', 'SY-1', 'case_price', '135.00'));
  v_r := public.import_products(v_loc, v_rows, true);
  perform tests.assert((v_r #>> '{summary,update}')::int = 1 and (v_r #>> '{summary,create}')::int = 0, 're-import updates the existing product');
  perform tests.assert((select count(*) from public.products where organization_id = v_org and lower(name) = 'chicken breast') = 1, 'no duplicate product');
  perform tests.assert((select current_price from public.vendor_products where product_id = v_chicken.id and vendor_item_number = 'SY-1') = 135.00, 'price updated');

  -- The imported items can be counted right away
  select count(*) into v_n from public.current_inventory where location_id = v_loc;
  perform tests.assert(v_n = 3, 'imported items appear in inventory');
  perform tests.logout();

  raise notice 'ALL FRESH ORGANIZATION AND PRODUCT IMPORT TESTS PASSED';
end $$;
rollback;
