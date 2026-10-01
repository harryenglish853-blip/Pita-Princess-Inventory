-- =====================================================================
-- Product import from a spreadsheet. One function validates and applies
-- every row; with p_apply = false it runs the same code inside a
-- savepoint and rolls it back, so the preview shows exactly what an
-- import would do. Missing categories, vendors and storage areas are
-- created. Existing products (same item # or same name) are updated, never
-- duplicated, and their count unit is never changed (the ledger is stored
-- in it). Rows with problems are skipped and reported.
-- =====================================================================

-- Unit lookup that accepts what people type: "lbs", "Pounds", "each", "cs", "fl oz".
create or replace function app.resolve_unit(p_org uuid, p_text text) returns uuid
language plpgsql stable security definer set search_path = public as $$
declare
  t text := upper(regexp_replace(btrim(coalesce(p_text, '')), '[.]', '', 'g'));
  v uuid;
begin
  if t = '' then return null; end if;
  t := case
    when t in ('LBS', 'POUND', 'POUNDS', '#') then 'LB'
    when t in ('OUNCE', 'OUNCES', 'OZS') then 'OZ'
    when t in ('EACH', 'EAS', 'CT', 'COUNT', 'PC', 'PCS', 'PIECE', 'PIECES', 'UNIT', 'UNITS') then 'EA'
    when t in ('CS', 'CASES', 'CA') then 'CASE'
    when t in ('GALLON', 'GALLONS', 'GALS') then 'GAL'
    when t in ('QUART', 'QUARTS', 'QTS') then 'QT'
    when t in ('PINT', 'PINTS', 'PTS') then 'PT'
    when t in ('CUPS') then 'CUP'
    when t in ('FLOZ', 'FL-OZ', 'FLUID OUNCE', 'FLUID OUNCES') then 'FL OZ'
    when t in ('KILO', 'KILOS', 'KILOGRAM', 'KILOGRAMS', 'KGS') then 'KG'
    when t in ('GRAM', 'GRAMS', 'GR') then 'G'
    when t in ('LITER', 'LITERS', 'LITRE', 'LITRES', 'LT') then 'L'
    when t in ('MILLILITER', 'MILLILITERS', 'MLS') then 'ML'
    when t in ('DOZEN', 'DOZ') then 'DZ'
    when t in ('BAGS', 'BG') then 'BAG'
    when t in ('BOXES', 'BX') then 'BOX'
    when t in ('CARTON', 'CARTONS') then 'CTN'
    when t in ('PACK', 'PACKS', 'PKG', 'PACKAGE') then 'PK'
    when t in ('BOTTLE', 'BOTTLES', 'BTLS') then 'BTL'
    when t in ('CANS') then 'CAN'
    when t in ('JUGS') then 'JUG'
    when t in ('KEGS') then 'KEG'
    when t in ('SLEEVES', 'SLV') then 'SLEEVE'
    when t in ('TUBS') then 'TUB'
    when t in ('BUNCHES') then 'BUNCH'
    when t in ('ROLLS') then 'ROLL'
    when t in ('PANS') then 'PAN'
    else t end;
  select id into v from public.units
   where upper(code) = t and (organization_id = p_org or organization_id is null) and active
   order by organization_id nulls last limit 1;
  return v;
end $$;

-- Guess a storage kind from its name (used when the import creates the area).
create or replace function app.guess_storage_kind(p_name text) returns public.storage_kind
language sql immutable as $$
  select case
    when p_name ~* 'freez' then 'walk_in_freezer'
    when p_name ~* 'walk.?in|cooler|fridge|refrig' then 'walk_in_cooler'
    when p_name ~* 'dry|pantry|shelf' then 'dry_storage'
    when p_name ~* 'bar|liquor|beer|wine' then 'bar'
    when p_name ~* 'chem|clean|janitor' then 'chemical'
    when p_name ~* 'line' then 'line'
    when p_name ~* 'prep' then 'prep'
    when p_name ~* 'front|foh' then 'front'
    else 'other' end::public.storage_kind
$$;

-- p_rows: [{name, item_number, category, type, count_unit, case_unit, per_case, vendor, vendor_item_number,
--           case_price, storage_area, shelf, par, upc}]   (strings; blanks allowed except name and count_unit)
create or replace function app.import_products_apply(p_location uuid, p_rows jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_org uuid := app.location_org(p_location);
  r jsonb; i int := 0;
  v_name text; v_num text; v_errors text[]; v_warn text[]; v_action text;
  v_inv uuid; v_case uuid; v_per numeric; v_price numeric; v_par numeric;
  v_cat uuid; v_vendor uuid; v_storage uuid; v_prod public.products; v_type text; v_vin text;
  v_out jsonb := '[]'::jsonb;
  v_new int := 0; v_upd int := 0; v_skip int := 0;
  v_cats text[] := '{}'; v_vendors text[] := '{}'; v_areas text[] := '{}';
  v_next int;
begin
  select coalesce(max(nullif(regexp_replace(product_number, '\D', '', 'g'), '')::bigint), 1000)::int
    into v_next from public.products where organization_id = v_org and product_number ~ '^\d{1,9}$';

  for r in select * from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) loop
    i := i + 1;
    v_errors := '{}'; v_warn := '{}'; v_action := null;
    v_name := btrim(coalesce(r ->> 'name', ''));
    v_num := nullif(btrim(coalesce(r ->> 'item_number', '')), '');
    v_inv := app.resolve_unit(v_org, r ->> 'count_unit');
    v_case := app.resolve_unit(v_org, coalesce(nullif(btrim(r ->> 'case_unit'), ''), case when nullif(btrim(r ->> 'per_case'), '') is not null then 'CASE' end));
    v_type := lower(coalesce(nullif(btrim(r ->> 'type'), ''), 'food'));

    if v_name = '' then v_errors := array_append(v_errors, 'Item name is missing'); end if;
    if coalesce(btrim(r ->> 'count_unit'), '') = '' then v_errors := array_append(v_errors, 'Count unit is missing (e.g. LB, EA, OZ)');
    elsif v_inv is null then v_errors := array_append(v_errors, format('Unknown count unit "%s"', r ->> 'count_unit')); end if;
    if nullif(btrim(r ->> 'case_unit'), '') is not null and v_case is null then v_errors := array_append(v_errors, format('Unknown case unit "%s"', r ->> 'case_unit')); end if;
    begin v_per := nullif(regexp_replace(coalesce(r ->> 'per_case', ''), '[^0-9.]', '', 'g'), '')::numeric;
    exception when others then v_errors := array_append(v_errors, 'Per case is not a number'); v_per := null; end;
    begin v_price := nullif(regexp_replace(coalesce(r ->> 'case_price', ''), '[^0-9.]', '', 'g'), '')::numeric;
    exception when others then v_errors := array_append(v_errors, 'Case price is not a number'); v_price := null; end;
    begin v_par := nullif(regexp_replace(coalesce(r ->> 'par', ''), '[^0-9.]', '', 'g'), '')::numeric;
    exception when others then v_errors := array_append(v_errors, 'Par is not a number'); v_par := null; end;
    if v_per is not null and v_per <= 0 then v_errors := array_append(v_errors, 'Per case must be more than 0'); end if;
    if v_case is not null and v_case = v_inv then v_case := null; v_per := null; end if;
    if v_case is not null and v_per is null then v_errors := array_append(v_errors, 'Say how many count units are in one case (Per case)'); end if;
    if v_type not in ('food', 'beverage', 'alcohol', 'paper', 'supplies', 'other') then
      v_warn := array_append(v_warn, format('Type "%s" not recognised, using Food', r ->> 'type')); v_type := 'food';
    end if;

    if cardinality(v_errors) > 0 then
      v_skip := v_skip + 1;
      v_out := v_out || jsonb_build_object('row', i, 'name', v_name, 'action', 'skip', 'errors', to_jsonb(v_errors), 'warnings', to_jsonb(v_warn));
      continue;
    end if;

    -- Category (top level), vendor, storage area: create when missing
    v_cat := null;
    if nullif(btrim(r ->> 'category'), '') is not null then
      select id into v_cat from public.categories where organization_id = v_org and parent_id is null and lower(name) = lower(btrim(r ->> 'category'));
      if v_cat is null then
        insert into public.categories (organization_id, name, level, cost_group, is_food)
        values (v_org, btrim(r ->> 'category'), 1, v_type, v_type = 'food') returning id into v_cat;
        v_cats := array_append(v_cats, btrim(r ->> 'category'));
      end if;
    end if;
    v_vendor := null;
    if nullif(btrim(r ->> 'vendor'), '') is not null then
      select id into v_vendor from public.vendors where organization_id = v_org and lower(name) = lower(btrim(r ->> 'vendor'));
      if v_vendor is null then
        insert into public.vendors (organization_id, name) values (v_org, btrim(r ->> 'vendor')) returning id into v_vendor;
        v_vendors := array_append(v_vendors, btrim(r ->> 'vendor'));
      end if;
    end if;
    v_storage := null;
    if nullif(btrim(r ->> 'storage_area'), '') is not null then
      select id into v_storage from public.storage_locations where location_id = p_location and lower(name) = lower(btrim(r ->> 'storage_area'));
      if v_storage is null then
        insert into public.storage_locations (organization_id, location_id, name, kind, sort_order)
        values (v_org, p_location, btrim(r ->> 'storage_area'), app.guess_storage_kind(r ->> 'storage_area'),
                coalesce((select max(sort_order) + 1 from public.storage_locations where location_id = p_location), 1))
        returning id into v_storage;
        v_areas := array_append(v_areas, btrim(r ->> 'storage_area'));
      end if;
    end if;

    -- Existing product: same item #, else same name
    v_prod := null;
    if v_num is not null then select * into v_prod from public.products where organization_id = v_org and product_number = v_num and deleted_at is null; end if;
    if v_prod.id is null then select * into v_prod from public.products where organization_id = v_org and lower(name) = lower(v_name) and deleted_at is null limit 1; end if;

    if v_prod.id is null then
      if v_num is null then
        loop
          v_next := v_next + 1;
          exit when not exists (select 1 from public.products where organization_id = v_org and product_number = v_next::text);
        end loop;
        v_num := v_next::text;
      end if;
      insert into public.products (organization_id, product_number, name, category_id, inventory_unit_id, purchase_unit_id, default_vendor_id, standard_cost, created_by)
      values (v_org, v_num, v_name, v_cat, v_inv, coalesce(v_case, v_inv), v_vendor,
              case when v_price is not null then round(v_price / coalesce(v_per, 1), 6) end, auth.uid())
      returning * into v_prod;
      v_action := 'create'; v_new := v_new + 1;
    else
      if v_prod.inventory_unit_id <> v_inv then
        v_warn := array_append(v_warn, format('Already counted in %s; count unit left unchanged', (select code from public.units where id = v_prod.inventory_unit_id)));
      end if;
      update public.products set
        category_id = coalesce(v_cat, category_id),
        default_vendor_id = coalesce(v_vendor, default_vendor_id),
        purchase_unit_id = case when v_prod.inventory_unit_id = v_inv then coalesce(v_case, purchase_unit_id) else purchase_unit_id end
      where id = v_prod.id;
      v_action := 'update'; v_upd := v_upd + 1;
    end if;

    -- Case size (only when the count unit matches, so the factor means what the sheet says)
    if v_case is not null and v_prod.inventory_unit_id = v_inv then
      insert into public.product_units (organization_id, product_id, unit_id, factor, use_for_count, use_for_purchase)
      values (v_org, v_prod.id, v_case, v_per, true, true)
      on conflict (product_id, unit_id) do update set factor = excluded.factor, use_for_purchase = true;
    end if;

    -- Vendor item and price (per case, or per count unit when there is no case)
    if v_vendor is not null then
      v_vin := coalesce(nullif(btrim(r ->> 'vendor_item_number'), ''), v_prod.product_number);
      insert into public.vendor_products (organization_id, vendor_id, product_id, vendor_item_number, purchase_unit_id, pack_size, current_price, is_preferred)
      values (v_org, v_vendor, v_prod.id, v_vin, coalesce(case when v_prod.inventory_unit_id = v_inv then v_case end, v_prod.inventory_unit_id),
              case when v_per is not null then format('%s %s', trim_scale(v_per), (select code from public.units where id = v_prod.inventory_unit_id)) end,
              coalesce(v_price, 0), true)
      on conflict (vendor_id, vendor_item_number) do update set
        current_price = case when v_price is not null then excluded.current_price else vendor_products.current_price end,
        pack_size = coalesce(excluded.pack_size, vendor_products.pack_size),
        purchase_unit_id = excluded.purchase_unit_id
      where vendor_products.product_id = excluded.product_id;
      if not exists (select 1 from public.vendor_products where vendor_id = v_vendor and vendor_item_number = v_vin and product_id = v_prod.id) then
        v_warn := array_append(v_warn, format('Vendor item # %s is already used by another product; vendor link skipped', v_vin));
      end if;
    end if;

    if nullif(btrim(r ->> 'upc'), '') is not null then
      insert into public.product_barcodes (organization_id, product_id, barcode, unit_id, created_by)
      values (v_org, v_prod.id, btrim(r ->> 'upc'), null, auth.uid()) on conflict do nothing;
    end if;

    if v_storage is not null then
      insert into public.product_storage_locations (organization_id, location_id, product_id, storage_location_id, shelf, sort_order)
      values (v_org, p_location, v_prod.id, v_storage, nullif(btrim(r ->> 'shelf'), ''),
              coalesce((select max(sort_order) + 1 from public.product_storage_locations where storage_location_id = v_storage), 1))
      on conflict (storage_location_id, product_id) do update set shelf = coalesce(excluded.shelf, product_storage_locations.shelf), active = true;
    end if;

    if v_par is not null then
      update public.location_products set par_qty = v_par where location_id = p_location and product_id = v_prod.id;
    end if;

    v_out := v_out || jsonb_build_object('row', i, 'name', v_name, 'item_number', v_prod.product_number, 'action', v_action,
                                         'errors', '[]'::jsonb, 'warnings', to_jsonb(v_warn));
  end loop;

  return jsonb_build_object(
    'summary', jsonb_build_object('create', v_new, 'update', v_upd, 'skip', v_skip,
      'categories', to_jsonb(v_cats), 'vendors', to_jsonb(v_vendors), 'storage_areas', to_jsonb(v_areas)),
    'rows', v_out);
end $$;
revoke all on function app.import_products_apply(uuid, jsonb) from public;

create or replace function public.import_products(p_location uuid, p_rows jsonb, p_apply boolean default false) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_result jsonb; v_org uuid := app.location_org(p_location);
begin
  perform app.require_org_permission('products.edit', v_org);
  perform app.require_permission('inventory.settings', p_location);
  if jsonb_array_length(coalesce(p_rows, '[]'::jsonb)) > 5000 then raise exception 'Import at most 5,000 rows at a time' using errcode = 'P0001'; end if;
  begin
    v_result := app.import_products_apply(p_location, p_rows);
    if not p_apply then raise exception 'preview' using errcode = 'P0099'; end if;
  exception when sqlstate 'P0099' then
    null;  -- preview: every change above is rolled back, the report is kept
  end;
  if p_apply then
    perform app.audit(v_org, p_location, 'import', 'products', null,
      format('Imported products: %s new, %s updated, %s skipped', v_result #>> '{summary,create}', v_result #>> '{summary,update}', v_result #>> '{summary,skip}'),
      null, v_result -> 'summary');
  end if;
  return v_result || jsonb_build_object('applied', p_apply);
end $$;

select app.apply_grants();
