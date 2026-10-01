-- A vendor created as "Commissary" / "Central Kitchen" (e.g. by the product
-- spreadsheet import) is linked to the organization's commissary location
-- automatically when there is exactly one. Otherwise it stays a distributor
-- and the owner sets Kind + Commissary location on the vendor page.
create or replace function app.vendors_commissary_autolink() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_loc uuid;
begin
  if new.kind = 'distributor' and new.name ~* '(commissary|central kitchen)' then
    select min(id::text)::uuid into v_loc from public.locations
     where organization_id = new.organization_id and kind = 'commissary' and active
    having count(*) = 1;
    if v_loc is not null then
      new.kind := 'commissary';
      new.supplying_location_id := v_loc;
    end if;
  end if;
  return new;
end $$;
create trigger trg_vendors_commissary_autolink before insert on public.vendors
  for each row execute function app.vendors_commissary_autolink();

select app.apply_grants();
