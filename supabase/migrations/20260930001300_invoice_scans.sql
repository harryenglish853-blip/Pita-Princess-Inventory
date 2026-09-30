-- Phase 8: invoice scanning. Stores what was extracted (never the posting itself):
-- a person reviews it, applies it to the receipt, saves, and reconciles as usual.
create table public.invoice_scans (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  location_id     uuid not null references public.locations(id),
  receipt_id      uuid references public.receipts(id),
  file_name       text,
  media_type      text,
  extracted       jsonb not null,
  model           text,
  applied         boolean not null default false,
  created_by      uuid references public.profiles(id) default auth.uid(),
  created_at      timestamptz not null default now()
);
create index on public.invoice_scans (receipt_id);
alter table public.invoice_scans enable row level security;
create policy invoice_scans_select on public.invoice_scans for select to authenticated using (location_id in (select app.user_location_ids()));
create policy invoice_scans_insert on public.invoice_scans for insert to authenticated
  with check (app.has_permission('orders.receive', location_id) and organization_id = app.location_org(location_id));
create policy invoice_scans_update on public.invoice_scans for update to authenticated
  using (app.has_permission('orders.receive', location_id)) with check (app.has_permission('orders.receive', location_id));
select app.apply_grants();
