-- =====================================================================
-- DEMO ENVIRONMENT — "Demo Restaurant #101"
-- Every quantity, cost and variance below is produced by calling the same
-- database functions the app uses (receipts, counts, orders), impersonating
-- demo users, so all KPIs trace back to real ledger transactions.
-- Demo logins (password: Demo1234!):
--   owner@example.com (System Owner)       gm@example.com (General Manager #101)
--   kitchen@example.com (Kitchen Manager)  maria@example.com / john@example.com / carlos@example.com (Employees)
--   accounting@example.com (Accounting)    regional@example.com (Regional Manager)
--   owner2@example.com (second System Owner)        commissary@example.com (Kitchen Manager, Central Kitchen C1)
--   employee@example.com (SHARED employee login: pick John 2580, Maria 3691, Carlos 4826 or Alex 5937)
-- Do NOT run this against a production database.
-- =====================================================================
create extension if not exists pgcrypto with schema extensions;

create schema if not exists seed;

create or replace function seed.user(p_email text, p_name text) returns uuid
language plpgsql as $$
declare v uuid;
begin
  select id into v from auth.users where email = p_email;
  if v is not null then return v; end if;
  v := gen_random_uuid();
  insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
                          created_at, updated_at, confirmation_token, recovery_token, email_change_token_new, email_change)
  values ('00000000-0000-0000-0000-000000000000', v, 'authenticated', 'authenticated', p_email,
          extensions.crypt('Demo1234!', extensions.gen_salt('bf')), now(),
          '{"provider":"email","providers":["email"]}', jsonb_build_object('full_name', p_name), now(), now(), '', '', '', '');
  insert into auth.identities (provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
  values (v::text, v, jsonb_build_object('sub', v::text, 'email', p_email, 'email_verified', true), 'email', now(), now(), now());
  return v;
end $$;

create or replace function seed.as_user(p_user uuid) returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;

create or replace function seed.as_admin() returns void
language plpgsql as $$
begin
  perform set_config('role', 'postgres', true);
end $$;

-- deterministic pseudo-random in [0,1) so the demo is reproducible
create or replace function seed.rnd(p_key text) returns numeric
language sql immutable as $$ select (('x' || substr(md5(p_key), 1, 8))::bit(32)::bigint % 10000)::numeric / 10000 $$;

-- One day of POS sales from the menu mix: weekday pattern + deterministic noise.
create or replace function seed.import_day(p_org uuid, p_loc uuid, p_day date) returns void
language plpgsql as $$
declare v_lines jsonb; f numeric := (array[1.10, 0.85, 0.85, 0.90, 1.00, 1.35, 1.45])[extract(dow from p_day)::int + 1];
begin
  select jsonb_agg(jsonb_build_object('pos_item_id', mi.pos_item_id, 'item_name', mi.name, 'quantity', q, 'net_sales', round(q * mi.selling_price, 2)))
    into v_lines
  from (select mi.*, greatest(0, round(sr.weekly / 7.5 * f * (0.9 + seed.rnd(mi.name || p_day) * 0.2))) as q
        from public.menu_items mi join seed_recipes sr on sr.name = mi.name where mi.organization_id = p_org) mi;
  perform public.import_sales(p_loc, p_day, 'toast', 'toast-' || p_day || '.csv',
    jsonb_build_object('guest_count', round(260 * f), 'check_count', round(175 * f)), v_lines);
end $$;

grant usage on schema seed to authenticated;
grant execute on all functions in schema seed to authenticated;

-- Product catalog spec for the demo
create temporary table seed_products (
  num text, name text, cat text, sub text, inv_unit text, recipe_unit text,
  pu text, pu_factor numeric, alt_unit text, alt_factor numeric,
  vendor text, sku text, pack text, price numeric,
  weekly_usage numeric, par numeric, storage text, shelf text, line_storage boolean,
  temp_max numeric, daily boolean, price_path numeric[]
) on commit drop;

insert into seed_products values
 ('1001','Chicken Breast, Boneless','Food','Protein','LB','OZ','CASE',40,null,null,'Greco','48219','4/10 LB',128.00,95,110,'Walk-In Cooler','Shelf 2',true,41,true,'{0.856,0.878,0.925,1}'),
 ('1002','Ground Beef 80/20','Food','Protein','LB','OZ','CASE',20,null,null,'Greco','51127','4/5 LB',89.00,68,80,'Walk-In Cooler','Shelf 2',true,41,true,'{0.97,0.98,0.99,1}'),
 ('1003','Salmon Fillet, Atlantic','Food','Seafood','LB','OZ','CASE',10,null,null,'Sysco','7731045','10 LB',129.00,18,20,'Walk-In Cooler','Shelf 2',false,41,true,'{1,1,1.02,1}'),
 ('1004','Shrimp 16/20 IQF','Food','Seafood','LB','OZ','CASE',10,'BAG',2,'Sysco','5520811','5/2 LB',95.00,12,15,'Walk-In Freezer','Shelf 1',false,10,false,'{1,1,1,1}'),
 ('1005','Bacon, Sliced','Food','Protein','LB','OZ','CASE',15,null,null,'Greco','33902','15 LB',78.00,8,10,'Walk-In Cooler','Shelf 2',false,41,false,'{0.95,0.97,1,1}'),
 ('2001','Avocado, Hass','Food','Produce','EA','EA','CASE',48,null,null,'Local Produce Company','AV48','48 CT',47.00,150,120,'Walk-In Cooler','Shelf 3',false,null,true,'{0.9,0.95,1.04,1}'),
 ('2002','Tomatoes, 5x6','Food','Produce','LB','OZ','CASE',25,null,null,'Local Produce Company','TM25','25 LB',32.00,45,40,'Walk-In Cooler','Shelf 3',true,null,true,'{1,1.03,1,1}'),
 ('2003','Lettuce, Romaine','Food','Produce','EA','EA','CASE',24,null,null,'Local Produce Company','RM24','24 CT',36.00,40,36,'Walk-In Cooler','Shelf 3',true,null,true,'{1,1,1,1}'),
 ('2004','Onions, Yellow Jumbo','Food','Produce','LB','OZ','BAG',50,null,null,'Local Produce Company','ON50','50 LB',28.00,8,15,'Dry Storage A','Rack 1',false,null,false,'{1,1,1,1}'),
 ('3001','Cheddar, Sliced','Food','Dairy','LB','OZ','CASE',20,null,null,'Greco','66120','4/5 LB',74.00,9,12,'Walk-In Cooler','Shelf 1',true,41,false,'{1,1,1,1}'),
 ('3002','Mozzarella, Shredded','Food','Dairy','LB','OZ','CASE',20,'BAG',5,'Greco','66145','4/5 LB',66.00,3,5,'Walk-In Cooler','Shelf 1',false,41,false,'{1,1,1,1}'),
 ('3003','Heavy Cream','Food','Dairy','QT','FL OZ','CASE',12,'CTN',1,'Greco','70012','12/1 QT',52.00,4,6,'Walk-In Cooler','Shelf 1',false,41,false,'{0.96,1,1,1}'),
 ('3004','Butter, Unsalted','Food','Dairy','LB','OZ','CASE',36,null,null,'Greco','70301','36/1 LB',118.00,2,4,'Walk-In Cooler','Shelf 1',false,41,false,'{1,1,1,1}'),
 ('4001','French Fries 3/8"','Food','Frozen','LB','OZ','CASE',30,'BAG',5,'Greco','11248','6/5 LB',38.50,90,90,'Walk-In Freezer','Shelf 2',false,10,false,'{1,1,1,1}'),
 ('4002','Burger Buns, Brioche','Food','Bakery','EA','EA','CASE',96,'PK',8,'Greco','20488','12/8 CT',28.00,400,360,'Dry Storage A','Rack 2',false,null,false,'{1,1,1,1}'),
 ('4003','Flour, All Purpose','Food','Dry Goods','LB','OZ','BAG',50,null,null,'Sysco','4412030','50 LB',22.00,25,50,'Dry Storage A','Rack 3',false,null,false,'{1,1,1,1}'),
 ('4004','Rice, Long Grain','Food','Dry Goods','LB','OZ','BAG',25,null,null,'Sysco','4415501','25 LB',24.00,13,20,'Dry Storage A','Rack 3',false,null,false,'{1,1,1,1}'),
 ('4005','Fryer Oil, Soybean','Food','Dry Goods','LB','OZ','JUG',35,null,null,'Sysco','6600352','35 LB',46.00,40,35,'Dry Storage B','Floor',false,null,false,'{0.93,0.96,1,1}'),
 ('5001','Coca-Cola 12 oz Can','Beverage','Soft Drinks','EA','EA','CASE',24,null,null,'Beverage Distributor','CK12','24/12 OZ',15.00,120,96,'Beer Cooler','Top',false,null,false,'{1,1,1,1}'),
 ('5002','Sprite 12 oz Can','Beverage','Soft Drinks','EA','EA','CASE',24,null,null,'Beverage Distributor','SP12','24/12 OZ',15.00,60,48,'Beer Cooler','Top',false,null,false,'{1,1,1,1}'),
 ('5003','Draft IPA, Local','Alcohol','Beer','GAL','FL OZ','KEG',15.5,null,null,'Beverage Distributor','IPA-HB','1/2 BBL',165.00,15,15.5,'Beer Cooler','Floor',false,null,false,'{1,1,1,1}'),
 ('5004','House Cabernet Sauvignon','Alcohol','Wine','BTL','BTL','CASE',12,null,null,'Beverage Distributor','CAB750','12/750 ML',120.00,18,24,'Liquor Storage','Rack A',false,null,false,'{1,1,1,1}'),
 ('6001','Napkins, Dinner','Paper','Disposables','PK','PK','CASE',12,null,null,'Greco','90011','12/500 CT',45.00,6,8,'Front Storage','Shelf 1',false,null,false,'{1,1,1,1}'),
 ('6002','To-Go Container 9x9','Paper','Disposables','EA','EA','CASE',200,null,null,'Greco','90450','200 CT',54.00,250,200,'Front Storage','Shelf 2',false,null,false,'{1,1,1,1}'),
 ('6003','Gloves, Nitrile Large','Supplies','Kitchen Supplies','BOX','BOX','CASE',10,null,null,'Sysco','8800123','10/100 CT',62.00,6,6,'Front Storage','Shelf 3',false,null,false,'{1,1,1,1}'),
 ('4006','Mayonnaise','Food','Dry Goods','LB','OZ','CASE',30,null,null,'Sysco','4420088','4/1 GAL',62.00,22,25,'Dry Storage A','Rack 3',false,null,false,'{1,1,1,1}'),
 ('7001','Salsa (prepped)','Food','Prepared','LB','OZ','BATCH',10,null,null,'','','10 LB batch',9.00,40,20,'Walk-In Cooler','Shelf 3',false,41,true,'{1,1,1,1}'),
 ('6004','Sanitizer, Quaternary','Supplies','Chemicals','GAL','FL OZ','CASE',4,null,null,'Sysco','8812007','4/1 GAL',58.00,2,4,'Chemical Storage','Shelf 1',false,null,false,'{1,1,1,1}'),
 ('3005','Pepperoni, Sliced','Food','Protein','LB','OZ','CASE',12.5,null,null,'Greco','GR-PEP125','2/6.25 LB',61.00,10,12,'Walk-In Cooler','Shelf 2',false,41,false,'{0.97,0.98,1,1}'),
 ('8001','Pizza Dough Ball, 16 oz','Food','Prepared','EA','EA','PAN',12,null,null,'Commissary','CM-DOUGH','12 EA pan',0,110,100,'Walk-In Cooler','Shelf 4',false,41,true,'{1,1,1,1}'),
 ('8002','Marinara Sauce','Food','Prepared','LB','OZ','CTN',5,null,null,'Commissary','CM-MARINARA','5 LB container',0,30,25,'Walk-In Cooler','Shelf 4',false,41,true,'{1,1,1,1}'),
 ('8003','Meatballs, 2 oz','Food','Prepared','EA','EA','PAN',50,null,null,'Commissary','CM-MEATBALL','50 EA pan',0,90,80,'Walk-In Cooler','Shelf 4',false,41,true,'{1,1,1,1}');

grant select on seed_products to authenticated;

do $$
declare
  v_owner uuid := seed.user('owner@example.com', 'Harry Owner');
  v_gm uuid := seed.user('gm@example.com', 'Gina Manager');
  v_km uuid := seed.user('kitchen@example.com', 'Kevin Kitchen');
  v_maria uuid := seed.user('maria@example.com', 'Maria Lopez');
  v_john uuid := seed.user('john@example.com', 'John Carter');
  v_carlos uuid := seed.user('carlos@example.com', 'Carlos Ruiz');
  v_acct uuid := seed.user('accounting@example.com', 'Alex Accounting');
  v_reg uuid := seed.user('regional@example.com', 'Rita Regional');
  v_owner2 uuid := seed.user('owner2@example.com', 'Olivia Owner');
  v_shared uuid := seed.user('employee@example.com', 'Employee Login (shared)');
  v_cmu uuid := seed.user('commissary@example.com', 'Chris Commissary');
  v_comm uuid;
  v_org uuid; v_loc uuid; v_loc2 uuid; v_region uuid; v_district uuid;
  p record; v record; s record;
  v_cat_top uuid; v_cat uuid; v_pid uuid; v_vendor uuid; v_storage uuid;
  v_week int; v_day date; v_po uuid; v_rcv uuid; v_cnt uuid;
  v_lines jsonb; v_entries jsonb; v_qty numeric; v_book numeric; v_price numeric;
  v_sunday date := (current_date - extract(dow from current_date)::int);  -- most recent Sunday
  v_open date;
  v_counter uuid;
  v_i int;
begin
  -- ---------------------------------------------------------------- organization
  perform seed.as_user(v_owner);
  v_org := public.create_organization('Pita Princess Restaurant Group', 'Demo Restaurant', '101', 'America/New_York');
  select id into v_loc from public.locations where organization_id = v_org and code = '101';
  update public.locations set address_line1 = '101 Main Street', city = 'Springfield', state = 'IL', phone = '(555) 010-0101' where id = v_loc;
  insert into public.regions (organization_id, name, code) values (v_org, 'Midwest', 'MW') returning id into v_region;
  insert into public.districts (organization_id, region_id, name, code) values (v_org, v_region, 'Springfield District', 'SPR') returning id into v_district;
  update public.locations set region_id = v_region, district_id = v_district, market = 'Springfield' where id = v_loc;
  insert into public.locations (organization_id, region_id, district_id, market, code, name, timezone, address_line1, city, state)
    values (v_org, v_region, v_district, 'Springfield', '105', 'Demo Restaurant Westside', 'America/New_York', '505 West Ave', 'Springfield', 'IL')
    returning id into v_loc2;
  insert into public.locations (organization_id, region_id, district_id, market, code, name, timezone, address_line1, city, state, kind)
    values (v_org, v_region, v_district, 'Springfield', 'C1', 'Central Kitchen', 'America/New_York', '900 Industrial Pkwy', 'Springfield', 'IL', 'commissary')
    returning id into v_comm;

  perform public.assign_role(v_org, v_gm, 'general_manager', 'location', v_loc);
  perform public.assign_role(v_org, v_km, 'kitchen_manager', 'location', v_loc);
  perform public.assign_role(v_org, v_maria, 'employee', 'location', v_loc);
  perform public.assign_role(v_org, v_john, 'employee', 'location', v_loc);
  perform public.assign_role(v_org, v_carlos, 'employee', 'location', v_loc);
  perform public.assign_role(v_org, v_acct, 'accounting', 'organization', v_org);
  perform public.assign_role(v_org, v_reg, 'regional_manager', 'region', v_region);
  perform public.assign_role(v_org, v_owner2, 'system_owner', 'organization', v_org);
  perform public.assign_role(v_org, v_cmu, 'kitchen_manager', 'location', v_comm);
  update public.profiles set default_location_id = v_comm where id = v_cmu;
  perform public.assign_role(v_org, v_shared, 'employee', 'location', v_loc);
  perform public.set_shared_login(v_org, v_shared, true);
  -- "Who are you?" names on the shared employee login (demo PINs)
  perform public.save_employee(v_org, null, 'John', v_loc, '2580', true);
  perform public.save_employee(v_org, null, 'Maria', v_loc, '3691', true);
  perform public.save_employee(v_org, null, 'Carlos', v_loc, '4826', true);
  perform public.save_employee(v_org, null, 'Alex', v_loc, '5937', true);
  update public.profiles set default_location_id = v_loc where id in (v_gm, v_km, v_maria, v_john, v_carlos, v_acct, v_reg, v_owner2, v_shared);

  -- ---------------------------------------------------------------- vendors
  insert into public.vendors (organization_id, name, vendor_number, account_number, sales_rep, phone, email, ordering_email, edi_enabled, einvoice_enabled,
                              order_website, delivery_days, lead_time_days, order_cutoff, minimum_order, freight_rules, payment_terms) values
    (v_org, 'Greco', 'GRE-100', '4410-2231', 'Dana Whitfield', '(555) 300-1000', 'dana.whitfield@example.com', 'orders@example.com', true, true, 'https://order.example.com/greco', '{2,5}', 1, '15:00', 350, 'Free over $350; $35 fee below', 'Net 14'),
    (v_org, 'Sysco', 'SYS-200', 'SY-88213', 'Marcus Lee', '(555) 300-2000', 'marcus.lee@example.com', 'orders@example.com', true, true, 'https://shop.sysco.com', '{1,4}', 1, '14:00', 300, 'Free over $300', 'Net 21'),
    (v_org, 'Local Produce Company', 'LPC-300', 'LP-0101', 'Sam Greene', '(555) 300-3000', 'sam@example.com', 'orders@example.com', false, false, null, '{1,3,5}', 1, '17:00', 75, 'No freight charge', 'COD'),
    (v_org, 'Beverage Distributor', 'BEV-400', 'BD-5510', 'Priya Patel', '(555) 300-4000', 'priya@example.com', 'orders@example.com', false, true, null, '{2}', 2, '12:00', 150, 'Free', 'Net 30');
  insert into public.vendors (organization_id, name, kind, supplying_location_id, phone, email, ordering_email, delivery_days, lead_time_days, order_cutoff, minimum_order, notes)
    values (v_org, 'Commissary', 'commissary', v_comm, '(555) 300-9000', 'commissary@example.com', 'commissary@example.com', '{1,3,5}', 1, '18:00', 0,
            'Our central kitchen: pizza dough, marinara, meatballs. Ordered and received in this app.');

  -- ---------------------------------------------------------------- storage areas (#101) in walking order
  insert into public.storage_locations (organization_id, location_id, name, kind, sort_order) values
    (v_org, v_loc, 'Walk-In Cooler', 'walk_in_cooler', 1), (v_org, v_loc, 'Walk-In Freezer', 'walk_in_freezer', 2),
    (v_org, v_loc, 'Line Cooler', 'line', 3), (v_org, v_loc, 'Dry Storage A', 'dry_storage', 4), (v_org, v_loc, 'Dry Storage B', 'dry_storage', 5),
    (v_org, v_loc, 'Beer Cooler', 'beverage', 6), (v_org, v_loc, 'Liquor Storage', 'bar', 7), (v_org, v_loc, 'Front Storage', 'front', 8),
    (v_org, v_loc, 'Chemical Storage', 'chemical', 9);
  insert into public.storage_locations (organization_id, location_id, name, kind, sort_order)
    select v_org, v_loc2, name, kind, sort_order from public.storage_locations where location_id = v_loc;
  insert into public.storage_locations (organization_id, location_id, name, kind, sort_order) values
    (v_org, v_comm, 'Walk-In Cooler', 'walk_in_cooler', 1), (v_org, v_comm, 'Walk-In Freezer', 'walk_in_freezer', 2), (v_org, v_comm, 'Dry Storage A', 'dry_storage', 3);

  -- ---------------------------------------------------------------- categories & products
  for p in select * from seed_products loop
    select id into v_cat_top from public.categories where organization_id = v_org and parent_id is null and name = p.cat;
    if v_cat_top is null then
      insert into public.categories (organization_id, name, cost_group, is_food, sort)
        values (v_org, p.cat, lower(p.cat)::text, p.cat = 'Food', (select count(*) from public.categories where organization_id = v_org and parent_id is null))
        returning id into v_cat_top;
    end if;
    select id into v_cat from public.categories where organization_id = v_org and parent_id = v_cat_top and name = p.sub;
    if v_cat is null then
      insert into public.categories (organization_id, parent_id, name, cost_group, is_food) values (v_org, v_cat_top, p.sub, lower(p.cat), p.cat = 'Food') returning id into v_cat;
    end if;
    select id into v_vendor from public.vendors where organization_id = v_org and name = p.vendor;
    insert into public.products (organization_id, product_number, name, category_id, inventory_unit_id, recipe_unit_id, purchase_unit_id,
                                 default_vendor_id, sku, receiving_temp_max, shelf_life_days, standard_cost, is_prepped, created_by)
    values (v_org, p.num, p.name, v_cat,
            (select id from public.units where code = p.inv_unit and organization_id is null),
            (select id from public.units where code = p.recipe_unit and organization_id is null),
            (select id from public.units where code = p.pu and organization_id is null),
            v_vendor, 'SKU-' || p.num, p.temp_max,
            case p.sub when 'Produce' then 7 when 'Protein' then 5 when 'Seafood' then 3 when 'Dairy' then 14 else null end,
            round(p.price / p.pu_factor, 6), p.vendor in ('', 'Commissary'), v_owner)
    returning id into v_pid;
    insert into public.product_units (organization_id, product_id, unit_id, factor, use_for_count, use_for_purchase, label)
    values (v_org, v_pid, (select id from public.units where code = p.pu and organization_id is null), p.pu_factor, true, true, p.pu || ' (' || p.pack || ')');
    if p.alt_unit is not null then
      insert into public.product_units (organization_id, product_id, unit_id, factor, use_for_count)
      values (v_org, v_pid, (select id from public.units where code = p.alt_unit and organization_id is null), p.alt_factor, true);
    end if;
    continue when p.vendor = '';
    insert into public.vendor_products (organization_id, vendor_id, product_id, vendor_item_number, description, purchase_unit_id, pack_size,
                                        current_price, is_preferred, guide_sort)
    values (v_org, v_vendor, v_pid, p.sku, upper(p.name), (select id from public.units where code = p.pu and organization_id is null), p.pack,
            round(p.price * p.price_path[1], 2), true, p.num::int);
    insert into public.product_barcodes (organization_id, product_id, barcode, unit_id, vendor_id)
    values (v_org, v_pid, '0' || lpad(p.num, 6, '0') || '12345', (select id from public.units where code = p.pu and organization_id is null), v_vendor);
  end loop;

  -- Secondary vendor for chicken and fries (vendor price comparison)
  insert into public.vendor_products (organization_id, vendor_id, product_id, vendor_item_number, description, purchase_unit_id, pack_size, current_price, contract_price, contract_start, contract_end, guide_sort)
  select v_org, (select id from public.vendors where organization_id = v_org and name = 'Sysco'), pp.id, 'SY-' || pp.product_number, upper(pp.name),
         pp.purchase_unit_id, case pp.product_number when '1001' then '4/10 LB' else '6/5 LB' end,
         case pp.product_number when '1001' then 131.50 else 39.95 end, null, null, null, 900
  from public.products pp where pp.organization_id = v_org and pp.product_number in ('1001', '4001');
  -- Contract price on fries at Greco
  update public.vendor_products set contract_price = 37.25, contract_start = current_date - 60, contract_end = current_date + 120
  where organization_id = v_org and vendor_item_number = '11248';

  -- Shelf-to-sheet order (+ local pars) for both stores
  for s in select sl.id, sl.name, sl.location_id from public.storage_locations sl where sl.organization_id = v_org loop
    perform public.set_storage_sequence(s.id, coalesce((
      select jsonb_agg(jsonb_build_object('product_id', pr.id, 'shelf', sp.shelf) order by sp.shelf, sp.num)
      from seed_products sp join public.products pr on pr.organization_id = v_org and pr.product_number = sp.num
      where sp.storage = s.name), '[]'::jsonb));
    if s.name = 'Line Cooler' then
      perform public.set_storage_sequence(s.id, (
        select jsonb_agg(jsonb_build_object('product_id', pr.id, 'shelf', 'Rail') order by sp.num)
        from seed_products sp join public.products pr on pr.organization_id = v_org and pr.product_number = sp.num where sp.line_storage));
    end if;
  end loop;
  update public.location_products lp set par_qty = sp.par, min_qty = round(sp.par * 0.25, 2), safety_stock_days = 1,
         count_daily = sp.daily, count_weekly = true
  from seed_products sp join public.products pr on pr.product_number = sp.num
  where pr.organization_id = v_org and lp.product_id = pr.id;
  update public.location_products lp set active = (pr.product_number in ('1002', '2002', '2004', '4003', '4005', '8001', '8002', '8003'))
  from public.products pr where pr.id = lp.product_id and lp.location_id = v_comm;
  update public.location_products set par_mode = 'dynamic' where product_id in (select id from public.products where organization_id = v_org and product_number in ('1001', '2001'))
    and location_id = v_loc;


  -- ---------------------------------------------------------------- recipes & menu (nested: House Sauce; prepped: Salsa)
  perform seed.as_user(v_owner);
  create temporary table seed_recipes (name text, rtype text, yield numeric, yunit text, product text, lines jsonb, price numeric, pos text, weekly numeric, mcat text) on commit drop;
  insert into seed_recipes values
    ('House Sauce', 'sub_recipe', 1, 'LB', null, '[["P","4006",0.9,"LB"],["P","2004",0.1,"LB"]]', null, null, 0, null),
    ('Salsa', 'prep', 10, 'LB', '7001', '[["P","2002",7,"LB"],["P","2004",1,"LB"],["P","2001",4,"EA"]]', null, null, 0, null),
    ('Pizza Dough', 'prep', 24, 'EA', '8001', '[["P","4003",13.2,"LB"],["P","4005",0.3,"LB"]]', null, null, 0, null),
    ('Marinara Sauce', 'prep', 10, 'LB', '8002', '[["P","2002",9,"LB"],["P","2004",0.75,"LB"],["P","4005",0.25,"LB"]]', null, null, 0, null),
    ('Meatballs', 'prep', 50, 'EA', '8003', '[["P","1002",6.25,"LB"],["P","4003",0.4,"LB"],["P","2004",0.3,"LB"]]', null, null, 0, null),
    ('Grilled Chicken Pita', 'menu_item', 1, 'EA', null, '[["P","1001",6,"OZ"],["P","4002",1,"EA"],["P","2002",1,"OZ"],["P","2003",0.1,"EA"],["R","House Sauce",1,"OZ"]]', 7.95, 'P100', 250, 'Entrees'),
    ('Cheeseburger', 'menu_item', 1, 'EA', null, '[["P","1002",8,"OZ"],["P","4002",1,"EA"],["P","3001",1,"OZ"],["P","2003",0.1,"EA"],["R","House Sauce",1,"OZ"]]', 8.95, 'P200', 80, 'Entrees'),
    ('Bacon Cheeseburger', 'menu_item', 1, 'EA', null, '[["P","1002",8,"OZ"],["P","4002",1,"EA"],["P","3001",1,"OZ"],["P","1005",2,"OZ"],["R","House Sauce",1,"OZ"]]', 9.95, 'P210', 55, 'Entrees'),
    ('Salmon Plate', 'menu_item', 1, 'EA', null, '[["P","1003",7,"OZ"],["P","4004",5,"OZ"],["P","3004",0.5,"OZ"]]', 16.95, 'P300', 40, 'Entrees'),
    ('Shrimp Alfredo', 'menu_item', 1, 'EA', null, '[["P","1004",5,"OZ"],["P","3003",3,"FL OZ"],["P","3002",1,"OZ"]]', 13.95, 'P310', 36, 'Entrees'),
    ('French Fries', 'menu_item', 1, 'EA', null, '[["P","4001",6,"OZ"]]', 2.95, 'P400', 230, 'Sides'),
    ('Chips & Salsa', 'menu_item', 1, 'EA', null, '[["R","Salsa",4,"OZ"]]', 3.50, 'P410', 160, 'Sides'),
    ('Guacamole', 'menu_item', 1, 'EA', null, '[["P","2001",2,"EA"],["P","2004",0.5,"OZ"]]', 4.50, 'P420', 70, 'Sides'),
    ('Coca-Cola', 'menu_item', 1, 'EA', null, '[["P","5001",1,"EA"]]', 2.25, 'B100', 115, 'Beverages'),
    ('Sprite', 'menu_item', 1, 'EA', null, '[["P","5002",1,"EA"]]', 2.25, 'B110', 58, 'Beverages'),
    ('IPA Pint', 'menu_item', 1, 'EA', null, '[["P","5003",16,"FL OZ"]]', 5.50, 'B200', 115, 'Bar'),
    ('House Cabernet (glass)', 'menu_item', 1, 'EA', null, '[["P","5004",0.2,"BTL"]]', 7.50, 'B300', 85, 'Bar');
  declare
    rr record; ln jsonb; v_rid uuid;
  begin
    for rr in select * from seed_recipes order by case rtype when 'sub_recipe' then 0 when 'prep' then 1 else 2 end loop
      insert into public.recipes (organization_id, name, recipe_type, yield_qty, yield_unit_id, product_id, created_by)
      values (v_org, rr.name, rr.rtype::public.recipe_type, rr.yield, (select id from public.units where code = rr.yunit and organization_id is null),
              (select id from public.products where organization_id = v_org and product_number = rr.product), v_owner)
      returning id into v_rid;
      for ln in select * from jsonb_array_elements(rr.lines) loop
        insert into public.recipe_ingredients (organization_id, recipe_id, product_id, sub_recipe_id, quantity, unit_id)
        values (v_org, v_rid,
                case when ln ->> 0 = 'P' then (select id from public.products where organization_id = v_org and product_number = ln ->> 1) end,
                case when ln ->> 0 = 'R' then (select id from public.recipes where organization_id = v_org and name = ln ->> 1) end,
                (ln ->> 2)::numeric, (select id from public.units where code = ln ->> 3 and organization_id is null));
      end loop;
      if rr.pos is not null then
        insert into public.menu_items (organization_id, name, pos_item_id, menu_category, selling_price, recipe_id)
        values (v_org, rr.name, rr.pos, rr.mcat, rr.price, v_rid);
      end if;
    end loop;
  end;
  grant select on seed_recipes to authenticated;
  create temporary table seed_covered on commit drop as
    select distinct c.product_id from public.menu_items mi, app.recipe_components(mi.recipe_id, 1, true) c where mi.organization_id = v_org
    union select pr.id from public.products pr where pr.organization_id = v_org and pr.product_number in ('2002', '2004', '2001');
  grant select on seed_covered to authenticated;

  -- ---------------------------------------------------------------- history: opening count 4 weeks ago
  v_open := v_sunday - 28;
  perform seed.as_user(v_owner);
  for v_i in 0..1 loop
    v_cnt := public.create_count_session(case v_i when 0 then v_loc else v_loc2 end, 'full', 'Opening Inventory',
                                         (v_open::timestamp + time '21:00') at time zone 'America/New_York');
    select jsonb_agg(jsonb_build_object('client_entry_id', gen_random_uuid(), 'product_id', pr.id, 'storage_location_id', i.storage_location_id,
                     'breakdown', jsonb_build_array(jsonb_build_object('unit_id', pr.inventory_unit_id, 'qty', round(sp.par * 0.8, 1)))))
      into v_entries
    from public.count_session_items i join public.products pr on pr.id = i.product_id join seed_products sp on sp.num = pr.product_number
    where i.session_id = v_cnt
      and i.storage_location_id = (select sl.id from public.storage_locations sl where sl.location_id = case v_i when 0 then v_loc else v_loc2 end and sl.name = sp.storage);
    perform public.save_count_entries(v_cnt, v_entries);
    perform public.submit_count_session(v_cnt);
    perform public.post_count_session(v_cnt, true);
  end loop;

  -- ---------------------------------------------------------------- 4 weeks of deliveries + weekly counts at #101
  for v_week in 1..4 loop
    for v in select * from public.vendors where organization_id = v_org and kind = 'distributor' order by name loop
      -- delivery day: the vendor's first delivery weekday in this week
      v_day := (v_sunday - 28 + (v_week - 1) * 7) + (select min(d) from unnest(v.delivery_days) d)::int;
      perform seed.as_user(v_km);
      -- order what the week will use, priced on the week's price path
      select jsonb_agg(jsonb_build_object('product_id', pr.id, 'vendor_product_id', vp.id,
               'order_qty', greatest(0, ceil((sp.weekly_usage * (0.95 + seed.rnd(pr.id::text || v_week) * 0.15) + sp.par
                                             - app.book_qty(v_loc, pr.id, (v_day::timestamp + time '06:00') at time zone 'America/New_York')) / sp.pu_factor)),
               'unit_price', round(sp.price * sp.price_path[v_week], 2)))
        into v_lines
      from seed_products sp join public.products pr on pr.organization_id = v_org and pr.product_number = sp.num
      join public.vendor_products vp on vp.product_id = pr.id and vp.vendor_id = v.id
      where sp.vendor = v.name
        and sp.weekly_usage * 1.1 + sp.par - app.book_qty(v_loc, pr.id, (v_day::timestamp + time '06:00') at time zone 'America/New_York') > 0;
      continue when v_lines is null;
      v_po := public.create_purchase_order(v_loc, v.id, v_day, v_lines);
      perform seed.as_admin();
      update public.purchase_orders set order_date = v_day - 1 where id = v_po;
      perform seed.as_user(v_km);
      perform public.set_purchase_order_status(v_po, 'submitted', null, null, true);

      perform seed.as_user(case v_week % 3 when 0 then v_maria when 1 then v_john else v_carlos end);
      v_rcv := public.create_receipt(v_loc, null, v_po);
      select jsonb_agg(jsonb_build_object('id', ri.id, 'received_qty', ri.ordered_qty, 'invoiced_qty', ri.ordered_qty,
               'temperature', case when ri.temp_max is null then null when ri.temp_max < 32 then round(seed.rnd(ri.id::text) * 6, 1)
                                   else 35 + round(seed.rnd(ri.id::text) * 4, 1) end,
               'lot_number', case when pr.product_number in ('1001', '1002', '1003', '1004') then 'L' || to_char(v_day, 'YYMMDD') || '-' || pr.product_number end,
               'storage_allocations', jsonb_build_array(jsonb_build_object('storage_location_id',
                  (select sl.id from public.storage_locations sl join seed_products sp on sp.storage = sl.name where sl.location_id = v_loc and sp.num = pr.product_number),
                  'qty', ri.ordered_qty))))
        into v_lines
      from public.receipt_items ri join public.products pr on pr.id = ri.product_id where ri.receipt_id = v_rcv;
      perform public.save_receipt(v_rcv,
        jsonb_build_object('invoice_number', upper(left(v.name, 3)) || '-' || to_char(v_day, 'YYMMDD'), 'invoice_date', v_day, 'delivery_date', v_day),
        v_lines);
      perform public.save_receipt(v_rcv, jsonb_build_object('invoice_total', (public.receipt_totals(v_rcv) ->> 'calculated_total')::numeric), null);
      perform public.complete_receiving(v_rcv);
      perform seed.as_admin();
      update public.receipts set received_at = (v_day::timestamp + time '09:30') at time zone 'America/New_York' where id = v_rcv;
      perform seed.as_user(v_gm);
      perform public.post_receipt(v_rcv);
    end loop;


    -- The week's trading: daily POS imports, prep production and waste, all through the real functions
    for v_i in 1..7 loop
      v_day := v_sunday - 28 + (v_week - 1) * 7 + v_i;   -- Monday .. Sunday
      perform seed.as_user(v_gm);
      perform seed.import_day(v_org, v_loc, v_day);
      perform seed.as_user(v_km);
      if v_i in (1, 4) then
        perform public.record_production(v_loc, (select id from public.recipes where organization_id = v_org and name = 'Salsa'), 22,
                                         21 + round(seed.rnd('salsa' || v_week || v_i) * 1.5, 1), null, null,
                                         (v_day::timestamp + time '10:00') at time zone 'America/New_York');
      end if;
      perform seed.as_user(v_gm);
      if v_i = 4 then
        perform public.log_waste(v_loc, (select id from public.products where organization_id = v_org and product_number = '1001'), 2 + v_week % 3,
          (select id from public.units where code = 'LB' and organization_id is null), 'SPOILAGE', null, 'Found past date in walk-in', null,
          (v_day::timestamp + time '15:00') at time zone 'America/New_York');
      elsif v_i = 3 then
        perform public.log_waste(v_loc, (select id from public.products where organization_id = v_org and product_number = '4001'), 2,
          (select id from public.units where code = 'LB' and organization_id is null), 'DROPPED', null, null, null,
          (v_day::timestamp + time '19:00') at time zone 'America/New_York');
      elsif v_i = 6 then
        perform public.log_waste(v_loc, null, 1 + v_week % 2, (select id from public.units where code = 'EA' and organization_id is null), 'OVERCOOKED', null, null, null,
          (v_day::timestamp + time '20:00') at time zone 'America/New_York', null, (select id from public.recipes where organization_id = v_org and name = 'Cheeseburger'));
      end if;
    end loop;

    -- Sunday night count: POS explains most usage; physical = book - shrink (menu items) or - usage (non-menu supplies)
    perform seed.as_user(v_gm);
    v_day := v_sunday - 28 + v_week * 7;
    v_cnt := public.create_count_session(v_loc, 'weekly', 'Weekly Count ' || to_char(v_day, 'Mon DD'),
                                         (v_day::timestamp + time '21:00') at time zone 'America/New_York');
    for v_counter in select unnest(array[v_maria, v_john, v_carlos]) loop
      perform seed.as_user(v_counter);
      select jsonb_agg(jsonb_build_object('client_entry_id', gen_random_uuid(), 'product_id', pr.id, 'storage_location_id', i.storage_location_id,
                       'method', 'keypad',
                       'breakdown', jsonb_build_array(jsonb_build_object('unit_id', pr.inventory_unit_id,
                          'qty', greatest(0, round(app.book_qty(v_loc, pr.id, (v_day::timestamp + time '21:00') at time zone 'America/New_York')
                                           - case when pr.id in (select product_id from seed_covered)
                                                  then sp.weekly_usage * (-0.01 + seed.rnd(pr.id::text || 'u' || v_week) * 0.06)
                                                  else sp.weekly_usage * (0.92 + seed.rnd(pr.id::text || 'u' || v_week) * 0.16) end, 1))))))
        into v_entries
      from public.count_session_items i join public.products pr on pr.id = i.product_id join seed_products sp on sp.num = pr.product_number
      join public.storage_locations sl on sl.id = i.storage_location_id and sl.name = sp.storage
      where i.session_id = v_cnt
        and (case when v_counter = v_maria then sl.name in ('Walk-In Cooler', 'Line Cooler')
                  when v_counter = v_john then sl.name in ('Walk-In Freezer', 'Dry Storage A', 'Dry Storage B')
                  else sl.name not in ('Walk-In Cooler', 'Line Cooler', 'Walk-In Freezer', 'Dry Storage A', 'Dry Storage B') end);
      if v_entries is not null then perform public.save_count_entries(v_cnt, v_entries); end if;
    end loop;
    perform seed.as_user(v_gm);
    perform public.submit_count_session(v_cnt);
    perform public.post_count_session(v_cnt, true);
  end loop;

  -- ---------------------------------------------------------------- current week (open work for the demo)
  perform seed.as_user(v_gm);
  for v_day in select d::date from generate_series(v_sunday + 1, current_date - 1, interval '1 day') d loop
    perform seed.import_day(v_org, v_loc, v_day);
  end loop;

  perform seed.as_user(v_km);
  -- Sysco order submitted for tomorrow: waiting to be received
  select jsonb_agg(jsonb_build_object('product_id', pr.id, 'vendor_product_id', vp.id, 'order_qty', greatest(1, ceil(sp.weekly_usage / sp.pu_factor))))
    into v_lines
  from seed_products sp join public.products pr on pr.organization_id = v_org and pr.product_number = sp.num
  join public.vendor_products vp on vp.product_id = pr.id and vp.vendor_id = (select id from public.vendors where organization_id = v_org and name = 'Sysco')
  where sp.vendor = 'Sysco';
  v_po := public.create_purchase_order(v_loc, (select id from public.vendors where organization_id = v_org and name = 'Sysco'), current_date + 1, v_lines);
  perform public.set_purchase_order_status(v_po, 'submitted', null, null, true);
  perform public.set_purchase_order_status(v_po, 'confirmed', null, 'SYS-CONF-' || to_char(current_date, 'MMDD'));

  -- Local Produce delivered today, received but invoice not reconciled yet
  select jsonb_agg(jsonb_build_object('product_id', pr.id, 'vendor_product_id', vp.id, 'order_qty', greatest(1, ceil(sp.weekly_usage / sp.pu_factor))))
    into v_lines
  from seed_products sp join public.products pr on pr.organization_id = v_org and pr.product_number = sp.num
  join public.vendor_products vp on vp.product_id = pr.id and vp.vendor_id = (select id from public.vendors where organization_id = v_org and name = 'Local Produce Company')
  where sp.vendor = 'Local Produce Company';
  v_po := public.create_purchase_order(v_loc, (select id from public.vendors where organization_id = v_org and name = 'Local Produce Company'), current_date, v_lines);
  perform public.set_purchase_order_status(v_po, 'submitted', null, null, true);
  perform seed.as_user(v_maria);
  v_rcv := public.create_receipt(v_loc, null, v_po);
  select jsonb_agg(jsonb_build_object('id', ri.id, 'received_qty', case when pr.product_number = '2001' then ri.ordered_qty - 1 else ri.ordered_qty end,
                   'invoiced_qty', ri.ordered_qty, 'invoice_price', case when pr.product_number = '2002' then ri.contract_price + 3 else ri.contract_price end))
    into v_lines
  from public.receipt_items ri join public.products pr on pr.id = ri.product_id where ri.receipt_id = v_rcv;
  perform public.save_receipt(v_rcv, jsonb_build_object('invoice_number', 'LPC-' || to_char(current_date, 'YYMMDD'), 'invoice_date', current_date), v_lines);
  perform public.save_receipt(v_rcv, jsonb_build_object('invoice_total', (public.receipt_totals(v_rcv) ->> 'calculated_total')::numeric), null);
  perform public.complete_receiving(v_rcv);

  -- (Greco is ordered on its website from the Ordering Center)

  -- ---------------------------------------------------------------- email recipients (configured in Administration -> Email)
  perform seed.as_user(v_owner);
  perform public.save_email_recipient(v_org, null, 'Harry Owner', 'owner@example.com', null, true,
    array['daily_report','weekly_report','monthly_report','waste_alert','variance_alert','delivery_discrepancy','price_alert','critical_stock','sync_failure']);
  perform public.save_email_recipient(v_org, null, 'Olivia Owner', 'owner2@example.com', null, true, array['weekly_report','monthly_report']);
  perform public.save_email_recipient(v_org, null, 'Gina Manager', 'gm@example.com', v_loc, true,
    array['daily_report','weekly_report','waste_alert','variance_alert','delivery_discrepancy','price_alert','critical_stock','low_stock','inventory_due','vendor_order_reminder']);
  perform public.save_email_recipient(v_org, null, 'Central Kitchen', 'commissary@example.com', v_comm, true, array['commissary_order']);

  -- ---------------------------------------------------------------- commissary: opening stock, production, orders
  perform seed.as_user(v_cmu);
  v_cnt := public.create_count_session(v_comm, 'full', 'Commissary Opening Inventory', now() - interval '2 days');
  select jsonb_agg(jsonb_build_object('client_entry_id', gen_random_uuid(), 'product_id', pr.id, 'storage_location_id', i.storage_location_id,
                   'breakdown', jsonb_build_array(jsonb_build_object('unit_id', pr.inventory_unit_id,
                      'qty', case pr.product_number when '4003' then 150 when '1002' then 40 when '2002' then 100 when '2004' then 30 when '4005' then 35 else 0 end))))
    into v_entries
  from public.count_session_items i join public.products pr on pr.id = i.product_id where i.session_id = v_cnt;
  perform public.save_count_entries(v_cnt, v_entries);
  perform public.submit_count_session(v_cnt);
  perform public.post_count_session(v_cnt, true);
  -- standard costs for raw items at the commissary (bought from Sysco/Greco)
  perform seed.as_admin();
  update public.location_products lp set avg_cost = coalesce(nullif(r.avg_cost, 0), lp.avg_cost)
  from public.location_products r where r.location_id = v_loc and r.product_id = lp.product_id and lp.location_id = v_comm;
  perform seed.as_user(v_cmu);
  perform public.record_production(v_comm, (select id from public.recipes where organization_id = v_org and name = 'Pizza Dough'), 240, 240, null, 'Morning dough run', now() - interval '1 day');
  perform public.record_production(v_comm, (select id from public.recipes where organization_id = v_org and name = 'Marinara Sauce'), 60, 58, null, null, now() - interval '1 day');
  perform public.record_production(v_comm, (select id from public.recipes where organization_id = v_org and name = 'Meatballs'), 200, 200, null, null, now() - interval '1 day');

  -- #101 ordered 100 meatballs; the commissary shipped 100; the restaurant counted 95 (spec example)
  perform seed.as_user(v_gm);
  v_po := public.save_commissary_order(null, v_loc, (select id from public.vendors where organization_id = v_org and kind = 'commissary'), current_date,
    'For the weekend', jsonb_build_array(
      jsonb_build_object('product_id', (select id from public.products where organization_id = v_org and product_number = '8001'), 'unit_id', (select id from public.units where code = 'EA' and organization_id is null), 'qty', 120),
      jsonb_build_object('product_id', (select id from public.products where organization_id = v_org and product_number = '8002'), 'unit_id', (select id from public.units where code = 'CTN' and organization_id is null), 'qty', 4),
      jsonb_build_object('product_id', (select id from public.products where organization_id = v_org and product_number = '8003'), 'unit_id', (select id from public.units where code = 'EA' and organization_id is null), 'qty', 100)));
  perform public.submit_commissary_order(v_po);
  perform seed.as_user(v_cmu);
  perform public.set_commissary_status(v_po, 'accepted');
  perform public.set_commissary_status(v_po, 'ready');
  perform public.ship_commissary_order(v_po, '[]'::jsonb);
  perform seed.as_user(v_maria);
  perform public.receive_commissary_order(v_po, (select jsonb_agg(jsonb_build_object('id', i.id,
      'qty_received', case when pd.product_number = '8003' then 95 else i.qty_shipped end))
    from public.commissary_order_items i join public.products pd on pd.id = i.product_id where i.order_id = v_po));
  -- tomorrow's order, waiting for the commissary to accept
  perform seed.as_user(v_gm);
  v_po := public.save_commissary_order(null, v_loc, (select id from public.vendors where organization_id = v_org and kind = 'commissary'), current_date + 1,
    null, jsonb_build_array(
      jsonb_build_object('product_id', (select id from public.products where organization_id = v_org and product_number = '8001'), 'unit_id', (select id from public.units where code = 'PAN' and organization_id is null), 'qty', 8),
      jsonb_build_object('product_id', (select id from public.products where organization_id = v_org and product_number = '8003'), 'unit_id', (select id from public.units where code = 'EA' and organization_id is null), 'qty', 80)));
  perform public.submit_commissary_order(v_po);

  -- ---------------------------------------------------------------- Toast: today's orders arrive one by one (order-level sync)
  perform seed.as_user(v_owner);
  perform public.set_toast_restaurant(v_loc, '6f1c2a54-0d7e-4b8a-9b1e-101101101101');
  perform seed.as_user(v_gm);
  declare
    v_d date := (now() at time zone 'America/New_York')::date;
    v_t bigint := (extract(epoch from now()) * 1000)::bigint - 3600000;
    v_o jsonb;
  begin
    for v_i in 1..12 loop
      v_o := jsonb_build_object('guid', 'demo-order-' || v_i, 'business_date', v_d, 'modified_at', v_t + v_i * 60000, 'guest_count', 1 + v_i % 3,
        'selections', jsonb_build_array(
          jsonb_build_object('guid', 'demo-sel-' || v_i || '-a', 'item_guid', case v_i % 3 when 0 then 'P200' when 1 then 'P100' else 'P210' end,
                             'name', case v_i % 3 when 0 then 'Cheeseburger' when 1 then 'Grilled Chicken Pita' else 'Bacon Cheeseburger' end,
                             'quantity', 1 + v_i % 2, 'net_sales', (1 + v_i % 2) * case v_i % 3 when 0 then 8.95 when 1 then 7.95 else 9.95 end),
          jsonb_build_object('guid', 'demo-sel-' || v_i || '-b', 'item_guid', 'P400', 'name', 'French Fries', 'quantity', 1, 'net_sales', 2.95)));
      perform public.ingest_toast_order(v_loc, v_o, 'demo');
      if v_i = 3 then perform public.ingest_toast_order(v_loc, v_o, 'demo'); end if;            -- webhook delivered twice: ignored
    end loop;
    -- order 5: a second pita added after it was first sent
    perform public.ingest_toast_order(v_loc, jsonb_build_object('guid', 'demo-order-5', 'business_date', v_d, 'modified_at', v_t + 3000000, 'guest_count', 2,
      'selections', jsonb_build_array(jsonb_build_object('guid', 'demo-sel-5-a', 'item_guid', 'P210', 'name', 'Bacon Cheeseburger', 'quantity', 3, 'net_sales', 29.85),
                                      jsonb_build_object('guid', 'demo-sel-5-b', 'item_guid', 'P400', 'name', 'French Fries', 'quantity', 1, 'net_sales', 2.95))), 'demo');
    -- order 7 voided
    perform public.ingest_toast_order(v_loc, jsonb_build_object('guid', 'demo-order-7', 'business_date', v_d, 'modified_at', v_t + 3100000, 'voided', true,
      'selections', '[]'::jsonb), 'demo');
    -- a new menu item nobody has mapped yet
    perform public.ingest_toast_order(v_loc, jsonb_build_object('guid', 'demo-order-13', 'business_date', v_d, 'modified_at', v_t + 3200000, 'guest_count', 2,
      'selections', jsonb_build_array(jsonb_build_object('guid', 'demo-sel-13-a', 'item_guid', 'TOAST-NEW-LAMB', 'name', 'Lamb Gyro Special', 'quantity', 2, 'net_sales', 25.90))), 'demo');
  end;

  perform seed.as_user(v_km);
  -- Tasks
  perform seed.as_user(v_gm);
  insert into public.tasks (organization_id, location_id, title, task_type, due_at, recurrence, created_by) values
    (v_org, v_loc, 'Weekly inventory count', 'count', (v_sunday + 7)::timestamp + time '21:00', 'weekly', v_gm),
    (v_org, v_loc, 'Place Greco order', 'order', (current_date::timestamp + time '15:00'), 'weekly', v_gm),
    (v_org, v_loc, 'Place produce order', 'order', (current_date - 1)::timestamp + time '17:00', 'weekly', v_gm),
    (v_org, v_loc, 'Count liquor', 'count', (current_date + 2)::timestamp + time '10:00', 'weekly', v_gm),
    (v_org, v_loc, 'Review waste log', 'review_waste', (current_date + 1)::timestamp + time '10:00', 'weekly', v_gm);
  perform public.refresh_stock_alerts(v_loc);
  perform seed.as_admin();
end $$;

drop schema seed cascade;
