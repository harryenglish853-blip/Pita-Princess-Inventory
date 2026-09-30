-- =====================================================================
-- Ordering is optional. Many restaurants order in each vendor's own app
-- and only record deliveries here. organizations.settings.ordering_enabled
-- (default false) switches the purchase-order screens on; receiving,
-- invoice reconciliation, costing and price history work either way.
-- =====================================================================

-- The session context carries organization settings so screens can adapt.
create or replace function public.get_session_context() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then return null; end if;
  return jsonb_build_object(
    'user', (select to_jsonb(p) from public.profiles p where p.id = v_uid),
    'organizations', coalesce((select jsonb_agg(jsonb_build_object('id', o.id, 'name', o.name, 'currency', o.currency, 'settings', o.settings) order by o.name)
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

-- Change one organization setting (merged into settings, audited).
create or replace function public.set_organization_setting(p_org uuid, p_key text, p_value jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_old jsonb; v_new jsonb;
begin
  if not app.has_org_permission('settings.manage', p_org) then
    raise exception 'You do not have permission to change organization settings' using errcode = '42501';
  end if;
  if p_key not in ('ordering_enabled') then raise exception 'Unknown setting %', p_key using errcode = 'P0001'; end if;
  if p_key = 'ordering_enabled' and jsonb_typeof(p_value) <> 'boolean' then raise exception 'ordering_enabled must be true or false' using errcode = 'P0001'; end if;
  select settings into v_old from public.organizations where id = p_org for update;
  update public.organizations set settings = settings || jsonb_build_object(p_key, p_value) where id = p_org returning settings into v_new;
  perform app.audit(p_org, null, 'update', 'organization_settings', p_org::text, format('Setting %s changed', p_key),
    jsonb_build_object(p_key, v_old -> p_key), jsonb_build_object(p_key, p_value));
  return v_new;
end $$;

select app.apply_grants();
