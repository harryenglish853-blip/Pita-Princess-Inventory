-- =====================================================================
-- CATALOG: units & conversion engine, categories, storage areas,
-- products (corporate master), location products (local overrides),
-- shelf-to-sheet ordering, barcodes.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Units
-- ---------------------------------------------------------------------
-- weight/volume/count units carry std_factor (grams / millilitres / each),
-- so conversions within a dimension are automatic. "package" units
-- (CASE, BAG, CARTON...) only convert through a product-specific factor.
create type public.unit_dimension as enum ('weight', 'volume', 'count', 'package');

create table public.units (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid references public.organizations(id) on delete cascade, -- null = built-in
  code            text not null check (code ~ '^[A-Za-z0-9 ._/-]{1,16}$'),
  name            text not null,
  plural_name     text,
  dimension       public.unit_dimension not null,
  std_factor      numeric(24,12) check (std_factor is null or std_factor > 0),
  sort            integer not null default 0,
  active          boolean not null default true,
  created_at      timestamptz not null default now(),
  check ((dimension = 'package') = (std_factor is null))
);
create unique index units_code_uniq on public.units (coalesce(organization_id, '00000000-0000-0000-0000-000000000000'::uuid), upper(code));

insert into public.units (code, name, plural_name, dimension, std_factor, sort) values
  ('LB',    'Pound',        'Pounds',       'weight', 453.59237,       10),
  ('OZ',    'Ounce',        'Ounces',       'weight', 28.349523125,    11),
  ('KG',    'Kilogram',     'Kilograms',    'weight', 1000,            12),
  ('G',     'Gram',         'Grams',        'weight', 1,               13),
  ('GAL',   'Gallon',       'Gallons',      'volume', 3785.411784,     20),
  ('QT',    'Quart',        'Quarts',       'volume', 946.352946,      21),
  ('PT',    'Pint',         'Pints',        'volume', 473.176473,      22),
  ('CUP',   'Cup',          'Cups',         'volume', 236.5882365,     23),
  ('FL OZ', 'Fluid Ounce',  'Fluid Ounces', 'volume', 29.5735295625,   24),
  ('TBSP',  'Tablespoon',   'Tablespoons',  'volume', 14.78676478125,  25),
  ('TSP',   'Teaspoon',     'Teaspoons',    'volume', 4.92892159375,   26),
  ('L',     'Liter',        'Liters',       'volume', 1000,            27),
  ('ML',    'Milliliter',   'Milliliters',  'volume', 1,               28),
  ('EA',    'Each',         'Each',         'count',  1,               30),
  ('DZ',    'Dozen',        'Dozen',        'count',  12,              31),
  ('CASE',  'Case',         'Cases',        'package', null,           40),
  ('BAG',   'Bag',          'Bags',         'package', null,           41),
  ('BOX',   'Box',          'Boxes',        'package', null,           42),
  ('CTN',   'Carton',       'Cartons',      'package', null,           43),
  ('PK',    'Pack',         'Packs',        'package', null,           44),
  ('BTL',   'Bottle',       'Bottles',      'package', null,           45),
  ('CAN',   'Can',          'Cans',         'package', null,           46),
  ('JUG',   'Jug',          'Jugs',         'package', null,           47),
  ('KEG',   'Keg',          'Kegs',         'package', null,           48),
  ('SLEEVE','Sleeve',       'Sleeves',      'package', null,           49),
  ('TUB',   'Tub',          'Tubs',         'package', null,           50),
  ('BUNCH', 'Bunch',        'Bunches',      'package', null,           51),
  ('ROLL',  'Roll',         'Rolls',        'package', null,           52),
  ('PAN',   'Pan',          'Pans',         'package', null,           53),
  ('BATCH', 'Batch',        'Batches',      'package', null,           54),
  ('PORTION','Portion',     'Portions',     'package', null,           55);

-- ---------------------------------------------------------------------
-- Categories (category -> subcategory -> microcategory)
-- ---------------------------------------------------------------------
create table public.categories (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  parent_id       uuid references public.categories(id),
  level           smallint not null default 1 check (level between 1 and 3),
  name            text not null check (length(btrim(name)) > 0),
  gl_account      text,
  sort            integer not null default 0,
  is_food         boolean not null default true, -- counts toward food cost (vs beverage / paper / chemical)
  cost_group      text not null default 'food' check (cost_group in ('food','beverage','alcohol','paper','supplies','other')),
  active          boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique nulls not distinct (organization_id, parent_id, name)
);
create index on public.categories (organization_id);
create trigger trg_categories_touch before update on public.categories for each row execute function app.touch_updated_at();

create or replace function app.categories_check_level() returns trigger
language plpgsql as $$
declare v_parent_level smallint;
begin
  if new.parent_id is null then
    new.level := 1;
  else
    select level into v_parent_level from public.categories where id = new.parent_id and organization_id = new.organization_id;
    if v_parent_level is null then raise exception 'Parent category not found'; end if;
    if v_parent_level >= 3 then raise exception 'Categories support three levels (category, subcategory, microcategory)'; end if;
    new.level := v_parent_level + 1;
  end if;
  return new;
end $$;
create trigger trg_categories_level before insert or update of parent_id on public.categories for each row execute function app.categories_check_level();

-- ---------------------------------------------------------------------
-- Storage areas (per restaurant location)
-- ---------------------------------------------------------------------
create type public.storage_kind as enum ('walk_in_cooler','walk_in_freezer','reach_in_cooler','dry_storage','bar','line','prep','beverage','chemical','front','other');

create table public.storage_locations (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  location_id     uuid not null references public.locations(id) on delete cascade,
  name            text not null check (length(btrim(name)) > 0),
  kind            public.storage_kind not null default 'other',
  sort_order      integer not null default 0,
  active          boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (location_id, name)
);
create index on public.storage_locations (location_id, sort_order);
create trigger trg_storage_touch before update on public.storage_locations for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------
-- Products (corporate master)
-- ---------------------------------------------------------------------
create table public.products (
  id                   uuid primary key default gen_random_uuid(),
  organization_id      uuid not null references public.organizations(id) on delete cascade,
  product_number       text not null,
  name                 text not null check (length(btrim(name)) > 0),
  description          text,
  category_id          uuid references public.categories(id),
  inventory_unit_id    uuid not null references public.units(id),  -- base unit: ledger quantities are stored in it
  recipe_unit_id       uuid references public.units(id),
  purchase_unit_id     uuid references public.units(id),
  sku                  text,
  brand                text,
  manufacturer_number  text,
  default_vendor_id    uuid,  -- FK added in vendors migration
  standard_cost        numeric(18,6) check (standard_cost is null or standard_cost >= 0), -- per inventory unit
  shelf_life_days      integer check (shelf_life_days is null or shelf_life_days >= 0),
  lot_tracked          boolean not null default false,
  expiration_tracked   boolean not null default false,
  catch_weight         boolean not null default false,
  taxable              boolean not null default false,
  gl_account           text,
  receiving_temp_min   numeric(6,2),
  receiving_temp_max   numeric(6,2),
  is_prepped           boolean not null default false, -- produced in-house from a recipe
  image_url            text,
  notes                text,
  active               boolean not null default true,
  deleted_at           timestamptz,
  created_by           uuid references public.profiles(id),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (organization_id, product_number),
  check (receiving_temp_min is null or receiving_temp_max is null or receiving_temp_min <= receiving_temp_max)
);
create index on public.products (organization_id, active);
create index on public.products (category_id);
create index products_name_trgm on public.products using gin (name extensions.gin_trgm_ops);
create trigger trg_products_touch before update on public.products for each row execute function app.touch_updated_at();

-- Product-specific unit conversions: 1 <unit> = factor <inventory unit>.
create table public.product_units (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  product_id       uuid not null references public.products(id) on delete cascade,
  unit_id          uuid not null references public.units(id),
  factor           numeric(24,10) not null check (factor > 0),
  label            text,             -- e.g. "Case (4 x 10 LB)"
  use_for_count    boolean not null default true,
  use_for_purchase boolean not null default false,
  sort             integer not null default 0,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (product_id, unit_id)
);
create index on public.product_units (product_id);
create trigger trg_product_units_touch before update on public.product_units for each row execute function app.touch_updated_at();

create or replace function app.product_units_guard() returns trigger
language plpgsql as $$
begin
  if exists (select 1 from public.products p where p.id = new.product_id and p.inventory_unit_id = new.unit_id) then
    raise exception 'The inventory unit always equals 1; it cannot have a conversion factor';
  end if;
  return new;
end $$;
create trigger trg_product_units_guard before insert or update on public.product_units for each row execute function app.product_units_guard();

create table public.product_barcodes (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  product_id      uuid not null references public.products(id) on delete cascade,
  barcode         text not null check (barcode ~ '^[0-9A-Za-z-]{4,64}$'),
  unit_id         uuid references public.units(id), -- what one scan represents (e.g. a CASE barcode)
  vendor_id       uuid,
  created_by      uuid references public.profiles(id),
  created_at      timestamptz not null default now(),
  unique (organization_id, barcode, product_id)
);
create index on public.product_barcodes (organization_id, barcode);

-- ---------------------------------------------------------------------
-- CENTRAL UNIT CONVERSION ENGINE
-- One view defines every unit a product can be expressed in, and the factor
-- to the product's inventory unit. All SQL and all UI code use it; no other
-- component computes conversions on its own.
-- ---------------------------------------------------------------------
create or replace view public.product_unit_options with (security_invoker = true) as
with base as (
  select p.id as product_id, p.organization_id, p.inventory_unit_id, u.dimension, u.std_factor
  from public.products p join public.units u on u.id = p.inventory_unit_id
),
anchors as ( -- (product, dimension, standard units per 1 inventory unit)
  select product_id, dimension, std_factor as std_per_base from base where std_factor is not null
  union all
  select pu.product_id, u.dimension, u.std_factor / pu.factor
  from public.product_units pu join public.units u on u.id = pu.unit_id
  where u.std_factor is not null
),
candidates as (
  select b.product_id, b.inventory_unit_id as unit_id, 1::numeric as factor, 0 as priority, true as use_for_count, false as use_for_purchase, null::text as label, 0 as sort
  from base b
  union all
  select pu.product_id, pu.unit_id, pu.factor, 1, pu.use_for_count, pu.use_for_purchase, pu.label, pu.sort
  from public.product_units pu
  union all
  select a.product_id, u.id, u.std_factor / a.std_per_base, 2, false, false, null, 100 + u.sort
  from anchors a
  join public.products p on p.id = a.product_id
  join public.units u on u.dimension = a.dimension and u.std_factor is not null and u.active
                     and (u.organization_id is null or u.organization_id = p.organization_id)
)
select distinct on (c.product_id, c.unit_id)
  c.product_id, c.unit_id, u.code as unit_code, u.name as unit_name, u.dimension,
  round(c.factor, 10) as factor,
  (c.priority = 0) as is_inventory_unit,
  c.use_for_count, c.use_for_purchase, c.label, c.sort, c.priority
from candidates c join public.units u on u.id = c.unit_id
order by c.product_id, c.unit_id, c.priority;

-- Inventory units in 1 p_unit of the product; NULL when no conversion exists.
create or replace function app.unit_factor(p_product uuid, p_unit uuid) returns numeric
language sql stable security definer set search_path = public as $$
  select factor from public.product_unit_options where product_id = p_product and unit_id = p_unit
$$;

create or replace function app.to_base_qty(p_product uuid, p_qty numeric, p_unit uuid) returns numeric
language plpgsql stable security definer set search_path = public as $$
declare v_factor numeric;
begin
  if p_qty is null then return null; end if;
  v_factor := app.unit_factor(p_product, p_unit);
  if v_factor is null then
    raise exception 'No unit conversion defined for product % and unit %',
      (select name from public.products where id = p_product), (select code from public.units where id = p_unit)
      using errcode = '22023';
  end if;
  return round(p_qty * v_factor, 4);
end $$;

-- Exposed to the app for server-side validation / display.
create or replace function public.convert_quantity(p_product uuid, p_qty numeric, p_from_unit uuid, p_to_unit uuid)
returns numeric
language plpgsql stable security definer set search_path = public as $$
declare v_from numeric; v_to numeric;
begin
  if not exists (select 1 from public.products where id = p_product and organization_id in (select app.user_org_ids())) then
    raise exception 'Product not found' using errcode = '42501';
  end if;
  v_from := app.unit_factor(p_product, p_from_unit);
  v_to := app.unit_factor(p_product, p_to_unit);
  if v_from is null or v_to is null then
    raise exception 'No unit conversion defined' using errcode = '22023';
  end if;
  return round(p_qty * v_from / v_to, 6);
end $$;

create or replace function app.products_units_guard() returns trigger
language plpgsql as $$
begin
  -- recipe/purchase units must be convertible to the inventory unit (checked after insert
  -- so product_units rows created in the same transaction are visible)
  if new.recipe_unit_id is not null and app.unit_factor(new.id, new.recipe_unit_id) is null then
    raise exception 'Recipe unit has no conversion to the inventory unit for %', new.name using errcode = '22023';
  end if;
  if new.purchase_unit_id is not null and app.unit_factor(new.id, new.purchase_unit_id) is null then
    raise exception 'Purchase unit has no conversion to the inventory unit for %', new.name using errcode = '22023';
  end if;
  return null;
end $$;
create constraint trigger trg_products_units_guard after insert or update on public.products
  deferrable initially deferred for each row execute function app.products_units_guard();

-- ---------------------------------------------------------------------
-- Location products (local settings / overrides) and shelf-to-sheet
-- ---------------------------------------------------------------------
create type public.par_mode as enum ('none', 'static', 'dynamic');

create table public.location_products (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references public.organizations(id) on delete cascade,
  location_id        uuid not null references public.locations(id) on delete cascade,
  product_id         uuid not null references public.products(id) on delete cascade,
  active             boolean not null default true,
  par_mode           public.par_mode not null default 'static',
  par_qty            numeric(18,4) check (par_qty is null or par_qty >= 0),       -- inventory units
  min_qty            numeric(18,4) check (min_qty is null or min_qty >= 0),
  reorder_point      numeric(18,4) check (reorder_point is null or reorder_point >= 0),
  safety_stock_qty   numeric(18,4) check (safety_stock_qty is null or safety_stock_qty >= 0),
  safety_stock_days  numeric(8,2)  check (safety_stock_days is null or safety_stock_days >= 0),
  dynamic_par_qty    numeric(18,4),
  dynamic_par_at     timestamptz,
  local_vendor_id    uuid,
  count_daily        boolean not null default false,
  count_weekly       boolean not null default true,
  -- Costing state (weighted average cost per inventory unit, maintained by receipts)
  avg_cost           numeric(18,6) not null default 0 check (avg_cost >= 0),
  last_cost          numeric(18,6) check (last_cost is null or last_cost >= 0),
  last_cost_at       timestamptz,
  last_counted_at    timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (location_id, product_id)
);
create index on public.location_products (product_id);
create trigger trg_location_products_touch before update on public.location_products for each row execute function app.touch_updated_at();

create table public.product_storage_locations (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null references public.organizations(id) on delete cascade,
  location_id         uuid not null references public.locations(id) on delete cascade,
  product_id          uuid not null references public.products(id) on delete cascade,
  storage_location_id uuid not null references public.storage_locations(id) on delete cascade,
  shelf               text,
  sort_order          integer not null default 0,
  active              boolean not null default true,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (storage_location_id, product_id)
);
create index on public.product_storage_locations (location_id, storage_location_id, sort_order);
create index on public.product_storage_locations (product_id);
create trigger trg_psl_touch before update on public.product_storage_locations for each row execute function app.touch_updated_at();

create or replace function app.psl_guard() returns trigger
language plpgsql as $$
begin
  if not exists (select 1 from public.storage_locations s where s.id = new.storage_location_id and s.location_id = new.location_id) then
    raise exception 'Storage area does not belong to this location';
  end if;
  return new;
end $$;
create trigger trg_psl_guard before insert or update on public.product_storage_locations for each row execute function app.psl_guard();

-- New products are carried at every location of the organization; new locations carry every product.
create or replace function app.products_after_insert() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.location_products (organization_id, location_id, product_id, avg_cost)
  select new.organization_id, l.id, new.id, coalesce(new.standard_cost, 0)
  from public.locations l where l.organization_id = new.organization_id
  on conflict (location_id, product_id) do nothing;
  return new;
end $$;
create trigger trg_products_after_insert after insert on public.products for each row execute function app.products_after_insert();

create or replace function app.locations_after_insert() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.location_products (organization_id, location_id, product_id, avg_cost)
  select new.organization_id, new.id, p.id, coalesce(p.standard_cost, 0)
  from public.products p where p.organization_id = new.organization_id and p.deleted_at is null
  on conflict (location_id, product_id) do nothing;
  return new;
end $$;
create trigger trg_locations_after_insert after insert on public.locations for each row execute function app.locations_after_insert();

-- Audit master data changes
create trigger trg_products_audit after insert or update on public.products for each row execute function app.audit_row();
create trigger trg_product_units_audit after insert or update or delete on public.product_units for each row execute function app.audit_row();
create trigger trg_categories_audit after insert or update on public.categories for each row execute function app.audit_row();
create trigger trg_storage_audit after insert or update on public.storage_locations for each row execute function app.audit_row();
create trigger trg_location_products_audit after update on public.location_products for each row execute function app.audit_row();
create trigger trg_units_audit after insert or update on public.units for each row execute function app.audit_row();
create trigger trg_barcodes_audit after insert or delete on public.product_barcodes for each row execute function app.audit_row();

-- ---------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------
alter table public.units                     enable row level security;
alter table public.categories                enable row level security;
alter table public.storage_locations         enable row level security;
alter table public.products                  enable row level security;
alter table public.product_units             enable row level security;
alter table public.product_barcodes          enable row level security;
alter table public.location_products         enable row level security;
alter table public.product_storage_locations enable row level security;

create policy units_select on public.units for select to authenticated
  using (organization_id is null or organization_id in (select app.user_org_ids()));
create policy units_write on public.units for all to authenticated
  using (organization_id is not null and app.has_org_permission('products.edit', organization_id))
  with check (organization_id is not null and app.has_org_permission('products.edit', organization_id));

create policy categories_select on public.categories for select to authenticated
  using (organization_id in (select app.user_org_ids()));
create policy categories_insert on public.categories for insert to authenticated
  with check (app.has_org_permission('products.edit', organization_id));
create policy categories_update on public.categories for update to authenticated
  using (app.has_org_permission('products.edit', organization_id))
  with check (app.has_org_permission('products.edit', organization_id));

create policy storage_select on public.storage_locations for select to authenticated
  using (location_id in (select app.user_location_ids()));
create policy storage_insert on public.storage_locations for insert to authenticated
  with check (app.has_permission('inventory.settings', location_id) and organization_id = app.location_org(location_id));
create policy storage_update on public.storage_locations for update to authenticated
  using (app.has_permission('inventory.settings', location_id))
  with check (app.has_permission('inventory.settings', location_id) and organization_id = app.location_org(location_id));

create policy products_select on public.products for select to authenticated
  using (organization_id in (select app.user_org_ids()));
create policy products_insert on public.products for insert to authenticated
  with check (app.has_org_permission('products.edit', organization_id));
create policy products_update on public.products for update to authenticated
  using (app.has_org_permission('products.edit', organization_id))
  with check (app.has_org_permission('products.edit', organization_id));

create policy product_units_select on public.product_units for select to authenticated
  using (organization_id in (select app.user_org_ids()));
create policy product_units_write on public.product_units for all to authenticated
  using (app.has_org_permission('products.edit', organization_id))
  with check (app.has_org_permission('products.edit', organization_id)
              and organization_id = (select organization_id from public.products where id = product_id));

create policy barcodes_select on public.product_barcodes for select to authenticated
  using (organization_id in (select app.user_org_ids()));
create policy barcodes_write on public.product_barcodes for all to authenticated
  using (app.has_any_permission('inventory.settings', organization_id) or app.has_org_permission('products.edit', organization_id))
  with check ((app.has_any_permission('inventory.settings', organization_id) or app.has_org_permission('products.edit', organization_id))
              and organization_id = (select organization_id from public.products where id = product_id));

create policy location_products_select on public.location_products for select to authenticated
  using (location_id in (select app.user_location_ids()));
create policy location_products_update on public.location_products for update to authenticated
  using (app.has_permission('products.local_edit', location_id) or app.has_permission('inventory.settings', location_id))
  with check (app.has_permission('products.local_edit', location_id) or app.has_permission('inventory.settings', location_id));

create policy psl_select on public.product_storage_locations for select to authenticated
  using (location_id in (select app.user_location_ids()));
create policy psl_write on public.product_storage_locations for all to authenticated
  using (app.has_permission('inventory.settings', location_id))
  with check (app.has_permission('inventory.settings', location_id) and organization_id = app.location_org(location_id));

-- Local cost columns are maintained only by posting functions: block direct edits.
create or replace function app.location_products_protect_cost() returns trigger
language plpgsql as $$
begin
  if current_user in ('authenticated', 'anon')
     and (new.avg_cost is distinct from old.avg_cost or new.last_cost is distinct from old.last_cost
          or new.last_counted_at is distinct from old.last_counted_at or new.location_id <> old.location_id
          or new.product_id <> old.product_id) then
    raise exception 'Cost and count fields are maintained by inventory transactions and cannot be edited directly';
  end if;
  return new;
end $$;
create trigger trg_location_products_protect before update on public.location_products for each row execute function app.location_products_protect_cost();

-- Shelf-to-sheet: save the full walking order of one storage area in one call.
create or replace function public.set_storage_sequence(p_storage_location uuid, p_items jsonb)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_loc uuid; v_org uuid;
  r jsonb;
  i integer := 0;
begin
  select location_id, organization_id into v_loc, v_org from public.storage_locations where id = p_storage_location;
  if v_loc is null then raise exception 'Storage area not found'; end if;
  perform app.require_permission('inventory.settings', v_loc);
  for r in select * from jsonb_array_elements(p_items) loop
    i := i + 1;
    insert into public.product_storage_locations (organization_id, location_id, product_id, storage_location_id, shelf, sort_order, active)
    values (v_org, v_loc, (r ->> 'product_id')::uuid, p_storage_location, nullif(r ->> 'shelf', ''), i, true)
    on conflict (storage_location_id, product_id)
    do update set shelf = excluded.shelf, sort_order = excluded.sort_order, active = true;
  end loop;
  -- items removed from the list are deactivated (history is preserved)
  update public.product_storage_locations
     set active = false
   where storage_location_id = p_storage_location
     and product_id not in (select (x ->> 'product_id')::uuid from jsonb_array_elements(p_items) x);
  perform app.audit(v_org, v_loc, 'reorder', 'storage_location', p_storage_location::text, 'Shelf-to-sheet order updated', null, p_items);
end $$;

-- Storage areas: reorder in one call.
create or replace function public.set_storage_area_order(p_location uuid, p_ids uuid[])
returns void
language plpgsql security definer set search_path = public as $$
begin
  perform app.require_permission('inventory.settings', p_location);
  update public.storage_locations s set sort_order = x.ord
  from unnest(p_ids) with ordinality as x(id, ord)
  where s.id = x.id and s.location_id = p_location;
end $$;

-- Grants (see app.apply_grants in the foundation migration)
select app.apply_grants();
