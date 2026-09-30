-- =====================================================================
-- Count assignments: a reviewer splits a count between counters by
-- storage area ("Maria: Walk-In Cooler, John: Dry Storage"). Counters still
-- may count anything; assignments set what their screen opens to and let
-- the reviewer see which areas are still waiting on someone.
-- =====================================================================
alter table public.count_assignments add column if not exists assigned_by uuid references public.profiles(id);

-- Only these RPCs write assignments (validation + audit)
insert into app.write_protected_tables (table_name) values ('count_assignments') on conflict do nothing;
drop policy if exists ca_write on public.count_assignments;

-- People who can count at the session's location
create or replace function public.count_assignable_users(p_session uuid) returns table (user_id uuid, full_name text, email text)
language plpgsql stable security definer set search_path = public as $$
declare v_s public.count_sessions;
begin
  select * into v_s from public.count_sessions where id = p_session;
  if v_s.id is null then raise exception 'Count not found' using errcode = '42501'; end if;
  perform app.require_permission('inventory.review', v_s.location_id);
  return query
    select distinct pr.id, pr.full_name, pr.email
    from public.locations l
    join public.user_roles ur on ur.organization_id = l.organization_id
    join public.organization_members m on m.organization_id = l.organization_id and m.user_id = ur.user_id and m.active
    join public.role_permissions rp on rp.role_id = ur.role_id and rp.permission_key = 'inventory.count'
    join public.profiles pr on pr.id = ur.user_id
    where l.id = v_s.location_id
      and (   ur.scope_type = 'organization'
           or (ur.scope_type = 'region'   and ur.scope_id = l.region_id)
           or (ur.scope_type = 'district' and ur.scope_id = l.district_id)
           or (ur.scope_type = 'location' and ur.scope_id = l.id))
    order by pr.full_name;
end $$;

create or replace function app.parse_count_assignments(p jsonb) returns table (user_id uuid, storage_location_id uuid)
language sql immutable as $$
  select distinct (a->>'user_id')::uuid, nullif(sid, 'null')::uuid
  from jsonb_array_elements(coalesce(p, '[]'::jsonb)) a
  cross join lateral jsonb_array_elements_text(coalesce(a->'storage_location_ids', '[]'::jsonb)) sid
$$;

-- Replace all assignments on a session in one step.
-- p_assignments: [{"user_id": uuid, "storage_location_ids": [uuid | null, ...]}]
-- A null storage id means the "Unassigned" products (no storage area).
create or replace function public.set_count_assignments(p_session uuid, p_assignments jsonb) returns integer
language plpgsql security definer set search_path = public as $$
declare v_s public.count_sessions; v_n int;
begin
  select * into v_s from public.count_sessions where id = p_session for update;
  if v_s.id is null then raise exception 'Count not found' using errcode = '42501'; end if;
  perform app.require_permission('inventory.review', v_s.location_id);
  if v_s.status in ('posted', 'cancelled') then
    raise exception 'This count is % and can no longer be assigned', replace(v_s.status::text, '_', ' ') using errcode = 'P0001';
  end if;

  if exists (select 1 from app.parse_count_assignments(p_assignments) t
             where not exists (select 1 from public.count_assignable_users(p_session) u where u.user_id = t.user_id)) then
    raise exception 'Someone in the list cannot count at this location' using errcode = 'P0001';
  end if;
  if exists (select 1 from app.parse_count_assignments(p_assignments) t where t.storage_location_id is not null
             and not exists (select 1 from public.storage_locations sl where sl.id = t.storage_location_id and sl.location_id = v_s.location_id)) then
    raise exception 'Storage area does not belong to this location' using errcode = 'P0001';
  end if;

  delete from public.count_assignments where session_id = p_session;
  insert into public.count_assignments (session_id, user_id, storage_location_id, assigned_by)
  select p_session, t.user_id, t.storage_location_id, auth.uid() from app.parse_count_assignments(p_assignments) t;
  get diagnostics v_n = row_count;

  perform app.audit(v_s.organization_id, v_s.location_id, 'assign', 'count_session', p_session::text,
    format('%s area assignment(s) set on %s', v_n, v_s.name), null, p_assignments);
  return v_n;
end $$;

-- The count sheet carries its assignments so counters see them offline too.
do $$
begin
  if not exists (select 1 from pg_proc where proname = 'get_count_sheet_base' and pronamespace = 'public'::regnamespace) then
    alter function public.get_count_sheet(uuid) rename to get_count_sheet_base;
  end if;
end $$;

create or replace function public.get_count_sheet(p_session uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select public.get_count_sheet_base(p_session) || jsonb_build_object(
    'assignments', coalesce((
      select jsonb_agg(jsonb_build_object('user_id', a.user_id, 'name', coalesce(pr.full_name, pr.email), 'storage_location_id', a.storage_location_id)
                       order by pr.full_name)
      from public.count_assignments a join public.profiles pr on pr.id = a.user_id
      where a.session_id = p_session), '[]'::jsonb),
    'me', auth.uid())
$$;

select app.apply_grants();
