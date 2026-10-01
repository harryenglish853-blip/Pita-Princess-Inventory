-- =====================================================================
-- SHARED EMPLOYEE LOGIN: "Who are you?" + personal 4-digit PIN
--
-- A shared login (organization_members.shared_login) can sign in, but it
-- cannot change anything until a person picks their name and enters their
-- PIN. That creates an employee session; its random token travels with every
-- request in the `x-employee-session` header. The token is only valid for
-- the auth user that created it, so it identifies a person but grants nothing
-- by itself. Every ledger row, audit entry, waste log and count entry
-- records the employee.
-- =====================================================================

create extension if not exists pgcrypto with schema extensions;

alter table public.organization_members add column if not exists shared_login boolean not null default false;

create table public.employees (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  location_id     uuid references public.locations(id) on delete cascade,  -- null = every location
  display_name    text not null check (length(btrim(display_name)) between 1 and 40),
  active          boolean not null default true,
  failed_attempts integer not null default 0,
  locked_until    timestamptz,
  created_by      uuid references public.profiles(id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
-- Names must be distinguishable on the "Who are you?" screen.
create unique index employees_name_uniq on public.employees (organization_id, lower(btrim(display_name)));
create trigger trg_employees_touch before update on public.employees for each row execute function app.touch_updated_at();

-- PIN hashes live outside the API schema: a 4-digit PIN hash is trivially
-- brute-forced, so no API role may ever read one.
create table app.employee_pins (
  employee_id uuid primary key references public.employees(id) on delete cascade,
  pin_hash    text not null,
  updated_at  timestamptz not null default now()
);
revoke all on app.employee_pins from public, authenticated, anon, service_role;

create table public.employee_sessions (
  token_hash      text primary key,          -- sha256 of the token; the token itself is never stored
  organization_id uuid not null references public.organizations(id) on delete cascade,
  employee_id     uuid not null references public.employees(id) on delete cascade,
  user_id         uuid not null references public.profiles(id) on delete cascade,
  device_id       text,
  created_at      timestamptz not null default now(),
  expires_at      timestamptz not null,
  ended_at        timestamptz
);
create index on public.employee_sessions (employee_id);
create index on public.employee_sessions (user_id, created_at desc);

insert into app.write_protected_tables values ('employees'), ('employee_sessions');

alter table public.employees enable row level security;
alter table public.employee_sessions enable row level security;
create policy employees_select on public.employees for select to authenticated
  using (app.has_any_permission('users.manage', organization_id));
create policy employee_sessions_select on public.employee_sessions for select to authenticated
  using (app.has_any_permission('users.manage', organization_id));

-- ---------------------------------------------------------------------
-- Who is acting right now?
-- ---------------------------------------------------------------------
create or replace function app.employee_token_hash(p_token text) returns text
language sql immutable as $$
  select encode(sha256(convert_to(p_token, 'UTF8')), 'hex')
$$;

create or replace function app.current_employee_id() returns uuid
language sql stable security definer set search_path = public as $$
  select s.employee_id
  from public.employee_sessions s
  join public.employees e on e.id = s.employee_id and e.active
  where s.token_hash = app.employee_token_hash(nullif(app.request_header('x-employee-session'), ''))
    and s.user_id = auth.uid()
    and s.ended_at is null
    and s.expires_at > now()
$$;

create or replace function app.is_shared_login(p_org uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select shared_login from public.organization_members
                   where organization_id = p_org and user_id = auth.uid() and active), false)
$$;

-- Shared logins must identify a person before any change is recorded.
create or replace function app.require_actor(p_org uuid) returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is not null and app.is_shared_login(p_org) and app.current_employee_id() is null then
    raise exception 'Select your name and enter your PIN before making changes' using errcode = '42501';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- Record the employee on every critical row
-- ---------------------------------------------------------------------
alter table public.audit_logs             add column if not exists employee_id uuid references public.employees(id);
alter table public.inventory_transactions add column if not exists employee_id uuid references public.employees(id);
alter table public.waste_logs             add column if not exists employee_id uuid references public.employees(id);
alter table public.count_entries          add column if not exists employee_id uuid references public.employees(id);
alter table public.count_entry_revisions  add column if not exists employee_id uuid references public.employees(id);
alter table public.receipts               add column if not exists employee_id uuid references public.employees(id);
alter table public.inventory_transfers    add column if not exists employee_id uuid references public.employees(id);

alter table public.audit_logs             alter column employee_id set default app.current_employee_id();
alter table public.inventory_transactions alter column employee_id set default app.current_employee_id();
alter table public.waste_logs             alter column employee_id set default app.current_employee_id();
alter table public.count_entry_revisions  alter column employee_id set default app.current_employee_id();
alter table public.receipts               alter column employee_id set default app.current_employee_id();
alter table public.inventory_transfers    alter column employee_id set default app.current_employee_id();
create index on public.waste_logs (employee_id);

-- Count entries are updated in place (revisions keep history): keep the
-- current counter's employee on every write.
create or replace function app.count_entries_employee() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' or new.counted_by is distinct from old.counted_by or new.counted_at is distinct from old.counted_at
     or new.quantity is distinct from old.quantity then
    new.employee_id := app.current_employee_id();
  end if;
  return new;
end $$;
create trigger trg_count_entries_employee before insert or update on public.count_entries
  for each row execute function app.count_entries_employee();

create or replace function app.count_entries_require_actor() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform app.require_actor(new.organization_id);
  return new;
end $$;
create trigger trg_count_entries_actor before insert or update on public.count_entries
  for each row execute function app.count_entries_require_actor();

-- Audit: refuse unidentified shared logins; record the employee.
create or replace function app.audit(
  p_org uuid, p_location uuid, p_action text, p_entity_type text, p_entity_id text,
  p_summary text, p_old jsonb default null, p_new jsonb default null
) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform app.require_actor(p_org);
  insert into public.audit_logs (organization_id, location_id, user_id, employee_id, action, entity_type, entity_id, summary,
                                 old_value, new_value, device_id, user_agent, ip_address)
  values (p_org, p_location, auth.uid(), app.current_employee_id(), p_action, p_entity_type, p_entity_id, p_summary, p_old, p_new,
          app.request_header('x-device-id'), app.request_header('user-agent'),
          split_part(coalesce(app.request_header('x-forwarded-for'), ''), ',', 1));
end $$;

-- Ledger: same rule. Every movement names a person.
create or replace function app.post_inventory_txn(
  p_location uuid, p_product uuid, p_type public.inv_txn_type, p_qty numeric, p_unit_cost numeric,
  p_txn_at timestamptz, p_source_type text, p_source_id uuid, p_source_line_id uuid default null,
  p_storage uuid default null, p_reason text default null, p_reference text default null,
  p_notes text default null, p_lot uuid default null
) returns bigint
language plpgsql security definer set search_path = public as $$
declare
  v_id bigint;
  v_org uuid := app.location_org(p_location);
begin
  if p_qty is null or p_qty = 0 then return null; end if;
  if not exists (select 1 from public.products where id = p_product and organization_id = v_org) then
    raise exception 'Product does not belong to this organization';
  end if;
  perform app.require_actor(v_org);
  insert into public.inventory_transactions (organization_id, location_id, product_id, storage_location_id, txn_type,
    quantity, unit_cost, txn_at, business_date, source_type, source_id, source_line_id, reason_code, reference, notes, lot_id, created_by, employee_id)
  values (v_org, p_location, p_product, p_storage, p_type, round(p_qty, 4), round(greatest(coalesce(p_unit_cost, 0), 0), 6),
    p_txn_at, app.business_date(p_location, p_txn_at), p_source_type, p_source_id, p_source_line_id, p_reason, p_reference, p_notes, p_lot,
    auth.uid(), app.current_employee_id())
  returning id into v_id;
  return v_id;
end $$;

-- ---------------------------------------------------------------------
-- PIN rules
-- ---------------------------------------------------------------------
create or replace function app.check_pin(p_pin text) returns void
language plpgsql immutable as $$
begin
  if p_pin is null or p_pin !~ '^[0-9]{4}$' then
    raise exception 'The PIN must be exactly 4 digits' using errcode = '22023';
  end if;
  if p_pin ~ '^(.)\1{3}$' or p_pin in ('0123', '1234', '2345', '3456', '4567', '5678', '6789', '9876', '8765', '7654', '6543', '5432', '4321', '3210') then
    raise exception 'That PIN is too easy to guess. Avoid repeated or sequential digits.' using errcode = '22023';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- The "Who are you?" screen
-- ---------------------------------------------------------------------
create or replace function public.list_pin_employees(p_location uuid)
returns table (id uuid, display_name text, locked boolean)
language sql stable security definer set search_path = public as $$
  select e.id, e.display_name, coalesce(e.locked_until > now(), false)
  from public.employees e
  where e.active
    and e.organization_id = app.location_org(p_location)
    and (e.location_id is null or e.location_id = p_location)
    and p_location in (select app.user_location_ids())
  order by lower(e.display_name)
$$;

-- Verifies the PIN and starts an employee session. Returns (never raises on a
-- wrong PIN) so the failed-attempt counter is committed.
create or replace function public.start_employee_session(p_employee uuid, p_pin text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_e public.employees;
  v_token text;
  v_expires timestamptz := now() + interval '12 hours';
  v_recent integer;
  v_hash text;
begin
  if v_uid is null then raise exception 'Not signed in' using errcode = '42501'; end if;
  select * into v_e from public.employees where id = p_employee for update;
  if v_e.id is null or not v_e.active
     or not exists (select 1 from public.organization_members where organization_id = v_e.organization_id and user_id = v_uid and active) then
    return jsonb_build_object('ok', false, 'error', 'Employee not found');
  end if;
  -- Device-level throttle: too many wrong PINs from this login in 10 minutes.
  select count(*) into v_recent from public.audit_logs
   where user_id = v_uid and action = 'pin_failed' and created_at > now() - interval '10 minutes';
  if v_recent >= 15 then
    return jsonb_build_object('ok', false, 'error', 'Too many wrong PINs. Wait 10 minutes or ask a manager.');
  end if;
  if v_e.locked_until is not null and v_e.locked_until > now() then
    return jsonb_build_object('ok', false, 'locked', true,
      'error', format('Locked after too many wrong PINs. Try again in %s minute(s) or ask a manager.',
                      ceil(extract(epoch from v_e.locked_until - now()) / 60)::int));
  end if;
  select pin_hash into v_hash from app.employee_pins where employee_id = v_e.id;
  if p_pin is null or v_hash is null or v_hash <> extensions.crypt(p_pin, v_hash) then
    update public.employees
       set failed_attempts = failed_attempts + 1,
           locked_until = case when failed_attempts + 1 >= 5 then now() + interval '5 minutes' end
     where id = v_e.id;
    insert into public.audit_logs (organization_id, user_id, employee_id, action, entity_type, entity_id, summary, device_id, user_agent, ip_address)
    values (v_e.organization_id, v_uid, v_e.id, 'pin_failed', 'employee', v_e.id::text, 'Wrong PIN for ' || v_e.display_name,
            app.request_header('x-device-id'), app.request_header('user-agent'), split_part(coalesce(app.request_header('x-forwarded-for'), ''), ',', 1));
    return jsonb_build_object('ok', false, 'error', 'Incorrect PIN',
      'attempts_left', greatest(5 - (v_e.failed_attempts + 1), 0));
  end if;

  update public.employees set failed_attempts = 0, locked_until = null where id = v_e.id;
  -- One active session per person per login: signing in again ends the previous one.
  update public.employee_sessions set ended_at = now()
   where user_id = v_uid and employee_id = v_e.id and ended_at is null;
  v_token := encode(extensions.gen_random_bytes(32), 'hex');
  insert into public.employee_sessions (token_hash, organization_id, employee_id, user_id, device_id, expires_at)
  values (app.employee_token_hash(v_token), v_e.organization_id, v_e.id, v_uid, app.request_header('x-device-id'), v_expires);
  insert into public.audit_logs (organization_id, user_id, employee_id, action, entity_type, entity_id, summary, device_id, user_agent, ip_address)
  values (v_e.organization_id, v_uid, v_e.id, 'identify', 'employee', v_e.id::text, v_e.display_name || ' started a shift session',
          app.request_header('x-device-id'), app.request_header('user-agent'), split_part(coalesce(app.request_header('x-forwarded-for'), ''), ',', 1));
  return jsonb_build_object('ok', true, 'token', v_token, 'employee_id', v_e.id, 'display_name', v_e.display_name, 'expires_at', v_expires);
end $$;

create or replace function public.end_employee_session() returns void
language plpgsql security definer set search_path = public as $$
begin
  update public.employee_sessions set ended_at = now()
   where token_hash = app.employee_token_hash(nullif(app.request_header('x-employee-session'), ''))
     and user_id = auth.uid() and ended_at is null;
end $$;

-- ---------------------------------------------------------------------
-- Managing employees and shared logins
-- ---------------------------------------------------------------------
create or replace function app.require_employee_admin(p_org uuid, p_location uuid) returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if p_location is null then
    perform app.require_org_permission('users.manage', p_org);
  else
    if app.location_org(p_location) is distinct from p_org then raise exception 'Location not in organization'; end if;
    perform app.require_permission('users.manage', p_location);
  end if;
end $$;

-- Creates (p_id null) or updates an employee. p_pin null keeps the current PIN.
create or replace function public.save_employee(p_org uuid, p_id uuid, p_name text, p_location uuid, p_pin text, p_active boolean default true)
returns uuid
language plpgsql security definer set search_path = public as $$
declare v_old public.employees; v_id uuid; v_name text := btrim(coalesce(p_name, ''));
begin
  if v_name = '' then raise exception 'Name is required'; end if;
  if p_id is null then
    perform app.require_employee_admin(p_org, p_location);
    perform app.check_pin(p_pin);
    insert into public.employees (organization_id, location_id, display_name, active, created_by)
    values (p_org, p_location, v_name, coalesce(p_active, true), auth.uid())
    returning id into v_id;
    insert into app.employee_pins (employee_id, pin_hash) values (v_id, extensions.crypt(p_pin, extensions.gen_salt('bf', 8)));
    perform app.audit(p_org, p_location, 'create', 'employee', v_id::text, 'Added employee ' || v_name, null,
                      jsonb_build_object('name', v_name, 'location_id', p_location));
    return v_id;
  end if;
  select * into v_old from public.employees where id = p_id and organization_id = p_org for update;
  if v_old.id is null then raise exception 'Employee not found'; end if;
  perform app.require_employee_admin(p_org, v_old.location_id);
  perform app.require_employee_admin(p_org, p_location);
  if p_pin is not null and p_pin <> '' then perform app.check_pin(p_pin); end if;
  update public.employees set
    display_name = v_name, location_id = p_location, active = coalesce(p_active, active),
    failed_attempts = case when coalesce(p_pin, '') <> '' then 0 else failed_attempts end,
    locked_until = case when coalesce(p_pin, '') <> '' then null else locked_until end
  where id = p_id;
  if coalesce(p_pin, '') <> '' then
    update app.employee_pins set pin_hash = extensions.crypt(p_pin, extensions.gen_salt('bf', 8)), updated_at = now() where employee_id = p_id;
    -- a new PIN ends sessions started with the old one
    update public.employee_sessions set ended_at = now() where employee_id = p_id and ended_at is null;
  end if;
  if not coalesce(p_active, true) then
    update public.employee_sessions set ended_at = now() where employee_id = p_id and ended_at is null;
  end if;
  perform app.audit(p_org, p_location, 'update', 'employee', p_id::text, 'Updated employee ' || v_name,
    jsonb_build_object('name', v_old.display_name, 'location_id', v_old.location_id, 'active', v_old.active),
    jsonb_build_object('name', v_name, 'location_id', p_location, 'active', coalesce(p_active, v_old.active),
                       'pin_changed', coalesce(p_pin, '') <> ''));
  return p_id;
end $$;

create or replace function public.unlock_employee(p_employee uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_e public.employees;
begin
  select * into v_e from public.employees where id = p_employee;
  if v_e.id is null then raise exception 'Employee not found'; end if;
  perform app.require_employee_admin(v_e.organization_id, v_e.location_id);
  update public.employees set failed_attempts = 0, locked_until = null where id = p_employee;
  perform app.audit(v_e.organization_id, v_e.location_id, 'unlock', 'employee', p_employee::text, 'Unlocked PIN for ' || v_e.display_name, null, null);
end $$;

create or replace function public.list_employees(p_org uuid)
returns table (id uuid, display_name text, location_id uuid, location_name text, active boolean, locked boolean,
               last_seen timestamptz, actions_30d bigint)
language sql stable security definer set search_path = public as $$
  select e.id, e.display_name, e.location_id, l.code || ' ' || l.name, e.active, coalesce(e.locked_until > now(), false),
         (select max(s.created_at) from public.employee_sessions s where s.employee_id = e.id),
         (select count(*) from public.audit_logs a where a.employee_id = e.id and a.created_at > now() - interval '30 days'
            and a.action not in ('identify', 'pin_failed'))
  from public.employees e left join public.locations l on l.id = e.location_id
  where e.organization_id = p_org and app.has_any_permission('users.manage', p_org)
  order by e.active desc, lower(e.display_name)
$$;

create or replace function public.set_shared_login(p_org uuid, p_user uuid, p_shared boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform app.require_org_permission('users.manage', p_org);
  if p_user = auth.uid() and p_shared then raise exception 'You cannot make your own login shared'; end if;
  if p_shared and exists (select 1 from public.user_roles ur join public.roles r on r.id = ur.role_id
                          where ur.user_id = p_user and ur.organization_id = p_org and r.rank > 10) then
    raise exception 'Only Employee or Read Only logins can be shared. Managers and owners need their own login.';
  end if;
  update public.organization_members set shared_login = p_shared where organization_id = p_org and user_id = p_user;
  if not found then raise exception 'User not found'; end if;
  perform app.audit(p_org, null, 'update', 'user', p_user::text,
    case when p_shared then 'Login set to shared (requires name + PIN)' else 'Login set to personal' end,
    jsonb_build_object('shared_login', not p_shared), jsonb_build_object('shared_login', p_shared));
end $$;

-- A shared login cannot be granted manager roles (would bypass accountability).
create or replace function app.user_roles_shared_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from public.organization_members where organization_id = new.organization_id and user_id = new.user_id and shared_login)
     and (select rank from public.roles where id = new.role_id) > 10 then
    raise exception 'A shared login can only hold the Employee or Read Only role' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger trg_user_roles_shared_guard before insert or update on public.user_roles
  for each row execute function app.user_roles_shared_guard();

-- Directory now shows which logins are shared.
drop function if exists public.list_org_users(uuid);
create or replace function public.list_org_users(p_org uuid)
returns table (user_id uuid, email text, full_name text, active boolean, employee_number text, roles jsonb, shared_login boolean)
language sql stable security definer set search_path = public as $$
  select m.user_id, p.email, p.full_name, m.active, m.employee_number,
         coalesce((select jsonb_agg(jsonb_build_object('id', ur.id, 'role', r.key, 'name', r.name, 'rank', r.rank, 'scope_type', ur.scope_type, 'scope_id', ur.scope_id,
                                                      'scope_name', case ur.scope_type when 'organization' then 'All locations'
                                                                     when 'location' then (select code || ' ' || name from public.locations where id = ur.scope_id)
                                                                     when 'district' then (select name from public.districts where id = ur.scope_id)
                                                                     when 'region' then (select name from public.regions where id = ur.scope_id) end)
                                   order by r.rank desc)
                   from public.user_roles ur join public.roles r on r.id = ur.role_id
                   where ur.user_id = m.user_id and ur.organization_id = p_org), '[]'::jsonb),
         m.shared_login
  from public.organization_members m join public.profiles p on p.id = m.user_id
  where m.organization_id = p_org and app.has_any_permission('users.manage', p_org)
  order by m.active desc, p.full_name
$$;

-- Session context: adds shared_login and the identified employee.
create or replace function public.get_session_context() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then return null; end if;
  return jsonb_build_object(
    'user', (select to_jsonb(p) from public.profiles p where p.id = v_uid),
    'organizations', coalesce((select jsonb_agg(jsonb_build_object('id', o.id, 'name', o.name, 'currency', o.currency, 'settings', o.settings,
                                                                   'shared_login', m.shared_login) order by o.name)
                        from public.organizations o
                        join public.organization_members m on m.organization_id = o.id and m.user_id = v_uid and m.active), '[]'::jsonb),
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
                        from public.user_roles ur join public.roles r on r.id = ur.role_id where ur.user_id = v_uid), '[]'::jsonb),
    'employee', (select jsonb_build_object('id', e.id, 'display_name', e.display_name)
                 from public.employees e where e.id = app.current_employee_id())
  );
end $$;

-- Audit viewer helper: employee names for a page of audit rows.
create or replace function public.employee_names(p_ids uuid[])
returns table (id uuid, display_name text)
language sql stable security definer set search_path = public as $$
  select e.id, e.display_name from public.employees e
  where e.id = any(p_ids) and e.organization_id in (select app.user_org_ids())
$$;

-- Employees transfer product between storage areas (spec: TRANSFER PRODUCT).
insert into public.role_permissions (role_id, permission_key)
select id, 'inventory.transfer' from public.roles where organization_id is null and key = 'employee'
on conflict do nothing;

select app.apply_grants();
