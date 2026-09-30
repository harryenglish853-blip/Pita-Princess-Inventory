-- =====================================================================
-- FOUNDATION: tenancy hierarchy, profiles, roles & permissions, audit log
-- =====================================================================
-- Conventions used across all migrations
--   * Every tenant row carries organization_id; location-scoped rows also carry location_id.
--   * Quantities: numeric(18,4) in the product's inventory (base) unit.
--   * Money: numeric (never float). Unit costs numeric(18,6), extended values numeric(18,4).
--   * Business logic that touches inventory or money lives in SECURITY DEFINER
--     functions so each workflow is a single atomic database transaction.
--   * Helper functions live in schema "app" (not exposed through the REST API).

create schema if not exists app;
grant usage on schema app to authenticated, service_role;

create extension if not exists pg_trgm with schema extensions;

-- Table access is governed by RLS; make sure the API roles hold base privileges
-- (hosted Supabase already does this, the statements are idempotent).
alter default privileges in schema public grant select, insert, update, delete on tables to authenticated, service_role;
alter default privileges in schema public grant usage, select on sequences to authenticated, service_role;
alter default privileges in schema public grant execute on functions to authenticated, service_role;
alter default privileges in schema public revoke execute on functions from public;

-- ---------------------------------------------------------------------
-- Generic helpers
-- ---------------------------------------------------------------------
create or replace function app.touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

create or replace function app.prevent_mutation() returns trigger
language plpgsql as $$
begin
  raise exception '% rows are immutable (attempted %)', tg_table_name, tg_op
    using errcode = 'P0001';
end $$;

create or replace function app.request_header(p_name text) returns text
language sql stable as $$
  select nullif(current_setting('request.headers', true), '')::json ->> p_name
$$;

-- ---------------------------------------------------------------------
-- Tenancy: organization -> region -> district -> location
-- ---------------------------------------------------------------------
create table public.organizations (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(btrim(name)) > 0),
  slug        text unique,
  currency    text not null default 'USD',
  settings    jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table public.regions (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name            text not null,
  code            text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (organization_id, name)
);

create table public.districts (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  region_id       uuid references public.regions(id),
  name            text not null,
  code            text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (organization_id, name)
);

create table public.locations (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  region_id        uuid references public.regions(id),
  district_id      uuid references public.districts(id),
  market           text,
  code             text not null,
  name             text not null check (length(btrim(name)) > 0),
  timezone         text not null default 'America/New_York',
  address_line1    text,
  city             text,
  state            text,
  postal_code      text,
  phone            text,
  active           boolean not null default true,
  -- Operating tolerances (configurable per location)
  count_variance_pct_tolerance   numeric(8,2)  not null default 10   check (count_variance_pct_tolerance >= 0),
  count_variance_value_tolerance numeric(12,2) not null default 50   check (count_variance_value_tolerance >= 0),
  invoice_tolerance              numeric(12,2) not null default 1.00 check (invoice_tolerance >= 0),
  price_alert_pct                numeric(8,2)  not null default 5    check (price_alert_pct >= 0),
  receiving_temp_max_cold        numeric(6,2)  not null default 41,
  receiving_temp_max_frozen      numeric(6,2)  not null default 10,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (organization_id, code)
);
create index on public.locations (organization_id);
create index on public.locations (region_id);
create index on public.locations (district_id);

create trigger trg_organizations_touch before update on public.organizations for each row execute function app.touch_updated_at();
create trigger trg_regions_touch before update on public.regions for each row execute function app.touch_updated_at();
create trigger trg_districts_touch before update on public.districts for each row execute function app.touch_updated_at();
create trigger trg_locations_touch before update on public.locations for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------
-- Users
-- ---------------------------------------------------------------------
create table public.profiles (
  id                  uuid primary key references auth.users(id) on delete cascade,
  email               text,
  full_name           text,
  phone               text,
  default_location_id uuid references public.locations(id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create trigger trg_profiles_touch before update on public.profiles for each row execute function app.touch_updated_at();

create or replace function app.handle_new_auth_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data ->> 'full_name', split_part(new.email, '@', 1)))
  on conflict (id) do nothing;
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function app.handle_new_auth_user();

create table public.organization_members (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id         uuid not null references public.profiles(id) on delete cascade,
  employee_number text,
  active          boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  primary key (organization_id, user_id)
);
create index on public.organization_members (user_id);
create trigger trg_org_members_touch before update on public.organization_members for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------
-- Roles & permissions
-- ---------------------------------------------------------------------
create type public.scope_type as enum ('organization', 'region', 'district', 'location');

create table public.permissions (
  key         text primary key,
  module      text not null,
  description text not null,
  -- Master-data permissions only count when granted at organization scope.
  org_scope_only boolean not null default false
);

create table public.roles (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid references public.organizations(id) on delete cascade, -- null = built-in role
  key             text not null,
  name            text not null,
  description     text,
  rank            integer not null default 0,  -- higher = more authority; used to limit who can grant what
  created_at      timestamptz not null default now(),
  unique nulls not distinct (organization_id, key)
);

create table public.role_permissions (
  role_id        uuid not null references public.roles(id) on delete cascade,
  permission_key text not null references public.permissions(key) on delete cascade,
  primary key (role_id, permission_key)
);

create table public.user_roles (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id         uuid not null references public.profiles(id) on delete cascade,
  role_id         uuid not null references public.roles(id) on delete cascade,
  scope_type      public.scope_type not null,
  scope_id        uuid not null,
  created_by      uuid references public.profiles(id),
  created_at      timestamptz not null default now(),
  unique (user_id, role_id, scope_type, scope_id),
  check (scope_type <> 'organization' or scope_id = organization_id)
);
create index on public.user_roles (user_id);
create index on public.user_roles (organization_id);

insert into public.permissions (key, module, description, org_scope_only) values
  ('inventory.view',            'inventory',  'View inventory quantities and item master', false),
  ('inventory.count',           'inventory',  'Enter physical inventory counts', false),
  ('inventory.review',          'inventory',  'Review counts and request recounts', false),
  ('inventory.post',            'inventory',  'Post physical inventory (creates variance transactions)', false),
  ('inventory.adjust',          'inventory',  'Create manual inventory adjustments', false),
  ('inventory.settings',        'inventory',  'Manage storage areas, shelf-to-sheet order, pars', false),
  ('inventory.transfer',        'inventory',  'Create and receive inventory transfers', false),
  ('waste.log',                 'inventory',  'Log waste', false),
  ('products.edit',             'catalog',    'Create/edit corporate products, units, categories', true),
  ('products.local_edit',       'catalog',    'Edit local product settings (par, local vendor, storage)', false),
  ('vendors.edit',              'purchasing', 'Create/edit vendors and order guides', true),
  ('orders.view',               'purchasing', 'View purchase orders and receipts', false),
  ('orders.create',             'purchasing', 'Create and edit purchase orders', false),
  ('orders.submit',             'purchasing', 'Submit purchase orders to vendors', false),
  ('orders.receive',            'purchasing', 'Receive deliveries', false),
  ('orders.reconcile',          'purchasing', 'Reconcile and post invoices', false),
  ('orders.reconcile_override', 'purchasing', 'Post invoices outside tolerance / override temperature failures', false),
  ('recipes.view',              'recipes',    'View recipes and costs', false),
  ('recipes.edit',              'recipes',    'Create/edit corporate recipes and menu items', true),
  ('production.log',            'recipes',    'Record prep/production batches', false),
  ('sales.import',              'sales',      'Import POS sales', false),
  ('forecast.edit',             'sales',      'Edit forecasts and dynamic par settings', false),
  ('reports.view',              'reports',    'View operational reports', false),
  ('reports.view_cost',         'reports',    'View cost and dollar values', false),
  ('reports.view_corporate',    'reports',    'View consolidated multi-location reports', false),
  ('tasks.manage',              'operations', 'Create and assign tasks', false),
  ('users.manage',              'admin',      'Invite users and assign roles', false),
  ('locations.manage',          'admin',      'Create/edit locations and hierarchy', true),
  ('settings.manage',           'admin',      'Change organization settings and tolerances', false),
  ('audit.view',                'admin',      'View the audit log', false);

insert into public.roles (organization_id, key, name, description, rank) values
  (null, 'system_owner',      'System Owner',      'Full control of the organization', 100),
  (null, 'corporate_admin',   'Corporate Admin',   'Manages corporate master data and all locations', 90),
  (null, 'regional_manager',  'Regional Manager',  'Oversees locations in a region', 70),
  (null, 'district_manager',  'District Manager',  'Oversees locations in a district', 60),
  (null, 'general_manager',   'General Manager',   'Runs a restaurant', 50),
  (null, 'kitchen_manager',   'Kitchen Manager',   'Kitchen inventory, ordering and prep', 40),
  (null, 'bar_manager',       'Bar Manager',       'Bar inventory and ordering', 40),
  (null, 'inventory_manager', 'Inventory Manager', 'Counts, posting and receiving', 40),
  (null, 'accounting',        'Accounting',        'Invoice reconciliation and cost reporting', 30),
  (null, 'employee',          'Employee',          'Counts, receives deliveries and logs waste', 10),
  (null, 'read_only',         'Read Only',         'View-only access', 5);

insert into public.role_permissions (role_id, permission_key)
select r.id, p.key
from public.roles r
join public.permissions p on (
  case r.key
    when 'system_owner'      then true
    when 'corporate_admin'   then true
    when 'regional_manager'  then p.key not in ('products.edit','vendors.edit','recipes.edit','locations.manage','settings.manage')
    when 'district_manager'  then p.key not in ('products.edit','vendors.edit','recipes.edit','locations.manage','settings.manage')
    when 'general_manager'   then p.key not in ('products.edit','vendors.edit','recipes.edit','locations.manage','reports.view_corporate')
    when 'kitchen_manager'   then p.key in ('inventory.view','inventory.count','inventory.review','inventory.post','inventory.adjust','inventory.settings','inventory.transfer','waste.log','products.local_edit','orders.view','orders.create','orders.submit','orders.receive','recipes.view','production.log','sales.import','forecast.edit','reports.view','reports.view_cost','tasks.manage')
    when 'bar_manager'       then p.key in ('inventory.view','inventory.count','inventory.review','inventory.post','inventory.adjust','inventory.settings','inventory.transfer','waste.log','products.local_edit','orders.view','orders.create','orders.submit','orders.receive','recipes.view','production.log','reports.view','reports.view_cost','tasks.manage')
    when 'inventory_manager' then p.key in ('inventory.view','inventory.count','inventory.review','inventory.post','inventory.adjust','inventory.settings','inventory.transfer','waste.log','orders.view','orders.create','orders.receive','orders.reconcile','recipes.view','production.log','reports.view','reports.view_cost')
    when 'accounting'        then p.key in ('inventory.view','orders.view','orders.reconcile','orders.reconcile_override','recipes.view','reports.view','reports.view_cost','reports.view_corporate','audit.view')
    when 'employee'          then p.key in ('inventory.view','inventory.count','waste.log','orders.view','orders.receive','production.log','recipes.view')
    when 'read_only'         then p.key in ('inventory.view','orders.view','recipes.view','reports.view')
    else false
  end);

-- ---------------------------------------------------------------------
-- Authorization helpers (used by RLS policies and RPCs)
-- ---------------------------------------------------------------------
create or replace function app.user_org_ids() returns setof uuid
language sql stable security definer set search_path = public as $$
  select organization_id from public.organization_members
  where user_id = auth.uid() and active
$$;

-- Locations visible to the current user, expanded through the hierarchy.
create or replace function app.user_location_ids() returns setof uuid
language sql stable security definer set search_path = public as $$
  select distinct l.id
  from public.user_roles ur
  join public.organization_members m on m.organization_id = ur.organization_id and m.user_id = ur.user_id and m.active
  join public.locations l on l.organization_id = ur.organization_id
  where ur.user_id = auth.uid()
    and (   ur.scope_type = 'organization'
         or (ur.scope_type = 'region'   and ur.scope_id = l.region_id)
         or (ur.scope_type = 'district' and ur.scope_id = l.district_id)
         or (ur.scope_type = 'location' and ur.scope_id = l.id))
$$;

create or replace function app.has_permission(p_perm text, p_location uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1
    from public.locations l
    join public.user_roles ur on ur.organization_id = l.organization_id and ur.user_id = auth.uid()
    join public.organization_members m on m.organization_id = l.organization_id and m.user_id = ur.user_id and m.active
    join public.role_permissions rp on rp.role_id = ur.role_id and rp.permission_key = p_perm
    join public.permissions p on p.key = rp.permission_key
    where l.id = p_location
      and (   ur.scope_type = 'organization'
           or (not p.org_scope_only and (
                  (ur.scope_type = 'region'   and ur.scope_id = l.region_id)
               or (ur.scope_type = 'district' and ur.scope_id = l.district_id)
               or (ur.scope_type = 'location' and ur.scope_id = l.id))))
  )
$$;

-- Permission granted at organization scope (required for corporate master data).
create or replace function app.has_org_permission(p_perm text, p_org uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1
    from public.user_roles ur
    join public.organization_members m on m.organization_id = ur.organization_id and m.user_id = ur.user_id and m.active
    join public.role_permissions rp on rp.role_id = ur.role_id and rp.permission_key = p_perm
    where ur.user_id = auth.uid() and ur.organization_id = p_org and ur.scope_type = 'organization'
  )
$$;

-- Permission granted at any scope inside the organization.
create or replace function app.has_any_permission(p_perm text, p_org uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1
    from public.user_roles ur
    join public.organization_members m on m.organization_id = ur.organization_id and m.user_id = ur.user_id and m.active
    join public.role_permissions rp on rp.role_id = ur.role_id and rp.permission_key = p_perm
    where ur.user_id = auth.uid() and ur.organization_id = p_org
  )
$$;

create or replace function app.require_permission(p_perm text, p_location uuid) returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  if not app.has_permission(p_perm, p_location) then
    raise exception 'Permission denied: % is required for this location', p_perm using errcode = '42501';
  end if;
end $$;

create or replace function app.require_org_permission(p_perm text, p_org uuid) returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  if not app.has_org_permission(p_perm, p_org) then
    raise exception 'Permission denied: % at organization level is required', p_perm using errcode = '42501';
  end if;
end $$;

create or replace function app.location_org(p_location uuid) returns uuid
language sql stable security definer set search_path = public as $$
  select organization_id from public.locations where id = p_location
$$;

-- Business date for a timestamp in the location's timezone.
create or replace function app.business_date(p_location uuid, p_at timestamptz) returns date
language sql stable security definer set search_path = public as $$
  select (p_at at time zone coalesce((select timezone from public.locations where id = p_location), 'UTC'))::date
$$;

grant execute on all functions in schema app to authenticated, service_role;

-- ---------------------------------------------------------------------
-- Audit log (append-only)
-- ---------------------------------------------------------------------
create table public.audit_logs (
  id              bigint generated always as identity primary key,
  organization_id uuid,
  location_id     uuid,
  user_id         uuid,
  action          text not null,
  entity_type     text not null,
  entity_id       text,
  summary         text,
  old_value       jsonb,
  new_value       jsonb,
  device_id       text,
  user_agent      text,
  ip_address      text,
  created_at      timestamptz not null default now()
);
create index on public.audit_logs (organization_id, created_at desc);
create index on public.audit_logs (location_id, created_at desc);
create index on public.audit_logs (entity_type, entity_id);
create trigger trg_audit_logs_immutable before update or delete on public.audit_logs
  for each row execute function app.prevent_mutation();

create or replace function app.audit(
  p_org uuid, p_location uuid, p_action text, p_entity_type text, p_entity_id text,
  p_summary text, p_old jsonb default null, p_new jsonb default null
) returns void
language plpgsql security definer set search_path = public as $$
begin
  insert into public.audit_logs (organization_id, location_id, user_id, action, entity_type, entity_id, summary,
                                 old_value, new_value, device_id, user_agent, ip_address)
  values (p_org, p_location, auth.uid(), p_action, p_entity_type, p_entity_id, p_summary, p_old, p_new,
          app.request_header('x-device-id'), app.request_header('user-agent'),
          split_part(coalesce(app.request_header('x-forwarded-for'), ''), ',', 1));
end $$;

-- Row-level audit trigger for master data: records only the changed columns.
create or replace function app.audit_row() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_old jsonb := case when tg_op in ('UPDATE','DELETE') then to_jsonb(old) end;
  v_new jsonb := case when tg_op in ('INSERT','UPDATE') then to_jsonb(new) end;
  v_row jsonb := coalesce(v_new, v_old);
  v_old_diff jsonb;
  v_new_diff jsonb;
  k text;
begin
  if tg_op = 'UPDATE' then
    v_old_diff := '{}'::jsonb; v_new_diff := '{}'::jsonb;
    for k in select jsonb_object_keys(v_new) loop
      if k not in ('updated_at') and (v_old -> k) is distinct from (v_new -> k) then
        v_old_diff := v_old_diff || jsonb_build_object(k, v_old -> k);
        v_new_diff := v_new_diff || jsonb_build_object(k, v_new -> k);
      end if;
    end loop;
    if v_new_diff = '{}'::jsonb then return new; end if;
  else
    v_old_diff := v_old; v_new_diff := v_new;
  end if;
  perform app.audit(
    (v_row ->> 'organization_id')::uuid,
    nullif(v_row ->> 'location_id', '')::uuid,
    lower(tg_op), tg_table_name, v_row ->> 'id',
    coalesce(v_row ->> 'name', v_row ->> 'code', null),
    v_old_diff, v_new_diff);
  return coalesce(new, old);
end $$;

-- ---------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------
alter table public.organizations        enable row level security;
alter table public.regions              enable row level security;
alter table public.districts            enable row level security;
alter table public.locations            enable row level security;
alter table public.profiles             enable row level security;
alter table public.organization_members enable row level security;
alter table public.permissions          enable row level security;
alter table public.roles                enable row level security;
alter table public.role_permissions     enable row level security;
alter table public.user_roles           enable row level security;
alter table public.audit_logs           enable row level security;

create policy org_select on public.organizations for select to authenticated
  using (id in (select app.user_org_ids()));
create policy org_update on public.organizations for update to authenticated
  using (app.has_org_permission('settings.manage', id)) with check (app.has_org_permission('settings.manage', id));

create policy regions_select on public.regions for select to authenticated
  using (organization_id in (select app.user_org_ids()));
create policy regions_write on public.regions for all to authenticated
  using (app.has_org_permission('locations.manage', organization_id))
  with check (app.has_org_permission('locations.manage', organization_id));

create policy districts_select on public.districts for select to authenticated
  using (organization_id in (select app.user_org_ids()));
create policy districts_write on public.districts for all to authenticated
  using (app.has_org_permission('locations.manage', organization_id))
  with check (app.has_org_permission('locations.manage', organization_id));

create policy locations_select on public.locations for select to authenticated
  using (id in (select app.user_location_ids()) or app.has_org_permission('locations.manage', organization_id));
create policy locations_insert on public.locations for insert to authenticated
  with check (app.has_org_permission('locations.manage', organization_id));
create policy locations_update on public.locations for update to authenticated
  using (app.has_org_permission('locations.manage', organization_id) or app.has_permission('settings.manage', id))
  with check (app.has_org_permission('locations.manage', organization_id) or app.has_permission('settings.manage', id));

-- Profiles: yourself, plus colleagues in your organizations.
create policy profiles_select on public.profiles for select to authenticated
  using (id = auth.uid() or id in (select m.user_id from public.organization_members m where m.organization_id in (select app.user_org_ids())));
create policy profiles_update_self on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

create policy members_select on public.organization_members for select to authenticated
  using (organization_id in (select app.user_org_ids()));

create policy permissions_select on public.permissions for select to authenticated using (true);
create policy roles_select on public.roles for select to authenticated
  using (organization_id is null or organization_id in (select app.user_org_ids()));
create policy role_permissions_select on public.role_permissions for select to authenticated using (true);

create policy user_roles_select on public.user_roles for select to authenticated
  using (user_id = auth.uid() or app.has_any_permission('users.manage', organization_id));

create policy audit_select on public.audit_logs for select to authenticated
  using (organization_id in (select app.user_org_ids())
         and (app.has_org_permission('audit.view', organization_id)
              or (location_id is not null and app.has_permission('audit.view', location_id))));

-- ---------------------------------------------------------------------
-- Session context RPC: everything the app shell needs in one round trip
-- ---------------------------------------------------------------------
create or replace function public.get_session_context() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then return null; end if;
  return jsonb_build_object(
    'user', (select to_jsonb(p) from public.profiles p where p.id = v_uid),
    'organizations', coalesce((select jsonb_agg(jsonb_build_object('id', o.id, 'name', o.name, 'currency', o.currency) order by o.name)
                        from public.organizations o where o.id in (select app.user_org_ids())), '[]'::jsonb),
    'locations', coalesce((select jsonb_agg(jsonb_build_object(
                        'id', l.id, 'organization_id', l.organization_id, 'code', l.code, 'name', l.name,
                        'timezone', l.timezone, 'region_id', l.region_id, 'district_id', l.district_id, 'market', l.market,
                        'permissions', (select coalesce(jsonb_agg(distinct rp.permission_key), '[]'::jsonb)
                                        from public.user_roles ur
                                        join public.role_permissions rp on rp.role_id = ur.role_id
                                        join public.permissions pm on pm.key = rp.permission_key
                                        where ur.user_id = v_uid and ur.organization_id = l.organization_id
                                          and (ur.scope_type = 'organization'
                                               or (not pm.org_scope_only and (
                                                     (ur.scope_type = 'region' and ur.scope_id = l.region_id)
                                                  or (ur.scope_type = 'district' and ur.scope_id = l.district_id)
                                                  or (ur.scope_type = 'location' and ur.scope_id = l.id))))))
                        order by l.code)
                      from public.locations l where l.id in (select app.user_location_ids()) and l.active), '[]'::jsonb),
    'org_permissions', coalesce((select jsonb_agg(distinct jsonb_build_object('organization_id', ur.organization_id, 'permission', rp.permission_key))
                        from public.user_roles ur join public.role_permissions rp on rp.role_id = ur.role_id
                        join public.organization_members m on m.organization_id = ur.organization_id and m.user_id = ur.user_id and m.active
                        where ur.user_id = v_uid and ur.scope_type = 'organization'), '[]'::jsonb),
    'roles', coalesce((select jsonb_agg(jsonb_build_object('role', r.key, 'name', r.name, 'scope_type', ur.scope_type, 'scope_id', ur.scope_id))
                        from public.user_roles ur join public.roles r on r.id = ur.role_id where ur.user_id = v_uid), '[]'::jsonb)
  );
end $$;

-- Onboarding: a signed-in user with no organization creates one and becomes its System Owner.
create or replace function public.create_organization(p_name text, p_location_name text, p_location_code text, p_timezone text default 'America/New_York')
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_org uuid;
  v_loc uuid;
begin
  if v_uid is null then raise exception 'Not signed in' using errcode = '42501'; end if;
  if coalesce(btrim(p_name), '') = '' or coalesce(btrim(p_location_name), '') = '' or coalesce(btrim(p_location_code), '') = '' then
    raise exception 'Organization name, location name and location code are required';
  end if;
  insert into public.organizations (name) values (btrim(p_name)) returning id into v_org;
  insert into public.locations (organization_id, code, name, timezone) values (v_org, btrim(p_location_code), btrim(p_location_name), p_timezone) returning id into v_loc;
  insert into public.organization_members (organization_id, user_id) values (v_org, v_uid);
  insert into public.user_roles (organization_id, user_id, role_id, scope_type, scope_id, created_by)
  select v_org, v_uid, id, 'organization', v_org, v_uid from public.roles where organization_id is null and key = 'system_owner';
  update public.profiles set default_location_id = v_loc where id = v_uid;
  perform app.provision_organization(v_org);
  perform app.audit(v_org, v_loc, 'create', 'organization', v_org::text, p_name, null, null);
  return v_org;
end $$;

-- Filled in by later migrations (default units, reasons, etc.). Kept as a hook.
create or replace function app.provision_organization(p_org uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  null;
end $$;

-- ---------------------------------------------------------------------
-- Grants. Table access is governed by RLS; tables registered in
-- app.write_protected_tables (ledger, audit, history) can only be written
-- by SECURITY DEFINER functions. Every migration ends with apply_grants().
-- ---------------------------------------------------------------------
create table app.write_protected_tables (table_name text primary key);
insert into app.write_protected_tables values ('audit_logs');

create or replace function app.apply_grants() returns void
language plpgsql as $$
declare t text;
begin
  execute 'grant select, insert, update, delete on all tables in schema public to authenticated, service_role';
  execute 'grant usage, select on all sequences in schema public to authenticated, service_role';
  execute 'grant execute on all functions in schema public to authenticated, service_role';
  execute 'revoke execute on all functions in schema public from anon, public';
  execute 'grant execute on all functions in schema app to authenticated, service_role';
  for t in select table_name from app.write_protected_tables loop
    execute format('revoke insert, update, delete on public.%I from authenticated', t);
  end loop;
end $$;

select app.apply_grants();
