-- =====================================================================
-- USERS & PERMISSIONS administration (role grants are scoped and ranked)
-- =====================================================================

insert into app.write_protected_tables values ('organization_members'), ('user_roles'), ('role_permissions'), ('roles'), ('permissions');

-- Highest role rank the caller holds that covers a scope.
create or replace function app.caller_rank_for_scope(p_org uuid, p_scope_type public.scope_type, p_scope_id uuid) returns integer
language sql stable security definer set search_path = public as $$
  select coalesce(max(r.rank), 0)
  from public.user_roles ur
  join public.roles r on r.id = ur.role_id
  join public.role_permissions rp on rp.role_id = r.id and rp.permission_key = 'users.manage'
  join public.organization_members m on m.organization_id = ur.organization_id and m.user_id = ur.user_id and m.active
  where ur.user_id = auth.uid() and ur.organization_id = p_org
    and (
      ur.scope_type = 'organization'
      or (p_scope_type = 'location' and (
            (ur.scope_type = 'location' and ur.scope_id = p_scope_id)
         or (ur.scope_type = 'district' and ur.scope_id = (select district_id from public.locations where id = p_scope_id))
         or (ur.scope_type = 'region' and ur.scope_id = (select region_id from public.locations where id = p_scope_id))))
      or (p_scope_type = 'district' and (
            (ur.scope_type = 'district' and ur.scope_id = p_scope_id)
         or (ur.scope_type = 'region' and ur.scope_id = (select region_id from public.districts where id = p_scope_id))))
      or (p_scope_type = 'region' and ur.scope_type = 'region' and ur.scope_id = p_scope_id)
    )
$$;

create or replace function public.assign_role(p_org uuid, p_user uuid, p_role_key text, p_scope_type public.scope_type, p_scope_id uuid)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_role public.roles;
  v_rank integer;
  v_id uuid;
  v_scope uuid := case when p_scope_type = 'organization' then p_org else p_scope_id end;
begin
  if auth.uid() is null then raise exception 'Not signed in' using errcode = '42501'; end if;
  select * into v_role from public.roles where key = p_role_key and (organization_id is null or organization_id = p_org)
  order by organization_id nulls last limit 1;
  if v_role.id is null then raise exception 'Unknown role %', p_role_key; end if;
  -- scope must belong to the organization
  if p_scope_type = 'location' and not exists (select 1 from public.locations where id = v_scope and organization_id = p_org) then
    raise exception 'Location not in organization';
  elsif p_scope_type = 'district' and not exists (select 1 from public.districts where id = v_scope and organization_id = p_org) then
    raise exception 'District not in organization';
  elsif p_scope_type = 'region' and not exists (select 1 from public.regions where id = v_scope and organization_id = p_org) then
    raise exception 'Region not in organization';
  end if;
  v_rank := app.caller_rank_for_scope(p_org, p_scope_type, v_scope);
  if v_rank = 0 then raise exception 'Permission denied: users.manage is required for this scope' using errcode = '42501'; end if;
  if v_role.rank >= v_rank and v_rank < 100 then
    raise exception 'You can only grant roles below your own (%)', v_role.name using errcode = '42501';
  end if;
  if not exists (select 1 from public.profiles where id = p_user) then raise exception 'User not found'; end if;

  insert into public.organization_members (organization_id, user_id) values (p_org, p_user)
  on conflict (organization_id, user_id) do update set active = true;
  insert into public.user_roles (organization_id, user_id, role_id, scope_type, scope_id, created_by)
  values (p_org, p_user, v_role.id, p_scope_type, v_scope, auth.uid())
  on conflict (user_id, role_id, scope_type, scope_id) do nothing
  returning id into v_id;
  perform app.audit(p_org, case when p_scope_type = 'location' then v_scope end, 'grant_role', 'user', p_user::text,
    format('Granted %s (%s)', v_role.name, p_scope_type), null,
    jsonb_build_object('role', p_role_key, 'scope_type', p_scope_type, 'scope_id', v_scope));
  return v_id;
end $$;

create or replace function public.revoke_role(p_user_role uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_ur public.user_roles;
  v_role public.roles;
  v_rank integer;
begin
  select * into v_ur from public.user_roles where id = p_user_role;
  if v_ur.id is null then raise exception 'Role assignment not found'; end if;
  select * into v_role from public.roles where id = v_ur.role_id;
  v_rank := app.caller_rank_for_scope(v_ur.organization_id, v_ur.scope_type, v_ur.scope_id);
  if v_rank = 0 or (v_role.rank >= v_rank and v_rank < 100) then
    raise exception 'Permission denied' using errcode = '42501';
  end if;
  if v_role.key = 'system_owner' and (select count(*) from public.user_roles ur join public.roles r on r.id = ur.role_id
                                      where ur.organization_id = v_ur.organization_id and r.key = 'system_owner') <= 1 then
    raise exception 'The organization must keep at least one System Owner';
  end if;
  delete from public.user_roles where id = p_user_role;
  perform app.audit(v_ur.organization_id, case when v_ur.scope_type = 'location' then v_ur.scope_id end, 'revoke_role', 'user',
    v_ur.user_id::text, 'Revoked ' || v_role.name, jsonb_build_object('role', v_role.key, 'scope_type', v_ur.scope_type, 'scope_id', v_ur.scope_id), null);
end $$;

create or replace function public.set_member_active(p_org uuid, p_user uuid, p_active boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform app.require_org_permission('users.manage', p_org);
  if p_user = auth.uid() and not p_active then raise exception 'You cannot deactivate yourself'; end if;
  update public.organization_members set active = p_active where organization_id = p_org and user_id = p_user;
  perform app.audit(p_org, null, case when p_active then 'activate' else 'deactivate' end, 'user', p_user::text, null, null, null);
end $$;

-- Directory of people for the Users screen.
create or replace function public.list_org_users(p_org uuid)
returns table (user_id uuid, email text, full_name text, active boolean, employee_number text, roles jsonb)
language sql stable security definer set search_path = public as $$
  select m.user_id, p.email, p.full_name, m.active, m.employee_number,
         coalesce((select jsonb_agg(jsonb_build_object('id', ur.id, 'role', r.key, 'name', r.name, 'rank', r.rank, 'scope_type', ur.scope_type, 'scope_id', ur.scope_id,
                                                      'scope_name', case ur.scope_type when 'organization' then 'All locations'
                                                                     when 'location' then (select code || ' ' || name from public.locations where id = ur.scope_id)
                                                                     when 'district' then (select name from public.districts where id = ur.scope_id)
                                                                     when 'region' then (select name from public.regions where id = ur.scope_id) end)
                                   order by r.rank desc)
                   from public.user_roles ur join public.roles r on r.id = ur.role_id
                   where ur.user_id = m.user_id and ur.organization_id = p_org), '[]'::jsonb)
  from public.organization_members m join public.profiles p on p.id = m.user_id
  where m.organization_id = p_org and app.has_any_permission('users.manage', p_org)
  order by m.active desc, p.full_name
$$;

select app.apply_grants();
