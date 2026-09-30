-- =====================================================================
-- PHASES 5-6: recipes (nested), production, recipe waste, menu items,
-- POS sales import (adapter-neutral), theoretical usage, food cost and
-- actual-vs-theoretical analysis.
-- =====================================================================

create type public.recipe_type as enum ('menu_item', 'prep', 'sub_recipe', 'batch');

create table public.recipes (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  name             text not null check (length(btrim(name)) > 0),
  recipe_type      public.recipe_type not null default 'menu_item',
  yield_qty        numeric(18,4) not null default 1 check (yield_qty > 0),
  yield_unit_id    uuid not null references public.units(id),
  product_id       uuid unique references public.products(id),  -- output product for prepped/inventoried recipes
  serving_size     text,
  instructions     text,
  prep_loss_pct    numeric(6,2) not null default 0 check (prep_loss_pct >= 0 and prep_loss_pct < 100),
  shelf_life_hours integer,
  active           boolean not null default true,
  created_by       uuid references public.profiles(id),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (organization_id, name)
);
create trigger trg_recipes_touch before update on public.recipes for each row execute function app.touch_updated_at();
create trigger trg_recipes_audit after insert or update on public.recipes for each row execute function app.audit_row();

create table public.recipe_ingredients (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  recipe_id       uuid not null references public.recipes(id) on delete cascade,
  product_id      uuid references public.products(id),
  sub_recipe_id   uuid references public.recipes(id),
  quantity        numeric(18,4) not null check (quantity > 0),
  unit_id         uuid not null references public.units(id),
  yield_pct       numeric(6,2) not null default 100 check (yield_pct > 0 and yield_pct <= 100),  -- usable yield (trim loss)
  sort            integer not null default 0,
  notes           text,
  created_at      timestamptz not null default now(),
  check ((product_id is null) <> (sub_recipe_id is null)),
  check (sub_recipe_id is null or sub_recipe_id <> recipe_id)
);
create index on public.recipe_ingredients (recipe_id);
create index on public.recipe_ingredients (sub_recipe_id);
create index on public.recipe_ingredients (product_id);

-- Multiplier that converts p_qty of p_unit into the sub-recipe's yield units.
create or replace function app.recipe_unit_factor(p_recipe uuid, p_unit uuid) returns numeric
language plpgsql stable security definer set search_path = public as $$
declare v_r public.recipes; a numeric; b numeric; ua public.units; ub public.units;
begin
  select * into v_r from public.recipes where id = p_recipe;
  if p_unit = v_r.yield_unit_id then return 1; end if;
  if v_r.product_id is not null then
    a := app.unit_factor(v_r.product_id, p_unit); b := app.unit_factor(v_r.product_id, v_r.yield_unit_id);
    if a is not null and b is not null then return a / b; end if;
  end if;
  select * into ua from public.units where id = p_unit;
  select * into ub from public.units where id = v_r.yield_unit_id;
  if ua.dimension = ub.dimension and ua.std_factor is not null and ub.std_factor is not null then return ua.std_factor / ub.std_factor; end if;
  return null;
end $$;

create or replace function app.recipe_ingredients_guard() returns trigger
language plpgsql as $$
begin
  if new.product_id is not null and app.unit_factor(new.product_id, new.unit_id) is null then
    raise exception 'Unit % has no conversion for %', (select code from public.units where id = new.unit_id), (select name from public.products where id = new.product_id) using errcode = '22023';
  end if;
  if new.sub_recipe_id is not null then
    if app.recipe_unit_factor(new.sub_recipe_id, new.unit_id) is null then
      raise exception 'Unit has no conversion for sub-recipe %', (select name from public.recipes where id = new.sub_recipe_id) using errcode = '22023';
    end if;
    -- no cycles: the sub-recipe must not (transitively) use this recipe
    if exists (
      with recursive tree as (
        select sub_recipe_id as rid, 1 as depth from public.recipe_ingredients where recipe_id = new.sub_recipe_id and sub_recipe_id is not null
        union all
        select ri.sub_recipe_id, t.depth + 1 from public.recipe_ingredients ri join tree t on ri.recipe_id = t.rid where ri.sub_recipe_id is not null and t.depth < 20
      ) select 1 from tree where rid = new.recipe_id) or new.sub_recipe_id = new.recipe_id then
      raise exception 'A recipe cannot contain itself (directly or through a sub-recipe)';
    end if;
  end if;
  return new;
end $$;
create trigger trg_recipe_ingredients_guard before insert or update on public.recipe_ingredients for each row execute function app.recipe_ingredients_guard();

/*
  Explodes p_qty yield-units of a recipe into inventory products (inventory units).
  p_stop_at_prepped: sub-recipes that produce an inventoried product are depleted as
  that product (for theoretical usage) instead of being exploded into raw ingredients.
*/
create or replace function app.recipe_components(p_recipe uuid, p_qty numeric, p_stop_at_prepped boolean)
returns table (product_id uuid, base_qty numeric)
language sql stable security definer set search_path = public as $$
  with recursive walk as (
    select ri.product_id, ri.sub_recipe_id, ri.quantity, ri.unit_id, ri.yield_pct,
           (p_qty / r.yield_qty) * (1 / (1 - r.prep_loss_pct / 100)) as mult, 1 as depth
    from public.recipe_ingredients ri join public.recipes r on r.id = ri.recipe_id
    where ri.recipe_id = p_recipe
    union all
    select ri.product_id, ri.sub_recipe_id, ri.quantity, ri.unit_id, ri.yield_pct,
           w.mult * (w.quantity / (w.yield_pct / 100)) * app.recipe_unit_factor(w.sub_recipe_id, w.unit_id) / sr.yield_qty
             * (1 / (1 - sr.prep_loss_pct / 100)), w.depth + 1
    from walk w
    join public.recipes sr on sr.id = w.sub_recipe_id
    join public.recipe_ingredients ri on ri.recipe_id = w.sub_recipe_id
    where w.sub_recipe_id is not null and w.depth < 20 and not (p_stop_at_prepped and sr.product_id is not null)
  )
  select coalesce(w.product_id, sr.product_id) as product_id,
         sum(case when w.product_id is not null
                  then w.mult * (w.quantity / (w.yield_pct / 100)) * app.unit_factor(w.product_id, w.unit_id)
                  else w.mult * (w.quantity / (w.yield_pct / 100)) * app.recipe_unit_factor(w.sub_recipe_id, w.unit_id)
                       * app.unit_factor(sr.product_id, sr.yield_unit_id) end) as base_qty
  from walk w left join public.recipes sr on sr.id = w.sub_recipe_id
  where w.product_id is not null or (p_stop_at_prepped and sr.product_id is not null)
  group by 1
$$;

-- Cost of one yield unit, fully exploded to raw ingredients at current costs
-- (so a change in a sub-recipe ingredient cost flows into every parent recipe).
create or replace function public.recipe_unit_cost(p_recipe uuid, p_location uuid) returns numeric
language sql stable security definer set search_path = public as $$
  select coalesce(round(sum(c.base_qty * app.current_unit_cost(p_location, c.product_id)), 6), 0)
  from app.recipe_components(p_recipe, 1, false) c
$$;

-- All recipe costs at a location in one call (recipe list, menu engineering).
create or replace function public.recipe_costs(p_location uuid)
returns table (recipe_id uuid, unit_cost numeric)
language sql stable security definer set search_path = public as $$
  select r.id, public.recipe_unit_cost(r.id, p_location)
  from public.recipes r
  where r.organization_id = app.location_org(p_location) and p_location in (select app.user_location_ids())
$$;

-- Ingredient-level cost breakdown for the recipe screen.
create or replace function public.recipe_cost_breakdown(p_recipe uuid, p_location uuid)
returns table (ingredient_id uuid, kind text, name text, quantity numeric, unit_code text, yield_pct numeric, cost numeric)
language sql stable security definer set search_path = public as $$
  select ri.id, case when ri.product_id is not null then 'product' else 'recipe' end,
         coalesce(p.name, sr.name), ri.quantity, u.code, ri.yield_pct,
         round(case when ri.product_id is not null
                    then (ri.quantity / (ri.yield_pct / 100)) * app.unit_factor(ri.product_id, ri.unit_id) * app.current_unit_cost(p_location, ri.product_id)
                    else (ri.quantity / (ri.yield_pct / 100)) * app.recipe_unit_factor(ri.sub_recipe_id, ri.unit_id) * public.recipe_unit_cost(ri.sub_recipe_id, p_location)
               end * (1 / (1 - r.prep_loss_pct / 100)), 4)
  from public.recipe_ingredients ri
  join public.recipes r on r.id = ri.recipe_id
  join public.units u on u.id = ri.unit_id
  left join public.products p on p.id = ri.product_id
  left join public.recipes sr on sr.id = ri.sub_recipe_id
  where ri.recipe_id = p_recipe and r.organization_id in (select app.user_org_ids())
  order by ri.sort, ri.created_at
$$;

-- ---------------------------------------------------------------------
-- Menu items (POS items) mapped to recipes
-- ---------------------------------------------------------------------
create table public.menu_items (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name            text not null,
  pos_item_id     text,                       -- the POS system's item id / PLU
  menu_category   text,
  selling_price   numeric(12,2) check (selling_price is null or selling_price >= 0),
  recipe_id       uuid references public.recipes(id),
  portion_qty     numeric(18,4) not null default 1 check (portion_qty > 0),  -- recipe yield units per item sold
  active          boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (organization_id, name)
);
create unique index menu_items_pos_uniq on public.menu_items (organization_id, pos_item_id) where pos_item_id is not null;
create trigger trg_menu_items_touch before update on public.menu_items for each row execute function app.touch_updated_at();
create trigger trg_menu_items_audit after insert or update on public.menu_items for each row execute function app.audit_row();

alter table public.waste_logs add constraint waste_logs_recipe_fk foreign key (recipe_id) references public.recipes(id);

-- ---------------------------------------------------------------------
-- Production (prep batches)
-- ---------------------------------------------------------------------
create table public.production_batches (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id),
  location_id      uuid not null references public.locations(id),
  recipe_id        uuid not null references public.recipes(id),
  product_id       uuid not null references public.products(id),
  expected_qty     numeric(18,4) not null check (expected_qty > 0),   -- recipe yield units
  actual_qty       numeric(18,4) not null check (actual_qty >= 0),
  yield_unit_id    uuid not null references public.units(id),
  ingredient_cost  numeric(18,4) not null,
  storage_location_id uuid references public.storage_locations(id),
  produced_at      timestamptz not null,
  business_date    date not null,
  produced_by      uuid references public.profiles(id),
  notes            text,
  client_key       uuid unique,
  created_at       timestamptz not null default now()
);
create index on public.production_batches (location_id, business_date desc);
create trigger trg_production_immutable before update or delete on public.production_batches for each row execute function app.prevent_mutation();

-- ---------------------------------------------------------------------
-- POS sales imports (adapter-neutral)
-- ---------------------------------------------------------------------
create table public.pos_integrations (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  location_id     uuid not null references public.locations(id) on delete cascade,
  provider        text not null check (provider in ('csv', 'toast', 'square', 'clover', 'micros', 'aloha', 'lightspeed', 'other')),
  external_location_id text,
  settings        jsonb not null default '{}'::jsonb,   -- non-secret settings only; secrets live in the vault / env
  active          boolean not null default true,
  created_at      timestamptz not null default now(),
  unique (location_id, provider)
);

create table public.sales_imports (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  location_id     uuid not null references public.locations(id),
  business_date   date not null,
  source          text not null,
  file_name       text,
  status          text not null default 'posted' check (status in ('posted', 'reversed')),
  net_sales       numeric(14,2) not null default 0,
  gross_sales     numeric(14,2) not null default 0,
  discounts       numeric(14,2) not null default 0,
  voids           numeric(14,2) not null default 0,
  refunds         numeric(14,2) not null default 0,
  guest_count     integer not null default 0,
  check_count     integer not null default 0,
  unmapped_lines  integer not null default 0,
  theoretical_cost numeric(14,4) not null default 0,
  imported_by     uuid references public.profiles(id),
  created_at      timestamptz not null default now(),
  reversed_by     uuid references public.profiles(id),
  reversed_at     timestamptz
);
create unique index sales_imports_one_per_day on public.sales_imports (location_id, business_date) where status = 'posted';
create index on public.sales_imports (location_id, business_date desc);

create table public.sales_lines (
  id             uuid primary key default gen_random_uuid(),
  import_id      uuid not null references public.sales_imports(id) on delete cascade,
  menu_item_id   uuid references public.menu_items(id),
  pos_item_id    text,
  item_name      text not null,
  quantity       numeric(12,2) not null,
  net_sales      numeric(14,2) not null default 0,
  discounts      numeric(14,2) not null default 0,
  voids          numeric(12,2) not null default 0,
  refunds        numeric(14,2) not null default 0,
  daypart        text,
  recipe_cost    numeric(14,6)   -- cost per item at import time (theoretical)
);
create index on public.sales_lines (import_id);
create index on public.sales_lines (menu_item_id);

insert into app.write_protected_tables values ('production_batches'), ('sales_imports'), ('sales_lines');

-- ---------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------
alter table public.recipes enable row level security;
alter table public.recipe_ingredients enable row level security;
alter table public.menu_items enable row level security;
alter table public.production_batches enable row level security;
alter table public.pos_integrations enable row level security;
alter table public.sales_imports enable row level security;
alter table public.sales_lines enable row level security;

create policy recipes_select on public.recipes for select to authenticated using (organization_id in (select app.user_org_ids()));
create policy recipes_write on public.recipes for all to authenticated
  using (app.has_org_permission('recipes.edit', organization_id)) with check (app.has_org_permission('recipes.edit', organization_id));
create policy ri_select on public.recipe_ingredients for select to authenticated using (organization_id in (select app.user_org_ids()));
create policy ri_write on public.recipe_ingredients for all to authenticated
  using (app.has_org_permission('recipes.edit', organization_id))
  with check (app.has_org_permission('recipes.edit', organization_id) and organization_id = (select organization_id from public.recipes where id = recipe_id));
create policy menu_select on public.menu_items for select to authenticated using (organization_id in (select app.user_org_ids()));
create policy menu_write on public.menu_items for all to authenticated
  using (app.has_org_permission('recipes.edit', organization_id)) with check (app.has_org_permission('recipes.edit', organization_id));
create policy production_select on public.production_batches for select to authenticated using (location_id in (select app.user_location_ids()));
create policy pos_select on public.pos_integrations for select to authenticated using (location_id in (select app.user_location_ids()));
create policy pos_write on public.pos_integrations for all to authenticated
  using (app.has_permission('settings.manage', location_id)) with check (app.has_permission('settings.manage', location_id));
create policy sales_select on public.sales_imports for select to authenticated using (location_id in (select app.user_location_ids()));
create policy sales_lines_select on public.sales_lines for select to authenticated using (import_id in (select id from public.sales_imports));

-- ---------------------------------------------------------------------
-- Production: deplete ingredients (RECIPE_CONSUMPTION), create output (PRODUCTION)
-- ---------------------------------------------------------------------
create or replace function public.record_production(
  p_location uuid, p_recipe uuid, p_expected_qty numeric, p_actual_qty numeric, p_storage uuid default null,
  p_notes text default null, p_at timestamptz default null, p_client_key uuid default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_r public.recipes; v_org uuid := app.location_org(p_location); v_id uuid; v_at timestamptz := least(coalesce(p_at, now()), now());
  c record; v_cost numeric := 0; v_unit_cost numeric; v_out_base numeric; v_lp public.location_products; v_on numeric;
begin
  perform app.require_permission('production.log', p_location);
  if p_client_key is not null then
    select id into v_id from public.production_batches where client_key = p_client_key;
    if v_id is not null then return jsonb_build_object('id', v_id, 'duplicate', true); end if;
  end if;
  select * into v_r from public.recipes where id = p_recipe and organization_id = v_org and active;
  if v_r.id is null then raise exception 'Recipe not found'; end if;
  if v_r.product_id is null then raise exception '% does not produce an inventory item. Link it to a prepped product first.', v_r.name; end if;
  if coalesce(p_expected_qty, 0) <= 0 then raise exception 'Enter the batch size'; end if;
  if p_actual_qty is null or p_actual_qty < 0 then raise exception 'Enter the actual yield'; end if;

  v_id := gen_random_uuid();
  -- ingredients are depleted for the expected batch; prepped sub-recipes deplete their own inventory
  for c in select * from app.recipe_components(p_recipe, p_expected_qty, true) loop
    v_unit_cost := app.current_unit_cost(p_location, c.product_id);
    v_cost := v_cost + c.base_qty * v_unit_cost;
    perform app.post_inventory_txn(p_location, c.product_id, 'RECIPE_CONSUMPTION', -round(c.base_qty, 4), v_unit_cost, v_at, 'production', v_id,
                                   null, null, null, v_r.name);
  end loop;
  v_out_base := round(p_actual_qty * app.unit_factor(v_r.product_id, v_r.yield_unit_id), 4);
  v_unit_cost := case when v_out_base > 0 then round(v_cost / v_out_base, 6) else 0 end;
  if v_out_base > 0 then
    select * into v_lp from public.location_products where location_id = p_location and product_id = v_r.product_id for update;
    select greatest(coalesce(on_hand, 0), 0) into v_on from public.inventory_balances where location_id = p_location and product_id = v_r.product_id;
    v_on := coalesce(v_on, 0);
    update public.location_products set
      avg_cost = case when v_on + v_out_base > 0 and avg_cost > 0 then round((v_on * avg_cost + v_out_base * v_unit_cost) / (v_on + v_out_base), 6) else v_unit_cost end,
      last_cost = v_unit_cost, last_cost_at = v_at
    where id = v_lp.id;
    perform app.post_inventory_txn(p_location, v_r.product_id, 'PRODUCTION', v_out_base, v_unit_cost, v_at, 'production', v_id, null, p_storage, null, v_r.name);
  end if;
  insert into public.production_batches (id, organization_id, location_id, recipe_id, product_id, expected_qty, actual_qty, yield_unit_id, ingredient_cost,
                                         storage_location_id, produced_at, business_date, produced_by, notes, client_key)
  values (v_id, v_org, p_location, p_recipe, v_r.product_id, p_expected_qty, p_actual_qty, v_r.yield_unit_id, round(v_cost, 4), p_storage, v_at,
          app.business_date(p_location, v_at), auth.uid(), p_notes, p_client_key);
  perform app.audit(v_org, p_location, 'produce', 'recipe', p_recipe::text,
    format('Produced %s (expected %s, actual %s)', v_r.name, p_expected_qty, p_actual_qty), null,
    jsonb_build_object('batch', v_id, 'cost', round(v_cost, 2), 'yield_variance', p_actual_qty - p_expected_qty));
  return jsonb_build_object('id', v_id, 'ingredient_cost', round(v_cost, 2), 'unit_cost', v_unit_cost, 'yield_variance', p_actual_qty - p_expected_qty);
end $$;

-- ---------------------------------------------------------------------
-- Waste (now supports prepared items / menu items: recipe waste)
-- ---------------------------------------------------------------------
create or replace function public.log_waste(
  p_location uuid, p_product uuid, p_qty numeric, p_unit uuid, p_reason text,
  p_storage uuid default null, p_comment text default null, p_photo text default null,
  p_at timestamptz default null, p_client_key uuid default null, p_recipe uuid default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_org uuid := app.location_org(p_location);
  v_id uuid; v_base numeric; v_cost numeric; v_total numeric := 0; v_at timestamptz := least(coalesce(p_at, now()), now());
  v_reason public.adjustment_reasons; v_r public.recipes; v_mult numeric; c record; v_name text;
begin
  perform app.require_permission('waste.log', p_location);
  if p_client_key is not null then
    select id into v_id from public.waste_logs where client_key = p_client_key;
    if v_id is not null then return jsonb_build_object('id', v_id, 'duplicate', true); end if;
  end if;
  if (p_product is null) = (p_recipe is null) then raise exception 'Choose a product or a prepared item'; end if;
  select * into v_reason from public.adjustment_reasons where organization_id = v_org and kind = 'waste' and code = p_reason and active;
  if v_reason.id is null then raise exception 'Unknown waste reason'; end if;
  if v_reason.requires_comment and coalesce(btrim(p_comment), '') = '' then raise exception 'A comment is required for "%"', v_reason.name; end if;
  if coalesce(p_qty, 0) <= 0 then raise exception 'Waste quantity must be greater than zero'; end if;
  if v_at < now() - interval '7 days' and not app.has_permission('inventory.adjust', p_location) then
    raise exception 'Waste older than 7 days must be entered by a manager';
  end if;
  v_id := gen_random_uuid();
  if p_product is not null then
    v_base := app.to_base_qty(p_product, p_qty, p_unit);
    v_cost := app.current_unit_cost(p_location, p_product);
    v_total := v_base * v_cost;
    perform app.post_inventory_txn(p_location, p_product, 'WASTE', -v_base, v_cost, v_at, 'waste', v_id, null, p_storage, p_reason, null, p_comment);
    v_name := (select name from public.products where id = p_product);
  else
    select * into v_r from public.recipes where id = p_recipe and organization_id = v_org;
    if v_r.id is null then raise exception 'Recipe not found'; end if;
    v_name := v_r.name;
    v_mult := p_qty * app.recipe_unit_factor(p_recipe, p_unit);
    if v_mult is null then raise exception 'Unit has no conversion for %', v_r.name using errcode = '22023'; end if;
    -- A prepped item that is itself inventoried is wasted as that product; otherwise deplete components.
    if v_r.product_id is not null then
      v_base := round(v_mult * app.unit_factor(v_r.product_id, v_r.yield_unit_id), 4);
      v_cost := app.current_unit_cost(p_location, v_r.product_id);
      v_total := v_base * v_cost;
      perform app.post_inventory_txn(p_location, v_r.product_id, 'WASTE', -v_base, v_cost, v_at, 'waste', v_id, null, p_storage, p_reason, v_r.name, p_comment);
    else
      for c in select * from app.recipe_components(p_recipe, v_mult, true) loop
        v_cost := app.current_unit_cost(p_location, c.product_id);
        v_total := v_total + c.base_qty * v_cost;
        perform app.post_inventory_txn(p_location, c.product_id, 'WASTE', -round(c.base_qty, 4), v_cost, v_at, 'waste', v_id, null, p_storage, p_reason, v_r.name, p_comment);
      end loop;
    end if;
  end if;
  insert into public.waste_logs (id, organization_id, location_id, product_id, recipe_id, quantity, unit_id, storage_location_id, reason_code, comment, photo_url,
                                 total_cost, wasted_at, business_date, logged_by, client_key)
  values (v_id, v_org, p_location, p_product, p_recipe, p_qty, p_unit, p_storage, p_reason, p_comment, p_photo, round(v_total, 4), v_at,
          app.business_date(p_location, v_at), auth.uid(), p_client_key);
  perform app.audit(v_org, p_location, 'waste', coalesce(case when p_product is not null then 'product' end, 'recipe'), coalesce(p_product, p_recipe)::text,
    format('Wasted %s %s %s (%s)', p_qty, (select code from public.units where id = p_unit), v_name, v_reason.name), null,
    jsonb_build_object('waste_id', v_id, 'cost', round(v_total, 2)));
  return jsonb_build_object('id', v_id, 'cost', round(v_total, 2));
end $$;

-- ---------------------------------------------------------------------
-- POS import: records sales and posts theoretical consumption (POS_CONSUMPTION)
-- p_summary: {net_sales, gross_sales, discounts, voids, refunds, guest_count, check_count}
-- p_lines:   [{pos_item_id, item_name, quantity, net_sales, discounts, voids, refunds, daypart}]
-- Consumption is timestamped at 12:00 local on the business date so an evening
-- count on that date includes the day's sales, and a morning count does not.
-- ---------------------------------------------------------------------
create or replace function public.import_sales(
  p_location uuid, p_business_date date, p_source text, p_file_name text, p_summary jsonb, p_lines jsonb
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_org uuid := app.location_org(p_location);
  v_id uuid; r jsonb; v_mi public.menu_items; v_unmapped int := 0; v_theo numeric := 0; v_cost numeric;
  v_at timestamptz; c record; v_net numeric := 0;
begin
  perform app.require_permission('sales.import', p_location);
  if p_business_date > (now() at time zone (select timezone from public.locations where id = p_location))::date then
    raise exception 'Sales cannot be imported for a future date';
  end if;
  if exists (select 1 from public.sales_imports where location_id = p_location and business_date = p_business_date and status = 'posted') then
    raise exception 'Sales for % were already imported. Reverse that import first to replace it.', p_business_date using errcode = '23505';
  end if;
  v_at := (p_business_date::timestamp + time '12:00') at time zone (select timezone from public.locations where id = p_location);
  insert into public.sales_imports (organization_id, location_id, business_date, source, file_name, gross_sales, discounts, voids, refunds,
                                    guest_count, check_count, imported_by)
  values (v_org, p_location, p_business_date, coalesce(p_source, 'csv'), p_file_name,
          coalesce((p_summary ->> 'gross_sales')::numeric, 0), coalesce((p_summary ->> 'discounts')::numeric, 0),
          coalesce((p_summary ->> 'voids')::numeric, 0), coalesce((p_summary ->> 'refunds')::numeric, 0),
          coalesce((p_summary ->> 'guest_count')::int, 0), coalesce((p_summary ->> 'check_count')::int, 0), auth.uid())
  returning id into v_id;

  create temporary table if not exists tmp_usage (product_id uuid, base_qty numeric) on commit drop;
  truncate tmp_usage;
  for r in select * from jsonb_array_elements(p_lines) loop
    v_mi := null;
    select * into v_mi from public.menu_items
     where organization_id = v_org and active
       and ((nullif(r ->> 'pos_item_id', '') is not null and pos_item_id = r ->> 'pos_item_id') or lower(name) = lower(btrim(r ->> 'item_name')))
     order by (pos_item_id = r ->> 'pos_item_id') desc nulls last limit 1;
    v_cost := case when v_mi.recipe_id is not null then public.recipe_unit_cost(v_mi.recipe_id, p_location) * v_mi.portion_qty end;
    insert into public.sales_lines (import_id, menu_item_id, pos_item_id, item_name, quantity, net_sales, discounts, voids, refunds, daypart, recipe_cost)
    values (v_id, v_mi.id, nullif(r ->> 'pos_item_id', ''), coalesce(nullif(btrim(r ->> 'item_name'), ''), r ->> 'pos_item_id'),
            coalesce((r ->> 'quantity')::numeric, 0), coalesce((r ->> 'net_sales')::numeric, 0), coalesce((r ->> 'discounts')::numeric, 0),
            coalesce((r ->> 'voids')::numeric, 0), coalesce((r ->> 'refunds')::numeric, 0), r ->> 'daypart', v_cost);
    v_net := v_net + coalesce((r ->> 'net_sales')::numeric, 0);
    if v_mi.recipe_id is null then
      v_unmapped := v_unmapped + 1;
    elsif coalesce((r ->> 'quantity')::numeric, 0) <> 0 then
      v_theo := v_theo + v_cost * (r ->> 'quantity')::numeric;
      insert into tmp_usage select * from app.recipe_components(v_mi.recipe_id, v_mi.portion_qty * (r ->> 'quantity')::numeric, true);
    end if;
  end loop;

  for c in select product_id, sum(base_qty) as q from tmp_usage group by product_id loop
    continue when round(c.q, 4) = 0;
    perform app.post_inventory_txn(p_location, c.product_id, 'POS_CONSUMPTION', -round(c.q, 4), app.current_unit_cost(p_location, c.product_id),
                                   v_at, 'sales_import', v_id, null, null, null, 'POS ' || p_business_date);
  end loop;

  update public.sales_imports set net_sales = coalesce((p_summary ->> 'net_sales')::numeric, v_net), unmapped_lines = v_unmapped,
         theoretical_cost = round(v_theo, 4) where id = v_id;
  perform app.audit(v_org, p_location, 'import', 'sales_import', v_id::text,
    format('POS sales %s imported (%s lines, %s unmapped)', p_business_date, jsonb_array_length(p_lines), v_unmapped), null, p_summary);
  if v_unmapped > 0 then
    perform app.create_task(p_location, format('Map %s POS item(s) to recipes', v_unmapped), 'custom', now() + interval '1 day',
      'Unmapped items do not deplete inventory, which understates theoretical usage.', 'sales_import', v_id, 'unmapped:' || v_id);
  end if;
  return jsonb_build_object('id', v_id, 'unmapped', v_unmapped, 'theoretical_cost', round(v_theo, 2), 'net_sales', coalesce((p_summary ->> 'net_sales')::numeric, v_net));
end $$;

create or replace function public.reverse_sales_import(p_import uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare v_i public.sales_imports; t record;
begin
  select * into v_i from public.sales_imports where id = p_import for update;
  if v_i.id is null then raise exception 'Import not found'; end if;
  perform app.require_permission('sales.import', v_i.location_id);
  if v_i.status <> 'posted' then raise exception 'Import is already reversed'; end if;
  if coalesce(btrim(p_reason), '') = '' then raise exception 'A reason is required'; end if;
  if exists (select 1 from public.count_sessions where location_id = v_i.location_id and status = 'posted'
             and count_at > (v_i.business_date::timestamp + time '12:00') at time zone (select timezone from public.locations where id = v_i.location_id)) then
    raise exception 'A physical count was posted after these sales. Reversing would change posted variances.';
  end if;
  for t in select * from public.inventory_transactions where source_type = 'sales_import' and source_id = p_import loop
    perform app.post_inventory_txn(t.location_id, t.product_id, 'CORRECTION', -t.quantity, t.unit_cost, t.txn_at, 'sales_import_reversal', p_import,
                                   null, null, 'REVERSAL', 'Reversal of POS ' || v_i.business_date, p_reason);
  end loop;
  update public.sales_imports set status = 'reversed', reversed_at = now(), reversed_by = auth.uid() where id = p_import;
  perform app.audit(v_i.organization_id, v_i.location_id, 'reverse', 'sales_import', p_import::text, 'POS import reversed: ' || p_reason, null, null);
end $$;

-- Remap an unmapped POS item going forward (creates/updates the menu item link).
create or replace function public.map_pos_item(p_org uuid, p_pos_item_id text, p_item_name text, p_recipe uuid, p_price numeric default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  perform app.require_org_permission('recipes.edit', p_org);
  select id into v_id from public.menu_items where organization_id = p_org and ((p_pos_item_id is not null and pos_item_id = p_pos_item_id) or lower(name) = lower(p_item_name)) limit 1;
  if v_id is null then
    insert into public.menu_items (organization_id, name, pos_item_id, recipe_id, selling_price) values (p_org, p_item_name, p_pos_item_id, p_recipe, p_price) returning id into v_id;
  else
    update public.menu_items set recipe_id = p_recipe, pos_item_id = coalesce(pos_item_id, p_pos_item_id) where id = v_id;
  end if;
  return v_id;
end $$;

-- ---------------------------------------------------------------------
-- FOOD COST: actual vs theoretical for a period
--   Actual usage  = BEGIN + PURCHASES +/- TRANSFERS - END  (valued from the ledger)
--   Theoretical   = menu items sold x recipe cost (POS)
--   Variance      = actual - theoretical  (waste + unexplained loss + adjustments)
-- p_cost_groups filters categories (default: food).
-- ---------------------------------------------------------------------
create or replace function public.food_cost_summary(p_location uuid, p_from timestamptz, p_to timestamptz, p_cost_groups text[] default array['food'])
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v jsonb;
begin
  if not (p_location in (select app.user_location_ids())) then raise exception 'Location not found' using errcode = '42501'; end if;
  with prods as (
    select p.id from public.products p left join public.categories c on c.id = p.category_id
    where p.organization_id = app.location_org(p_location) and coalesce(c.cost_group, 'food') = any(p_cost_groups)
  ),
  t as (
    select t.* from public.inventory_transactions t join prods on prods.id = t.product_id
    where t.location_id = p_location
  ),
  agg as (
    select
      coalesce(sum(extended_cost) filter (where txn_at <= p_from), 0) as begin_value,
      coalesce(sum(extended_cost) filter (where txn_at <= p_to), 0) as end_value,
      coalesce(sum(extended_cost) filter (where txn_at > p_from and txn_at <= p_to and txn_type in ('RECEIPT', 'RETURN_TO_VENDOR')), 0) as purchases,
      coalesce(sum(extended_cost) filter (where txn_at > p_from and txn_at <= p_to and txn_type in ('TRANSFER_IN', 'TRANSFER_OUT')), 0) as transfers,
      coalesce(-sum(extended_cost) filter (where txn_at > p_from and txn_at <= p_to and txn_type = 'POS_CONSUMPTION'), 0) as pos_usage,
      coalesce(-sum(extended_cost) filter (where txn_at > p_from and txn_at <= p_to and txn_type = 'WASTE'), 0) as waste,
      coalesce(-sum(extended_cost) filter (where txn_at > p_from and txn_at <= p_to and txn_type = 'PHYSICAL_VARIANCE'), 0) as count_variance,
      coalesce(-sum(extended_cost) filter (where txn_at > p_from and txn_at <= p_to and txn_type in ('MANUAL_ADJUSTMENT', 'CORRECTION')), 0) as adjustments,
      coalesce(-sum(extended_cost) filter (where txn_at > p_from and txn_at <= p_to and txn_type in ('RECIPE_CONSUMPTION', 'PRODUCTION')), 0) as production_net
    from t
  ),
  sales as (
    select coalesce(sum(s.net_sales), 0) as net_sales, coalesce(sum(s.guest_count), 0) as guests, coalesce(sum(s.check_count), 0) as checks,
           count(*) as days
    from public.sales_imports s
    where s.location_id = p_location and s.status = 'posted'
      and (s.business_date::timestamp + time '12:00') at time zone (select timezone from public.locations where id = p_location) > p_from
      and (s.business_date::timestamp + time '12:00') at time zone (select timezone from public.locations where id = p_location) <= p_to
  ),
  theo as (  -- menu items sold x CURRENT recipe cost (limited to the requested cost groups)
    select coalesce(sum(sl.quantity * mi.portion_qty * (
             select coalesce(sum(c.base_qty * app.current_unit_cost(p_location, c.product_id)), 0)
             from app.recipe_components(mi.recipe_id, 1, false) c join prods on prods.id = c.product_id)), 0) as theoretical
    from public.sales_imports s
    join public.sales_lines sl on sl.import_id = s.id
    join public.menu_items mi on mi.id = sl.menu_item_id and mi.recipe_id is not null
    where s.location_id = p_location and s.status = 'posted'
      and (s.business_date::timestamp + time '12:00') at time zone (select timezone from public.locations where id = p_location) > p_from
      and (s.business_date::timestamp + time '12:00') at time zone (select timezone from public.locations where id = p_location) <= p_to
  )
  select jsonb_build_object(
    'from', p_from, 'to', p_to, 'cost_groups', p_cost_groups,
    'net_sales', s.net_sales, 'guests', s.guests, 'checks', s.checks, 'sales_days', s.days,
    'begin_inventory', round(a.begin_value, 2), 'purchases', round(a.purchases, 2), 'transfers', round(a.transfers, 2),
    'end_inventory', round(a.end_value, 2),
    'actual_cost', round(a.begin_value + a.purchases + a.transfers - a.end_value, 2),
    'theoretical_cost', round(th.theoretical, 2),
    'pos_usage_at_post', round(a.pos_usage, 2),
    'waste', round(a.waste, 2), 'count_variance', round(a.count_variance, 2), 'adjustments', round(a.adjustments, 2),
    'production_net', round(a.production_net, 2),
    'variance', round(a.begin_value + a.purchases + a.transfers - a.end_value - th.theoretical, 2),
    'actual_pct', case when s.net_sales > 0 then round((a.begin_value + a.purchases + a.transfers - a.end_value) / s.net_sales * 100, 2) end,
    'theoretical_pct', case when s.net_sales > 0 then round(th.theoretical / s.net_sales * 100, 2) end,
    'waste_pct', case when s.net_sales > 0 then round(a.waste / s.net_sales * 100, 2) end
  ) into v
  from agg a, sales s, theo th;
  return v || jsonb_build_object('variance_pct_points',
    case when (v ->> 'actual_pct') is not null then round((v ->> 'actual_pct')::numeric - (v ->> 'theoretical_pct')::numeric, 2) end);
end $$;

-- Product-level AvT between two moments (normally two posted counts).
create or replace function public.avt_by_product(p_location uuid, p_from timestamptz, p_to timestamptz)
returns table (
  product_id uuid, product_name text, category_name text, cost_group text, inventory_unit text,
  begin_qty numeric, received_qty numeric, transfer_qty numeric, produced_qty numeric, theoretical_qty numeric, waste_qty numeric,
  adjusted_qty numeric, expected_end_qty numeric, physical_end_qty numeric, variance_qty numeric, unit_cost numeric,
  variance_value numeric, theoretical_value numeric, counted boolean
)
language sql stable security definer set search_path = public as $$
  with allowed as (select 1 where p_location in (select app.user_location_ids())),
  t as (
    select t.product_id,
      coalesce(sum(t.quantity) filter (where t.txn_at <= p_from), 0) as begin_qty,
      coalesce(sum(t.quantity) filter (where t.txn_at > p_from and t.txn_at <= p_to and t.txn_type in ('RECEIPT', 'RETURN_TO_VENDOR')), 0) as received,
      coalesce(sum(t.quantity) filter (where t.txn_at > p_from and t.txn_at <= p_to and t.txn_type in ('TRANSFER_IN', 'TRANSFER_OUT')), 0) as transfers,
      coalesce(sum(t.quantity) filter (where t.txn_at > p_from and t.txn_at <= p_to and t.txn_type = 'PRODUCTION'), 0) as produced,
      coalesce(-sum(t.quantity) filter (where t.txn_at > p_from and t.txn_at <= p_to and t.txn_type in ('POS_CONSUMPTION', 'RECIPE_CONSUMPTION')), 0) as theo,
      coalesce(-sum(t.extended_cost) filter (where t.txn_at > p_from and t.txn_at <= p_to and t.txn_type in ('POS_CONSUMPTION', 'RECIPE_CONSUMPTION')), 0) as theo_value,
      coalesce(-sum(t.quantity) filter (where t.txn_at > p_from and t.txn_at <= p_to and t.txn_type = 'WASTE'), 0) as waste,
      coalesce(sum(t.quantity) filter (where t.txn_at > p_from and t.txn_at <= p_to and t.txn_type in ('MANUAL_ADJUSTMENT', 'CORRECTION')), 0) as adjusted,
      coalesce(sum(t.quantity) filter (where t.txn_at > p_from and t.txn_at <= p_to and t.txn_type = 'PHYSICAL_VARIANCE'), 0) as variance,
      coalesce(sum(t.extended_cost) filter (where t.txn_at > p_from and t.txn_at <= p_to and t.txn_type = 'PHYSICAL_VARIANCE'), 0) as variance_value,
      bool_or(t.txn_type = 'PHYSICAL_VARIANCE' and t.txn_at > p_from and t.txn_at <= p_to) as has_var,
      coalesce(sum(t.quantity) filter (where t.txn_at <= p_to), 0) as end_qty
    from public.inventory_transactions t, allowed
    where t.location_id = p_location and t.txn_at <= p_to
    group by t.product_id
  )
  select t.product_id, p.name, c.name, coalesce(c.cost_group, 'food'), u.code,
         t.begin_qty, t.received, t.transfers, t.produced, t.theo, t.waste, t.adjusted,
         t.end_qty - t.variance, t.end_qty, t.variance, app.current_unit_cost(p_location, t.product_id),
         round(t.variance_value, 2), round(t.theo_value, 2),
         coalesce(t.has_var, false) or exists (
           select 1 from public.count_posting_lines pl join public.count_sessions cs on cs.id = pl.session_id
           where pl.product_id = t.product_id and cs.location_id = p_location and cs.count_at > p_from and cs.count_at <= p_to and pl.counted)
  from t
  join public.products p on p.id = t.product_id
  join public.units u on u.id = p.inventory_unit_id
  left join public.categories c on c.id = p.category_id
$$;

select app.apply_grants();

-- Suggested prep: forecast usage of each prepped item over the horizon + safety - prepared on hand.
create or replace function public.suggested_prep(p_location uuid, p_days numeric default 1, p_safety_days numeric default 0.5)
returns table (recipe_id uuid, recipe_name text, product_id uuid, unit_code text, on_hand numeric, daily_usage numeric,
               need numeric, suggested_qty numeric, yield_qty numeric, shelf_life_hours integer)
language sql stable security definer set search_path = public as $$
  select r.id, r.name, r.product_id, u.code,
         coalesce(b.on_hand, 0), round(app.avg_daily_usage(p_location, r.product_id, 14), 4),
         round(app.avg_daily_usage(p_location, r.product_id, 14) * (p_days + p_safety_days), 4),
         greatest(0, round(app.avg_daily_usage(p_location, r.product_id, 14) * (p_days + p_safety_days) - greatest(coalesce(b.on_hand, 0), 0), 2)),
         r.yield_qty, r.shelf_life_hours
  from public.recipes r
  join public.products p on p.id = r.product_id
  join public.units u on u.id = p.inventory_unit_id
  left join public.inventory_balances b on b.location_id = p_location and b.product_id = r.product_id
  where r.organization_id = app.location_org(p_location) and r.active and p_location in (select app.user_location_ids())
  order by r.name
$$;
select app.apply_grants();
