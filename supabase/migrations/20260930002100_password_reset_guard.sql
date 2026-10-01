-- =====================================================================
-- Managers can set a new temporary password for staff who forgot theirs,
-- but only for people ranked below them (a manager can never take over an
-- owner's login). The password itself is set by the server with the
-- service key after this check passes; the check is audited.
-- =====================================================================
create or replace function public.authorize_password_reset(p_org uuid, p_user uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_mine int; v_theirs int;
begin
  if auth.uid() is null then raise exception 'Not signed in' using errcode = '42501'; end if;
  if p_user = auth.uid() then raise exception 'Change your own password under My account' using errcode = 'P0001'; end if;
  if not exists (select 1 from public.organization_members where organization_id = p_org and user_id = p_user) then
    raise exception 'That person is not in this organization' using errcode = '42501';
  end if;
  select coalesce(max(r.rank), 0) into v_mine
  from public.user_roles ur join public.roles r on r.id = ur.role_id
  join public.role_permissions rp on rp.role_id = r.id and rp.permission_key = 'users.manage'
  join public.organization_members m on m.organization_id = ur.organization_id and m.user_id = ur.user_id and m.active
  where ur.user_id = auth.uid() and ur.organization_id = p_org;
  select coalesce(max(r.rank), 0) into v_theirs
  from public.user_roles ur join public.roles r on r.id = ur.role_id
  where ur.user_id = p_user and ur.organization_id = p_org;
  if v_mine = 0 or v_theirs >= v_mine then
    raise exception 'You can only reset passwords for people below your role' using errcode = '42501';
  end if;
  perform app.audit(p_org, null, 'reset_password', 'user', p_user::text, 'Temporary password set by a manager', null, null);
end $$;

select app.apply_grants();
