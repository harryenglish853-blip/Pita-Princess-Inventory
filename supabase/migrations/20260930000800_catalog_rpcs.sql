-- =====================================================================
-- Catalog RPCs: atomic product creation, stock card, global search
-- =====================================================================

-- Creates a product with its purchase conversion, optional vendor item,
-- storage placement and local par in one transaction.
-- p: {product_number, name, description, category_id, inventory_unit_id, recipe_unit_id, purchase_unit_id,
--     purchase_factor, count_unit_id, count_factor, brand, sku, manufacturer_number, default_vendor_id,
--     vendor_item_number, vendor_price, pack_size, shelf_life_days, lot_tracked, expiration_tracked, catch_weight,
--     taxable, gl_account, receiving_temp_min, receiving_temp_max, notes, storage_location_id, shelf, par_qty,
--     location_id, standard_cost, upc}
create or replace function public.create_product(p jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_loc uuid := (p ->> 'location_id')::uuid;
  v_org uuid := app.location_org((p ->> 'location_id')::uuid);
  v_id uuid;
  v_inv uuid := (p ->> 'inventory_unit_id')::uuid;
  v_pu uuid := nullif(p ->> 'purchase_unit_id', '')::uuid;
  v_cu uuid := nullif(p ->> 'count_unit_id', '')::uuid;
  v_vendor uuid := nullif(p ->> 'default_vendor_id', '')::uuid;
begin
  perform app.require_org_permission('products.edit', v_org);
  if coalesce(btrim(p ->> 'name'), '') = '' or coalesce(btrim(p ->> 'product_number'), '') = '' then
    raise exception 'Product number and name are required';
  end if;
  insert into public.products (organization_id, product_number, name, description, category_id, inventory_unit_id, recipe_unit_id,
      purchase_unit_id, sku, brand, manufacturer_number, default_vendor_id, standard_cost, shelf_life_days, lot_tracked, expiration_tracked,
      catch_weight, taxable, gl_account, receiving_temp_min, receiving_temp_max, notes, is_prepped, created_by)
  values (v_org, btrim(p ->> 'product_number'), btrim(p ->> 'name'), nullif(p ->> 'description', ''), nullif(p ->> 'category_id', '')::uuid,
      v_inv, nullif(p ->> 'recipe_unit_id', '')::uuid, v_pu, nullif(p ->> 'sku', ''), nullif(p ->> 'brand', ''),
      nullif(p ->> 'manufacturer_number', ''), v_vendor, nullif(p ->> 'standard_cost', '')::numeric, nullif(p ->> 'shelf_life_days', '')::int,
      coalesce((p ->> 'lot_tracked')::boolean, false), coalesce((p ->> 'expiration_tracked')::boolean, false),
      coalesce((p ->> 'catch_weight')::boolean, false), coalesce((p ->> 'taxable')::boolean, false), nullif(p ->> 'gl_account', ''),
      nullif(p ->> 'receiving_temp_min', '')::numeric, nullif(p ->> 'receiving_temp_max', '')::numeric, nullif(p ->> 'notes', ''),
      coalesce((p ->> 'is_prepped')::boolean, false), auth.uid())
  returning id into v_id;

  if v_pu is not null and v_pu <> v_inv and nullif(p ->> 'purchase_factor', '') is not null then
    insert into public.product_units (organization_id, product_id, unit_id, factor, use_for_count, use_for_purchase, label)
    values (v_org, v_id, v_pu, (p ->> 'purchase_factor')::numeric, true, true, nullif(p ->> 'pack_size', ''));
  end if;
  if v_cu is not null and v_cu <> v_inv and v_cu is distinct from v_pu and nullif(p ->> 'count_factor', '') is not null then
    insert into public.product_units (organization_id, product_id, unit_id, factor, use_for_count)
    values (v_org, v_id, v_cu, (p ->> 'count_factor')::numeric, true);
  end if;

  if v_vendor is not null and nullif(p ->> 'vendor_item_number', '') is not null then
    insert into public.vendor_products (organization_id, vendor_id, product_id, vendor_item_number, purchase_unit_id, pack_size, current_price, is_preferred)
    values (v_org, v_vendor, v_id, btrim(p ->> 'vendor_item_number'), coalesce(v_pu, v_inv), nullif(p ->> 'pack_size', ''),
            coalesce(nullif(p ->> 'vendor_price', '')::numeric, 0), true);
  end if;

  if nullif(p ->> 'upc', '') is not null then
    insert into public.product_barcodes (organization_id, product_id, barcode, unit_id, created_by)
    values (v_org, v_id, btrim(p ->> 'upc'), null, auth.uid());
  end if;

  if nullif(p ->> 'storage_location_id', '') is not null then
    if not exists (select 1 from public.storage_locations where id = (p ->> 'storage_location_id')::uuid and location_id = v_loc) then
      raise exception 'Storage area does not belong to this location';
    end if;
    insert into public.product_storage_locations (organization_id, location_id, product_id, storage_location_id, shelf, sort_order)
    values (v_org, v_loc, v_id, (p ->> 'storage_location_id')::uuid, nullif(p ->> 'shelf', ''),
            coalesce((select max(sort_order) + 1 from public.product_storage_locations where storage_location_id = (p ->> 'storage_location_id')::uuid), 1));
  end if;
  if nullif(p ->> 'par_qty', '') is not null then
    update public.location_products set par_qty = (p ->> 'par_qty')::numeric where location_id = v_loc and product_id = v_id;
  end if;
  return v_id;
end $$;

-- Stock card: every ledger movement with running quantity and value.
create or replace function public.stock_card(p_location uuid, p_product uuid, p_from timestamptz, p_to timestamptz)
returns table (
  id bigint, txn_at timestamptz, business_date date, txn_type public.inv_txn_type, quantity numeric, unit_cost numeric,
  extended_cost numeric, running_qty numeric, running_value numeric, reference text, source_type text, source_id uuid,
  storage_name text, reason_code text, notes text, created_by_name text, is_opening boolean
)
language sql stable security definer set search_path = public as $$
  with allowed as (select 1 where p_location in (select app.user_location_ids())),
  opening as (
    select coalesce(sum(t.quantity), 0) as qty, coalesce(sum(t.extended_cost), 0) as val
    from public.inventory_transactions t, allowed
    where t.location_id = p_location and t.product_id = p_product and t.txn_at < p_from
  ),
  mv as (
    select t.*, s.name as storage_name, pr.full_name
    from public.inventory_transactions t
    cross join allowed
    left join public.storage_locations s on s.id = t.storage_location_id
    left join public.profiles pr on pr.id = t.created_by
    where t.location_id = p_location and t.product_id = p_product and t.txn_at >= p_from and t.txn_at <= p_to
  )
  select null::bigint, p_from, null::date, 'BEGINNING'::public.inv_txn_type, o.qty, case when o.qty <> 0 then round(o.val / o.qty, 6) else 0 end,
         o.val, o.qty, o.val, 'Opening balance', null, null, null, null, null, null, true
  from opening o, allowed
  union all
  select m.id, m.txn_at, m.business_date, m.txn_type, m.quantity, m.unit_cost, m.extended_cost,
         (select qty from opening) + sum(m.quantity) over (order by m.txn_at, m.id),
         (select val from opening) + sum(m.extended_cost) over (order by m.txn_at, m.id),
         m.reference, m.source_type, m.source_id, m.storage_name, m.reason_code, m.notes, m.full_name, false
  from mv m
  order by 2, 1 nulls first
$$;

-- Global search across the operational records a user can see.
create or replace function public.global_search(p_q text, p_location uuid)
returns table (kind text, id uuid, title text, subtitle text, href text)
language plpgsql stable security definer set search_path = public as $$
declare v_q text := btrim(coalesce(p_q, ''));
begin
  if length(v_q) < 2 or not (p_location in (select app.user_location_ids())) then return; end if;
  return query
  (select 'Product', pr.id, pr.name, concat_ws(' · ', '#' || pr.product_number, pr.sku, pr.brand), '/inventory/items/' || pr.id
   from public.products pr
   where pr.organization_id = app.location_org(p_location) and pr.deleted_at is null
     and (pr.name ilike '%' || v_q || '%' or pr.product_number ilike v_q || '%' or pr.sku ilike '%' || v_q || '%' or pr.manufacturer_number ilike v_q
          or exists (select 1 from public.product_barcodes b where b.product_id = pr.id and b.barcode = v_q)
          or exists (select 1 from public.vendor_products vp where vp.product_id = pr.id and vp.vendor_item_number ilike v_q || '%'))
   order by extensions.similarity(pr.name, v_q) desc limit 15)
  union all
  (select 'Vendor', v.id, v.name, concat_ws(' · ', v.vendor_number, v.account_number), '/vendors/' || v.id
   from public.vendors v where v.organization_id = app.location_org(p_location) and (v.name ilike '%' || v_q || '%' or v.vendor_number ilike v_q || '%') limit 5)
  union all
  (select 'Purchase order', po.id, po.po_number, concat_ws(' · ', v.name, po.status::text, po.expected_delivery_date::text), '/purchasing/' || po.id
   from public.purchase_orders po join public.vendors v on v.id = po.vendor_id
   where po.location_id = p_location and (po.po_number ilike '%' || v_q || '%' or po.confirmation_number ilike v_q) limit 10)
  union all
  (select 'Invoice / receipt', r.id, coalesce(r.invoice_number, r.receipt_number), concat_ws(' · ', v.name, r.receipt_number, r.status::text), '/receiving/' || r.id
   from public.receipts r join public.vendors v on v.id = r.vendor_id
   where r.location_id = p_location and (r.invoice_number ilike '%' || v_q || '%' or r.receipt_number ilike '%' || v_q || '%') limit 10)
  union all
  (select 'Count', c.id, c.name, concat_ws(' · ', c.count_number, c.status::text), '/counts/' || c.id || '/review'
   from public.count_sessions c where c.location_id = p_location and (c.count_number ilike '%' || v_q || '%' or c.name ilike '%' || v_q || '%') limit 5)
  union all
  (select 'Lot', l.id, l.lot_number, concat_ws(' · ', pr.name, l.traceability_lot_code), '/reports?r=lots&q=' || l.lot_number
   from public.lots l join public.products pr on pr.id = l.product_id
   where l.organization_id = app.location_org(p_location) and (l.lot_number ilike '%' || v_q || '%' or l.traceability_lot_code ilike '%' || v_q || '%') limit 5)
  union all
  (select 'Location', loc.id, '#' || loc.code || ' ' || loc.name, concat_ws(', ', loc.city, loc.state), '/admin/locations/' || loc.id
   from public.locations loc where loc.id in (select app.user_location_ids()) and (loc.name ilike '%' || v_q || '%' or loc.code ilike v_q || '%') limit 5)
  union all
  (select 'Transaction', t.txn_uid, t.txn_type::text || ' ' || t.quantity::text, concat_ws(' · ', pr.name, t.reference, t.business_date::text), '/inventory/items/' || t.product_id || '?tab=stock'
   from public.inventory_transactions t join public.products pr on pr.id = t.product_id
   where t.location_id = p_location and (t.reference ilike v_q or (v_q ~ '^\d+$' and t.id = v_q::bigint)) limit 5);
end $$;

select app.apply_grants();
