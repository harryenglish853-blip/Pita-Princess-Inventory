-- =====================================================================
-- PHYSICAL INVENTORY: count sessions, shelf-to-sheet snapshots,
-- multi-counter entries with revision history, review, recount, posting.
-- =====================================================================

-- Immutable, human-readable document numbers (PO-000123, CNT-000045 ...)
create table public.doc_sequences (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  doc_type        text not null,
  last_value      bigint not null default 0,
  primary key (organization_id, doc_type)
);
insert into app.write_protected_tables values ('doc_sequences');

create or replace function app.next_doc_number(p_org uuid, p_doc_type text) returns text
language plpgsql security definer set search_path = public as $$
declare v bigint;
begin
  insert into public.doc_sequences as d (organization_id, doc_type, last_value) values (p_org, p_doc_type, 1)
  on conflict (organization_id, doc_type) do update set last_value = d.last_value + 1
  returning last_value into v;
  return p_doc_type || '-' || lpad(v::text, 6, '0');
end $$;

create type public.count_type as enum ('daily', 'weekly', 'month_end', 'cycle', 'custom', 'storage', 'category', 'full');
create type public.count_status as enum ('not_started', 'in_progress', 'awaiting_review', 'reviewed', 'posted', 'cancelled');

create table public.count_sessions (
  id                   uuid primary key default gen_random_uuid(),
  organization_id      uuid not null references public.organizations(id),
  location_id          uuid not null references public.locations(id),
  count_number         text not null,
  name                 text not null,
  count_type           public.count_type not null,
  status               public.count_status not null default 'not_started',
  count_at             timestamptz not null,   -- book inventory is compared as of this moment
  business_date        date not null,
  storage_location_ids uuid[],
  category_ids         uuid[],
  zero_uncounted       boolean not null default false, -- uncounted sheet items post as zero
  client_key           uuid unique,                     -- idempotent creation
  notes                text,
  created_by           uuid references public.profiles(id),
  created_at           timestamptz not null default now(),
  started_at           timestamptz,
  submitted_at         timestamptz,
  submitted_by         uuid references public.profiles(id),
  reviewed_at          timestamptz,
  reviewed_by          uuid references public.profiles(id),
  posted_at            timestamptz,
  posted_by            uuid references public.profiles(id),
  cancelled_at         timestamptz,
  cancelled_by         uuid references public.profiles(id),
  cancel_reason        text,
  updated_at           timestamptz not null default now(),
  unique (organization_id, count_number)
);
create index on public.count_sessions (location_id, status, count_at desc);
create trigger trg_count_sessions_touch before update on public.count_sessions for each row execute function app.touch_updated_at();

-- Frozen count sheet (shelf-to-sheet order at the time the count was created).
create table public.count_session_items (
  id                  uuid primary key default gen_random_uuid(),
  session_id          uuid not null references public.count_sessions(id) on delete cascade,
  product_id          uuid not null references public.products(id),
  storage_location_id uuid references public.storage_locations(id),
  shelf               text,
  sort_order          integer not null default 0,
  added_during_count  boolean not null default false,
  unique nulls not distinct (session_id, product_id, storage_location_id)
);
create index on public.count_session_items (session_id, storage_location_id, sort_order);

create table public.count_assignments (
  id                  uuid primary key default gen_random_uuid(),
  session_id          uuid not null references public.count_sessions(id) on delete cascade,
  user_id             uuid not null references public.profiles(id),
  storage_location_id uuid references public.storage_locations(id),
  created_at          timestamptz not null default now(),
  unique nulls not distinct (session_id, user_id, storage_location_id)
);

create table public.count_entries (
  id                   uuid primary key default gen_random_uuid(),
  organization_id      uuid not null references public.organizations(id),
  location_id          uuid not null references public.locations(id),
  session_id           uuid not null references public.count_sessions(id) on delete cascade,
  product_id           uuid not null references public.products(id),
  storage_location_id  uuid references public.storage_locations(id),
  quantity             numeric(18,4) not null check (quantity >= 0),  -- inventory units, computed server-side
  breakdown            jsonb not null default '[]'::jsonb,            -- [{unit_id, unit_code, qty}]
  method               text not null default 'keypad' check (method in ('keypad','plus_minus','barcode','voice','calculator','manual','import')),
  voice_transcript     text,
  voice_confidence     numeric(5,4) check (voice_confidence is null or voice_confidence between 0 and 1),
  counted_by           uuid references public.profiles(id),
  counted_at           timestamptz not null default now(),
  device_id            text,
  revision             integer not null default 1,
  has_conflict         boolean not null default false,
  recount_requested    boolean not null default false,
  recount_requested_by uuid references public.profiles(id),
  recount_requested_at timestamptz,
  recounted            boolean not null default false,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique nulls not distinct (session_id, product_id, storage_location_id)
);
create index on public.count_entries (session_id);
create index on public.count_entries (location_id, product_id);

-- Every value ever submitted, including rejected conflicting writes. Append-only.
create table public.count_entry_revisions (
  id                  bigint generated always as identity primary key,
  entry_id            uuid not null,
  session_id          uuid not null references public.count_sessions(id) on delete cascade,
  product_id          uuid not null references public.products(id),
  storage_location_id uuid references public.storage_locations(id),
  revision            integer not null,
  status              text not null check (status in ('applied', 'conflict', 'resolution', 'cleared')),
  quantity            numeric(18,4),
  breakdown           jsonb,
  method              text,
  voice_transcript    text,
  voice_confidence    numeric(5,4),
  counted_by          uuid references public.profiles(id),
  counted_at          timestamptz,
  device_id           text,
  client_entry_id     uuid unique,
  note                text,
  created_at          timestamptz not null default now()
);
create index on public.count_entry_revisions (entry_id, id);
create index on public.count_entry_revisions (session_id);
create trigger trg_count_rev_immutable before update or delete on public.count_entry_revisions
  for each row execute function app.prevent_mutation();

-- Snapshot of the review at posting time (reproducible variance history). Append-only.
create table public.count_posting_lines (
  session_id        uuid not null references public.count_sessions(id),
  product_id        uuid not null references public.products(id),
  counted           boolean not null,
  begin_qty         numeric(18,4) not null,
  received_qty      numeric(18,4) not null,
  transfer_in_qty   numeric(18,4) not null,
  transfer_out_qty  numeric(18,4) not null,
  produced_qty      numeric(18,4) not null,
  consumed_qty      numeric(18,4) not null,
  waste_qty         numeric(18,4) not null,
  adjusted_qty      numeric(18,4) not null,
  book_qty          numeric(18,4) not null,
  physical_qty      numeric(18,4) not null,
  variance_qty      numeric(18,4) not null,
  unit_cost         numeric(18,6) not null,
  variance_value    numeric(18,4) not null,
  txn_id            bigint references public.inventory_transactions(id),
  created_at        timestamptz not null default now(),
  primary key (session_id, product_id)
);
create trigger trg_count_posting_immutable before update or delete on public.count_posting_lines
  for each row execute function app.prevent_mutation();

insert into app.write_protected_tables values
  ('count_sessions'), ('count_session_items'), ('count_entries'), ('count_entry_revisions'), ('count_posting_lines');

-- ---------------------------------------------------------------------
-- RLS (all writes go through the functions below)
-- ---------------------------------------------------------------------
alter table public.count_sessions        enable row level security;
alter table public.count_session_items   enable row level security;
alter table public.count_assignments     enable row level security;
alter table public.count_entries         enable row level security;
alter table public.count_entry_revisions enable row level security;
alter table public.count_posting_lines   enable row level security;
alter table public.doc_sequences         enable row level security;

create policy cs_select on public.count_sessions for select to authenticated
  using (location_id in (select app.user_location_ids()));
create policy csi_select on public.count_session_items for select to authenticated
  using (session_id in (select id from public.count_sessions));
create policy ca_select on public.count_assignments for select to authenticated
  using (session_id in (select id from public.count_sessions));
create policy ca_write on public.count_assignments for all to authenticated
  using (exists (select 1 from public.count_sessions s where s.id = session_id and app.has_permission('inventory.review', s.location_id)))
  with check (exists (select 1 from public.count_sessions s where s.id = session_id and app.has_permission('inventory.review', s.location_id)));
create policy ce_select on public.count_entries for select to authenticated
  using (location_id in (select app.user_location_ids()));
create policy cer_select on public.count_entry_revisions for select to authenticated
  using (session_id in (select id from public.count_sessions));
create policy cpl_select on public.count_posting_lines for select to authenticated
  using (session_id in (select id from public.count_sessions));

-- ---------------------------------------------------------------------
-- Create a count (builds the frozen sheet in shelf-to-sheet order)
-- ---------------------------------------------------------------------
create or replace function public.create_count_session(
  p_location uuid, p_count_type public.count_type, p_name text default null,
  p_count_at timestamptz default null, p_storage_ids uuid[] default null, p_category_ids uuid[] default null,
  p_client_key uuid default null, p_notes text default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_org uuid := app.location_org(p_location);
  v_id uuid;
  v_at timestamptz := coalesce(p_count_at, now());
  v_items integer;
  v_all_items boolean := p_count_type in ('full', 'month_end', 'weekly', 'custom', 'category', 'storage', 'cycle');
begin
  perform app.require_permission('inventory.count', p_location);
  if p_client_key is not null then
    select id into v_id from public.count_sessions where client_key = p_client_key;
    if v_id is not null then return v_id; end if;
  end if;
  if p_count_type in ('storage') and coalesce(array_length(p_storage_ids, 1), 0) = 0 then
    raise exception 'Select at least one storage area for a location count';
  end if;
  if p_count_type in ('category') and coalesce(array_length(p_category_ids, 1), 0) = 0 then
    raise exception 'Select at least one category for a category count';
  end if;
  if v_at > now() + interval '1 day' then
    raise exception 'Count time cannot be in the future';
  end if;

  insert into public.count_sessions (organization_id, location_id, count_number, name, count_type, count_at, business_date,
                                     storage_location_ids, category_ids, zero_uncounted, client_key, notes, created_by)
  values (v_org, p_location, app.next_doc_number(v_org, 'CNT'),
          coalesce(nullif(btrim(p_name), ''), initcap(replace(p_count_type::text, '_', ' ')) || ' Count ' || to_char(app.business_date(p_location, v_at), 'Mon DD')),
          p_count_type, v_at, app.business_date(p_location, v_at), p_storage_ids, p_category_ids,
          p_count_type in ('full', 'month_end', 'weekly'), p_client_key, p_notes, auth.uid())
  returning id into v_id;

  -- Category filter matches the category or any of its descendants.
  with recursive cats as (
    select id from public.categories where id = any(coalesce(p_category_ids, '{}'))
    union all
    select c.id from public.categories c join cats on c.parent_id = cats.id
  ),
  eligible as (
    select lp.product_id
    from public.location_products lp
    join public.products p on p.id = lp.product_id and p.active and p.deleted_at is null
    where lp.location_id = p_location and lp.active
      and (p_count_type <> 'daily' or lp.count_daily)
      and (p_count_type <> 'weekly' or lp.count_weekly or lp.count_daily)
      and (p_category_ids is null or p.category_id in (select id from cats))
  )
  insert into public.count_session_items (session_id, product_id, storage_location_id, shelf, sort_order)
  select v_id, e.product_id, psl.storage_location_id, psl.shelf, psl.sort_order
  from eligible e
  join public.product_storage_locations psl on psl.product_id = e.product_id and psl.location_id = p_location and psl.active
  join public.storage_locations s on s.id = psl.storage_location_id and s.active
  where p_storage_ids is null or psl.storage_location_id = any(p_storage_ids);

  -- Products without a storage assignment still get counted (grouped as "Unassigned").
  if p_storage_ids is null then
    insert into public.count_session_items (session_id, product_id, storage_location_id, sort_order)
    select v_id, e.product_id, null, 0
    from (
      select lp.product_id from public.location_products lp
      join public.products p on p.id = lp.product_id and p.active and p.deleted_at is null
      where lp.location_id = p_location and lp.active
        and (p_count_type <> 'daily' or lp.count_daily)
        and (p_count_type <> 'weekly' or lp.count_weekly or lp.count_daily)
        and (p_category_ids is null or p.category_id in (
              with recursive c2 as (select id from public.categories where id = any(p_category_ids)
                                    union all select c.id from public.categories c join c2 on c.parent_id = c2.id)
              select id from c2))
    ) e
    where not exists (select 1 from public.count_session_items i where i.session_id = v_id and i.product_id = e.product_id);
  end if;

  select count(*) into v_items from public.count_session_items where session_id = v_id;
  if v_items = 0 then
    raise exception 'No items match this count. Check storage areas, categories and which items are on the % count list.', p_count_type;
  end if;

  perform app.audit(v_org, p_location, 'create', 'count_session', v_id::text,
                    format('Created %s count with %s lines', p_count_type, v_items), null,
                    jsonb_build_object('count_type', p_count_type, 'count_at', v_at, 'items', v_items));
  return v_id;
end $$;

-- ---------------------------------------------------------------------
-- Count sheet for the counting screen / offline download (one round trip)
-- Book quantities are intentionally NOT included (blind count).
-- ---------------------------------------------------------------------
create or replace function public.get_count_sheet(p_session uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_s public.count_sessions;
begin
  select * into v_s from public.count_sessions where id = p_session;
  if v_s.id is null or not (v_s.location_id in (select app.user_location_ids())) then
    raise exception 'Count not found' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'session', to_jsonb(v_s) || jsonb_build_object('location_name', (select name from public.locations where id = v_s.location_id)),
    'storages', coalesce((
      select jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name, 'kind', s.kind, 'sort_order', s.sort_order) order by s.sort_order, s.name)
      from public.storage_locations s
      where s.id in (select storage_location_id from public.count_session_items where session_id = p_session)), '[]'::jsonb),
    'lines', coalesce((
      select jsonb_agg(jsonb_build_object(
        'item_id', i.id, 'product_id', p.id, 'product_number', p.product_number, 'name', p.name,
        'category', c.name, 'storage_location_id', i.storage_location_id, 'shelf', i.shelf, 'sort_order', i.sort_order,
        'inventory_unit_id', p.inventory_unit_id,
        'units', (select jsonb_agg(jsonb_build_object('unit_id', o.unit_id, 'code', o.unit_code, 'name', o.unit_name, 'factor', o.factor)
                                   order by o.factor desc)
                  from public.product_unit_options o
                  where o.product_id = p.id and (o.is_inventory_unit or o.use_for_count)),
        'barcodes', (select coalesce(jsonb_agg(jsonb_build_object('barcode', b.barcode, 'unit_id', b.unit_id)), '[]'::jsonb)
                     from public.product_barcodes b where b.product_id = p.id)
      ) order by coalesce(st.sort_order, 999999), st.name, i.sort_order, p.name)
      from public.count_session_items i
      join public.products p on p.id = i.product_id
      left join public.categories c on c.id = p.category_id
      left join public.storage_locations st on st.id = i.storage_location_id
      where i.session_id = p_session), '[]'::jsonb),
    'entries', coalesce((
      select jsonb_agg(to_jsonb(e) || jsonb_build_object('counted_by_name', pr.full_name))
      from public.count_entries e left join public.profiles pr on pr.id = e.counted_by
      where e.session_id = p_session), '[]'::jsonb),
    'server_time', now()
  );
end $$;

-- ---------------------------------------------------------------------
-- Save count entries (batch, idempotent, conflict-safe; used by offline sync)
-- p_entries: [{client_entry_id, product_id, storage_location_id, breakdown:[{unit_id, qty}],
--              base_revision, method, voice_transcript, voice_confidence, counted_at, device_id, clear}]
-- ---------------------------------------------------------------------
create or replace function public.save_count_entries(p_session uuid, p_entries jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_s public.count_sessions;
  v_uid uuid := auth.uid();
  v_can_review boolean;
  r jsonb;
  b jsonb;
  v_client uuid;
  v_product uuid;
  v_storage uuid;
  v_qty numeric;
  v_factor numeric;
  v_breakdown jsonb;
  v_entry public.count_entries;
  v_base_rev integer;
  v_status text;
  v_results jsonb := '[]'::jsonb;
  v_counted_at timestamptz;
begin
  select * into v_s from public.count_sessions where id = p_session for update;
  if v_s.id is null then raise exception 'Count not found'; end if;
  perform app.require_permission('inventory.count', v_s.location_id);
  if v_s.status in ('posted', 'cancelled', 'reviewed') then
    raise exception 'This count is % and can no longer be changed', v_s.status using errcode = 'P0002';
  end if;
  v_can_review := app.has_permission('inventory.review', v_s.location_id);
  if v_s.status = 'not_started' then
    update public.count_sessions set status = 'in_progress', started_at = now() where id = p_session;
  end if;

  for r in select * from jsonb_array_elements(p_entries) loop
    v_client := (r ->> 'client_entry_id')::uuid;
    v_product := (r ->> 'product_id')::uuid;
    v_storage := nullif(r ->> 'storage_location_id', '')::uuid;
    v_base_rev := nullif(r ->> 'base_revision', '')::integer;
    v_counted_at := least(coalesce(nullif(r ->> 'counted_at', '')::timestamptz, now()), now());

    -- Idempotency: this exact submission was already processed.
    if v_client is not null and exists (select 1 from public.count_entry_revisions where client_entry_id = v_client) then
      select * into v_entry from public.count_entries where session_id = p_session and product_id = v_product and storage_location_id is not distinct from v_storage;
      v_results := v_results || jsonb_build_object('client_entry_id', v_client, 'status', 'duplicate', 'entry', to_jsonb(v_entry));
      continue;
    end if;

    -- Product must be active at this location. Items found during the count are added to the sheet.
    if not exists (select 1 from public.location_products lp where lp.location_id = v_s.location_id and lp.product_id = v_product) then
      raise exception 'Product is not carried at this location';
    end if;
    if v_storage is not null and not exists (select 1 from public.storage_locations where id = v_storage and location_id = v_s.location_id) then
      raise exception 'Storage area does not belong to this location';
    end if;
    insert into public.count_session_items (session_id, product_id, storage_location_id, sort_order, added_during_count)
    values (p_session, v_product, v_storage, 100000, true)
    on conflict (session_id, product_id, storage_location_id) do nothing;

    select * into v_entry from public.count_entries
     where session_id = p_session and product_id = v_product and storage_location_id is not distinct from v_storage
     for update;

    if v_s.status = 'awaiting_review' and not v_can_review and not coalesce(v_entry.recount_requested, false) then
      raise exception 'The count was submitted for review. Only items marked for recount can be changed.' using errcode = 'P0002';
    end if;

    -- Clearing an entry
    if coalesce((r ->> 'clear')::boolean, false) then
      if v_entry.id is not null then
        if v_base_rev is not null and v_base_rev <> v_entry.revision and v_entry.counted_by is distinct from v_uid then
          insert into public.count_entry_revisions (entry_id, session_id, product_id, storage_location_id, revision, status, quantity, breakdown,
                                                    counted_by, counted_at, device_id, client_entry_id, note)
          values (v_entry.id, p_session, v_product, v_storage, v_entry.revision, 'conflict', null, '[]', v_uid, v_counted_at, r ->> 'device_id', v_client,
                  'Clear rejected: another counter changed this item');
          update public.count_entries set has_conflict = true where id = v_entry.id returning * into v_entry;
          v_results := v_results || jsonb_build_object('client_entry_id', v_client, 'status', 'conflict', 'entry', to_jsonb(v_entry));
        else
          insert into public.count_entry_revisions (entry_id, session_id, product_id, storage_location_id, revision, status, quantity, breakdown,
                                                    counted_by, counted_at, device_id, client_entry_id)
          values (v_entry.id, p_session, v_product, v_storage, v_entry.revision + 1, 'cleared', null, '[]', v_uid, v_counted_at, r ->> 'device_id', v_client);
          delete from public.count_entries where id = v_entry.id;
          v_results := v_results || jsonb_build_object('client_entry_id', v_client, 'status', 'cleared', 'entry', null);
        end if;
      else
        v_results := v_results || jsonb_build_object('client_entry_id', v_client, 'status', 'cleared', 'entry', null);
      end if;
      continue;
    end if;

    -- Quantity is always computed on the server from the unit breakdown.
    v_qty := 0;
    v_breakdown := '[]'::jsonb;
    for b in select * from jsonb_array_elements(coalesce(r -> 'breakdown', '[]'::jsonb)) loop
      continue when nullif(b ->> 'qty', '') is null;
      if (b ->> 'qty')::numeric < 0 then raise exception 'Counts cannot be negative'; end if;
      v_factor := app.unit_factor(v_product, (b ->> 'unit_id')::uuid);
      if v_factor is null then raise exception 'Unit has no conversion for this product' using errcode = '22023'; end if;
      v_qty := v_qty + (b ->> 'qty')::numeric * v_factor;
      v_breakdown := v_breakdown || jsonb_build_object('unit_id', b ->> 'unit_id',
                                                       'unit_code', (select code from public.units where id = (b ->> 'unit_id')::uuid),
                                                       'qty', (b ->> 'qty')::numeric);
    end loop;
    v_qty := round(v_qty, 4);
    if jsonb_array_length(v_breakdown) = 0 then raise exception 'Enter a quantity (0 is allowed)'; end if;

    if v_entry.id is null then
      insert into public.count_entries (organization_id, location_id, session_id, product_id, storage_location_id, quantity, breakdown,
                                        method, voice_transcript, voice_confidence, counted_by, counted_at, device_id, revision)
      values (v_s.organization_id, v_s.location_id, p_session, v_product, v_storage, v_qty, v_breakdown,
              coalesce(r ->> 'method', 'keypad'), r ->> 'voice_transcript', nullif(r ->> 'voice_confidence', '')::numeric,
              v_uid, v_counted_at, r ->> 'device_id', 1)
      returning * into v_entry;
      v_status := 'applied';
    elsif v_base_rev is not null and v_base_rev <> v_entry.revision and v_entry.counted_by is distinct from v_uid then
      -- Someone else changed this line since this device last saw it: keep both, flag for review.
      v_status := 'conflict';
    else
      update public.count_entries set
        quantity = v_qty, breakdown = v_breakdown, method = coalesce(r ->> 'method', 'keypad'),
        voice_transcript = r ->> 'voice_transcript', voice_confidence = nullif(r ->> 'voice_confidence', '')::numeric,
        counted_by = v_uid, counted_at = v_counted_at, device_id = r ->> 'device_id',
        revision = v_entry.revision + 1,
        recounted = v_entry.recounted or v_entry.recount_requested,
        recount_requested = false,
        updated_at = now()
      where id = v_entry.id
      returning * into v_entry;
      v_status := 'applied';
    end if;

    insert into public.count_entry_revisions (entry_id, session_id, product_id, storage_location_id, revision, status, quantity, breakdown,
                                              method, voice_transcript, voice_confidence, counted_by, counted_at, device_id, client_entry_id)
    values (v_entry.id, p_session, v_product, v_storage,
            case when v_status = 'applied' then v_entry.revision else v_entry.revision end,
            v_status, v_qty, v_breakdown, coalesce(r ->> 'method', 'keypad'), r ->> 'voice_transcript',
            nullif(r ->> 'voice_confidence', '')::numeric, v_uid, v_counted_at, r ->> 'device_id', v_client);

    if v_status = 'conflict' then
      update public.count_entries set has_conflict = true where id = v_entry.id returning * into v_entry;
    end if;

    v_results := v_results || jsonb_build_object('client_entry_id', v_client, 'status', v_status,
      'entry', to_jsonb(v_entry) || jsonb_build_object('counted_by_name', (select full_name from public.profiles where id = v_entry.counted_by)));
  end loop;

  return jsonb_build_object('results', v_results, 'session_status', (select status from public.count_sessions where id = p_session));
end $$;

-- Reviewer picks which submitted value wins for a conflicted line.
create or replace function public.resolve_count_conflict(p_entry uuid, p_revision_id bigint) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_e public.count_entries;
  v_r public.count_entry_revisions;
  v_status public.count_status;
begin
  select * into v_e from public.count_entries where id = p_entry for update;
  if v_e.id is null then raise exception 'Count line not found'; end if;
  perform app.require_permission('inventory.review', v_e.location_id);
  select status into v_status from public.count_sessions where id = v_e.session_id;
  if v_status in ('posted', 'cancelled') then raise exception 'Count is %', v_status; end if;
  select * into v_r from public.count_entry_revisions where id = p_revision_id and entry_id = p_entry;
  if v_r.id is null or v_r.quantity is null then raise exception 'Revision not found'; end if;
  update public.count_entries set quantity = v_r.quantity, breakdown = v_r.breakdown, method = v_r.method,
    voice_transcript = v_r.voice_transcript, voice_confidence = v_r.voice_confidence,
    counted_by = v_r.counted_by, counted_at = v_r.counted_at, revision = revision + 1, has_conflict = false, updated_at = now()
  where id = p_entry returning * into v_e;
  insert into public.count_entry_revisions (entry_id, session_id, product_id, storage_location_id, revision, status, quantity, breakdown, method,
                                            counted_by, counted_at, note)
  values (p_entry, v_e.session_id, v_e.product_id, v_e.storage_location_id, v_e.revision, 'resolution', v_e.quantity, v_e.breakdown, v_e.method,
          auth.uid(), now(), format('Conflict resolved using revision %s', p_revision_id));
  perform app.audit(v_e.organization_id, v_e.location_id, 'resolve_conflict', 'count_entry', p_entry::text,
                    'Count conflict resolved', null, jsonb_build_object('quantity', v_e.quantity, 'revision_id', p_revision_id));
end $$;

-- ---------------------------------------------------------------------
-- Review: BEGIN + movements = BOOK; PHYSICAL - BOOK = VARIANCE
-- ---------------------------------------------------------------------
create or replace function public.count_review_lines(p_session uuid)
returns table (
  product_id uuid, product_number text, product_name text, category_id uuid, category_name text,
  inventory_unit text, storage_names text,
  counted boolean, entry_count integer, counted_by_names text, has_conflict boolean, recount_requested boolean, recounted boolean,
  begin_qty numeric, received_qty numeric, transfer_in_qty numeric, transfer_out_qty numeric, produced_qty numeric,
  consumed_qty numeric, waste_qty numeric, adjusted_qty numeric, in_transit_qty numeric,
  book_qty numeric, physical_qty numeric, variance_qty numeric, unit_cost numeric, variance_value numeric,
  variance_pct numeric, exceeds_tolerance boolean
)
language plpgsql stable security definer set search_path = public as $$
declare
  v_s public.count_sessions;
  v_loc public.locations;
begin
  select * into v_s from public.count_sessions where id = p_session;
  if v_s.id is null or not (v_s.location_id in (select app.user_location_ids())) then
    raise exception 'Count not found' using errcode = '42501';
  end if;
  select * into v_loc from public.locations where id = v_s.location_id;

  -- Posted counts are reported from their immutable snapshot.
  if v_s.status = 'posted' then
    return query
    select pl.product_id, p.product_number, p.name, p.category_id, c.name, u.code,
           (select string_agg(distinct st.name, ', ') from public.count_entries e join public.storage_locations st on st.id = e.storage_location_id
             where e.session_id = p_session and e.product_id = pl.product_id),
           pl.counted,
           (select count(*)::int from public.count_entries e where e.session_id = p_session and e.product_id = pl.product_id),
           (select string_agg(distinct pr.full_name, ', ') from public.count_entries e join public.profiles pr on pr.id = e.counted_by
             where e.session_id = p_session and e.product_id = pl.product_id),
           false, false,
           coalesce((select bool_or(e.recounted) from public.count_entries e where e.session_id = p_session and e.product_id = pl.product_id), false),
           pl.begin_qty, pl.received_qty, pl.transfer_in_qty, pl.transfer_out_qty, pl.produced_qty, pl.consumed_qty, pl.waste_qty, pl.adjusted_qty,
           0::numeric, pl.book_qty, pl.physical_qty, pl.variance_qty, pl.unit_cost, pl.variance_value,
           case when pl.book_qty <> 0 then round(pl.variance_qty / abs(pl.book_qty) * 100, 2) end,
           (abs(pl.variance_value) > v_loc.count_variance_value_tolerance
             or (pl.book_qty <> 0 and abs(pl.variance_qty / pl.book_qty * 100) > v_loc.count_variance_pct_tolerance))
    from public.count_posting_lines pl
    join public.products p on p.id = pl.product_id
    join public.units u on u.id = p.inventory_unit_id
    left join public.categories c on c.id = p.category_id
    where pl.session_id = p_session;
    return;
  end if;

  return query
  with prods as (
    select i.product_id from public.count_session_items i where i.session_id = p_session
    union
    select e.product_id from public.count_entries e where e.session_id = p_session
  ),
  phys as (
    select e.product_id, sum(e.quantity) as qty, count(*)::int as n,
           bool_or(e.has_conflict) as conflict, bool_or(e.recount_requested) as recount, bool_or(e.recounted) as recounted,
           string_agg(distinct pr.full_name, ', ') as who,
           string_agg(distinct st.name, ', ') as storages
    from public.count_entries e
    left join public.profiles pr on pr.id = e.counted_by
    left join public.storage_locations st on st.id = e.storage_location_id
    where e.session_id = p_session
    group by e.product_id
  ),
  prev as (
    select pl.product_id, max(cs.count_at) as prev_at
    from public.count_posting_lines pl
    join public.count_sessions cs on cs.id = pl.session_id
    where cs.location_id = v_s.location_id and cs.status = 'posted' and pl.counted and cs.count_at < v_s.count_at
    group by pl.product_id
  ),
  mv as (
    select t.product_id,
      coalesce(sum(t.quantity) filter (where t.txn_at <= coalesce(pv.prev_at, '-infinity')), 0) as begin_qty,
      coalesce(sum(t.quantity) filter (where t.txn_at > coalesce(pv.prev_at, '-infinity') and t.txn_type in ('RECEIPT', 'RETURN_TO_VENDOR')), 0) as received,
      coalesce(sum(t.quantity) filter (where t.txn_at > coalesce(pv.prev_at, '-infinity') and t.txn_type = 'TRANSFER_IN'), 0) as t_in,
      coalesce(sum(t.quantity) filter (where t.txn_at > coalesce(pv.prev_at, '-infinity') and t.txn_type = 'TRANSFER_OUT'), 0) as t_out,
      coalesce(sum(t.quantity) filter (where t.txn_at > coalesce(pv.prev_at, '-infinity') and t.txn_type = 'PRODUCTION'), 0) as produced,
      coalesce(sum(t.quantity) filter (where t.txn_at > coalesce(pv.prev_at, '-infinity') and t.txn_type in ('POS_CONSUMPTION', 'RECIPE_CONSUMPTION')), 0) as consumed,
      coalesce(sum(t.quantity) filter (where t.txn_at > coalesce(pv.prev_at, '-infinity') and t.txn_type = 'WASTE'), 0) as waste,
      coalesce(sum(t.quantity) filter (where t.txn_at > coalesce(pv.prev_at, '-infinity') and t.txn_type in ('MANUAL_ADJUSTMENT', 'PHYSICAL_VARIANCE', 'CORRECTION', 'BEGINNING')), 0) as adjusted,
      coalesce(sum(t.quantity), 0) as book
    from public.inventory_transactions t
    join prods using (product_id)
    left join prev pv on pv.product_id = t.product_id
    where t.location_id = v_s.location_id and t.txn_at <= v_s.count_at
    group by t.product_id
  ),
  lines as (
    select pr.product_id,
           (ph.product_id is not null) as counted,
           coalesce(ph.n, 0) as n, ph.who, coalesce(ph.conflict, false) as conflict, coalesce(ph.recount, false) as recount,
           coalesce(ph.recounted, false) as recounted, ph.storages,
           coalesce(mv.begin_qty, 0) as begin_qty, coalesce(mv.received, 0) as received, coalesce(mv.t_in, 0) as t_in,
           coalesce(mv.t_out, 0) as t_out, coalesce(mv.produced, 0) as produced, coalesce(mv.consumed, 0) as consumed,
           coalesce(mv.waste, 0) as waste, coalesce(mv.adjusted, 0) as adjusted, coalesce(mv.book, 0) as book,
           case when ph.product_id is not null then ph.qty when v_s.zero_uncounted then 0 end as physical,
           app.current_unit_cost(v_s.location_id, pr.product_id) as cost
    from prods pr
    left join phys ph on ph.product_id = pr.product_id
    left join mv on mv.product_id = pr.product_id
  )
  select l.product_id, p.product_number, p.name, p.category_id, c.name, u.code, l.storages,
         l.counted, l.n, l.who, l.conflict, l.recount, l.recounted,
         l.begin_qty, l.received, l.t_in, l.t_out, l.produced, l.consumed, l.waste, l.adjusted,
         app.in_transit_qty(v_s.location_id, l.product_id),
         l.book, l.physical,
         case when l.physical is not null then l.physical - l.book end,
         round(l.cost, 6),
         case when l.physical is not null then round((l.physical - l.book) * l.cost, 2) end,
         case when l.physical is not null and l.book <> 0 then round((l.physical - l.book) / abs(l.book) * 100, 2)
              when l.physical is not null and l.book = 0 and l.physical <> 0 then 100 end,
         coalesce(l.physical is not null and (
              abs((l.physical - l.book) * l.cost) > v_loc.count_variance_value_tolerance
           or (l.book <> 0 and abs((l.physical - l.book) / l.book * 100) > v_loc.count_variance_pct_tolerance)
           or (l.book = 0 and l.physical > 0 and l.physical * l.cost > v_loc.count_variance_value_tolerance)), false)
  from lines l
  join public.products p on p.id = l.product_id
  join public.units u on u.id = p.inventory_unit_id
  left join public.categories c on c.id = p.category_id;
end $$;

-- In-transit quantity (inbound location transfers). Redefined once transfers exist.
create or replace function app.in_transit_qty(p_location uuid, p_product uuid) returns numeric
language sql stable as $$ select 0::numeric $$;

-- ---------------------------------------------------------------------
-- Session state transitions
-- ---------------------------------------------------------------------
create or replace function public.submit_count_session(p_session uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_s public.count_sessions;
begin
  select * into v_s from public.count_sessions where id = p_session for update;
  if v_s.id is null then raise exception 'Count not found'; end if;
  perform app.require_permission('inventory.count', v_s.location_id);
  if v_s.status not in ('not_started', 'in_progress') then
    raise exception 'Only a count in progress can be submitted (current status: %)', v_s.status;
  end if;
  if not exists (select 1 from public.count_entries where session_id = p_session) then
    raise exception 'Nothing has been counted yet';
  end if;
  update public.count_sessions set status = 'awaiting_review', submitted_at = now(), submitted_by = auth.uid() where id = p_session;
  perform app.audit(v_s.organization_id, v_s.location_id, 'submit', 'count_session', p_session::text, 'Count submitted for review', null, null);
end $$;

create or replace function public.reopen_count_session(p_session uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_s public.count_sessions;
begin
  select * into v_s from public.count_sessions where id = p_session for update;
  if v_s.id is null then raise exception 'Count not found'; end if;
  perform app.require_permission('inventory.review', v_s.location_id);
  if v_s.status not in ('awaiting_review', 'reviewed') then
    raise exception 'Only a submitted count can be reopened (current status: %)', v_s.status;
  end if;
  update public.count_sessions set status = 'in_progress', reviewed_at = null, reviewed_by = null where id = p_session;
  perform app.audit(v_s.organization_id, v_s.location_id, 'reopen', 'count_session', p_session::text, 'Count reopened for counting', null, null);
end $$;

create or replace function public.request_recount(p_session uuid, p_product_ids uuid[]) returns integer
language plpgsql security definer set search_path = public as $$
declare v_s public.count_sessions; v_n integer;
begin
  select * into v_s from public.count_sessions where id = p_session for update;
  if v_s.id is null then raise exception 'Count not found'; end if;
  perform app.require_permission('inventory.review', v_s.location_id);
  if v_s.status not in ('in_progress', 'awaiting_review', 'reviewed') then
    raise exception 'Recounts can only be requested before posting';
  end if;
  update public.count_entries set recount_requested = true, recount_requested_by = auth.uid(), recount_requested_at = now()
  where session_id = p_session and product_id = any(p_product_ids);
  get diagnostics v_n = row_count;
  if v_s.status = 'reviewed' then
    update public.count_sessions set status = 'awaiting_review', reviewed_at = null, reviewed_by = null where id = p_session;
  end if;
  perform app.audit(v_s.organization_id, v_s.location_id, 'request_recount', 'count_session', p_session::text,
                    format('Recount requested for %s line(s)', v_n), null, to_jsonb(p_product_ids));
  return v_n;
end $$;

create or replace function public.mark_count_reviewed(p_session uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_s public.count_sessions;
begin
  select * into v_s from public.count_sessions where id = p_session for update;
  if v_s.id is null then raise exception 'Count not found'; end if;
  perform app.require_permission('inventory.review', v_s.location_id);
  if v_s.status <> 'awaiting_review' then raise exception 'Count must be awaiting review (current status: %)', v_s.status; end if;
  if exists (select 1 from public.count_entries where session_id = p_session and (has_conflict or recount_requested)) then
    raise exception 'Resolve conflicts and outstanding recounts before marking the count reviewed';
  end if;
  update public.count_sessions set status = 'reviewed', reviewed_at = now(), reviewed_by = auth.uid() where id = p_session;
  perform app.audit(v_s.organization_id, v_s.location_id, 'review', 'count_session', p_session::text, 'Count reviewed', null, null);
end $$;

create or replace function public.cancel_count_session(p_session uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare v_s public.count_sessions;
begin
  select * into v_s from public.count_sessions where id = p_session for update;
  if v_s.id is null then raise exception 'Count not found'; end if;
  perform app.require_permission('inventory.review', v_s.location_id);
  if v_s.status in ('posted', 'cancelled') then raise exception 'Count is already %', v_s.status; end if;
  if coalesce(btrim(p_reason), '') = '' then raise exception 'A reason is required to cancel a count'; end if;
  update public.count_sessions set status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid(), cancel_reason = p_reason where id = p_session;
  perform app.audit(v_s.organization_id, v_s.location_id, 'cancel', 'count_session', p_session::text, 'Count cancelled: ' || p_reason, null, null);
end $$;

-- ---------------------------------------------------------------------
-- POST: creates PHYSICAL_VARIANCE ledger rows at count_at, snapshots the
-- review, locks the event. Atomic: all or nothing.
-- ---------------------------------------------------------------------
create or replace function public.post_count_session(p_session uuid, p_acknowledge_flags boolean default false) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_s public.count_sessions;
  v_flagged integer;
  v_uncounted integer;
  l record;
  v_txn bigint;
  v_lines integer := 0;
  v_total numeric := 0;
begin
  select * into v_s from public.count_sessions where id = p_session for update;
  if v_s.id is null then raise exception 'Count not found'; end if;
  perform app.require_permission('inventory.post', v_s.location_id);
  if v_s.status = 'posted' then raise exception 'This count has already been posted' using errcode = 'P0003'; end if;
  if v_s.status not in ('awaiting_review', 'reviewed') then
    raise exception 'Submit the count for review before posting (current status: %)', v_s.status;
  end if;
  if exists (select 1 from public.count_entries where session_id = p_session and has_conflict) then
    raise exception 'Resolve conflicting counts before posting';
  end if;
  if exists (select 1 from public.count_entries where session_id = p_session and recount_requested) then
    raise exception 'Recounts are still outstanding';
  end if;
  if exists (select 1 from public.count_sessions where location_id = v_s.location_id and status = 'posted' and count_at >= v_s.count_at and id <> p_session) then
    raise exception 'A later count has already been posted for this location. Counts must be posted in time order.';
  end if;

  drop table if exists tmp_review;
  create temporary table tmp_review on commit drop as select * from public.count_review_lines(p_session);
  select count(*) into v_flagged from tmp_review where exceeds_tolerance;
  if v_flagged > 0 and not p_acknowledge_flags then
    raise exception '% item(s) exceed the variance tolerance. Recount them or confirm the variances to post.', v_flagged using errcode = 'P0004';
  end if;
  select count(*) into v_uncounted from tmp_review where not counted;

  for l in select * from tmp_review where physical_qty is not null loop
    v_txn := null;
    if l.variance_qty <> 0 then
      v_txn := app.post_inventory_txn(v_s.location_id, l.product_id, 'PHYSICAL_VARIANCE', l.variance_qty, l.unit_cost,
                                      v_s.count_at, 'count_session', p_session, null, null, null, v_s.count_number,
                                      case when not l.counted then 'Not counted; posted as zero' end);
    end if;
    insert into public.count_posting_lines (session_id, product_id, counted, begin_qty, received_qty, transfer_in_qty, transfer_out_qty,
                                            produced_qty, consumed_qty, waste_qty, adjusted_qty, book_qty, physical_qty, variance_qty,
                                            unit_cost, variance_value, txn_id)
    values (p_session, l.product_id, l.counted, l.begin_qty, l.received_qty, l.transfer_in_qty, l.transfer_out_qty,
            l.produced_qty, l.consumed_qty, l.waste_qty, l.adjusted_qty, l.book_qty, l.physical_qty, l.variance_qty,
            l.unit_cost, coalesce(l.variance_value, 0), v_txn);
    update public.location_products set last_counted_at = v_s.count_at
      where location_id = v_s.location_id and product_id = l.product_id
        and (last_counted_at is null or last_counted_at < v_s.count_at);
    v_lines := v_lines + 1;
    v_total := v_total + coalesce(l.variance_value, 0);
  end loop;

  update public.count_sessions set status = 'posted', posted_at = now(), posted_by = auth.uid(),
         reviewed_at = coalesce(reviewed_at, now()), reviewed_by = coalesce(reviewed_by, auth.uid())
  where id = p_session;

  perform app.audit(v_s.organization_id, v_s.location_id, 'post', 'count_session', p_session::text,
                    format('Posted %s (%s lines, variance %s)', v_s.count_number, v_lines, round(v_total, 2)), null,
                    jsonb_build_object('lines', v_lines, 'variance_value', round(v_total, 2), 'flagged', v_flagged,
                                       'acknowledged_flags', p_acknowledge_flags, 'uncounted', v_uncounted));
  return jsonb_build_object('lines', v_lines, 'variance_value', round(v_total, 2), 'flagged', v_flagged, 'uncounted', v_uncounted);
end $$;

-- Posted/cancelled counts are locked.
create or replace function app.count_entries_lock() returns trigger
language plpgsql as $$
declare v_status public.count_status;
begin
  select status into v_status from public.count_sessions where id = coalesce(new.session_id, old.session_id);
  if v_status in ('posted', 'cancelled') then
    raise exception 'Count is % and locked', v_status;
  end if;
  return coalesce(new, old);
end $$;
create trigger trg_count_entries_lock before insert or update or delete on public.count_entries
  for each row execute function app.count_entries_lock();

create or replace function app.count_sessions_lock() returns trigger
language plpgsql as $$
begin
  if old.status in ('posted', 'cancelled') then
    raise exception 'Count % is % and locked', old.count_number, old.status;
  end if;
  if new.count_number <> old.count_number then raise exception 'Count numbers are immutable'; end if;
  return new;
end $$;
create trigger trg_count_sessions_lock before update on public.count_sessions
  for each row execute function app.count_sessions_lock();

select app.apply_grants();
