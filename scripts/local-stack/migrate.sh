#!/usr/bin/env bash
# Applies supabase/migrations/*.sql in order (tracked in local_stack.migrations),
# then supabase/seed.sql when SEED=1. Mirrors `supabase db reset` behaviour.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DB_URL="${DB_URL:-postgres://postgres@127.0.0.1:54322/postgres}"
export PGOPTIONS="-c client_min_messages=warning"
psql "$DB_URL" -q -c "create schema if not exists local_stack; create table if not exists local_stack.migrations(name text primary key, applied_at timestamptz default now())"
for f in "$ROOT"/supabase/migrations/*.sql; do
  name="$(basename "$f")"
  if [ -z "$(psql "$DB_URL" -tAc "select 1 from local_stack.migrations where name='$name'")" ]; then
    echo "applying $name"
    psql "$DB_URL" -q -v ON_ERROR_STOP=1 --single-transaction -f "$f" -c "insert into local_stack.migrations(name) values ('$name')" >/dev/null
  fi
done
if [ "${SEED:-0}" = "1" ]; then
  echo "seeding"
  psql "$DB_URL" -q -v ON_ERROR_STOP=1 --single-transaction -f "$ROOT/supabase/seed.sql" >/dev/null
fi
# Ask PostgREST to reload its schema cache (no-op if it is not running yet).
psql "$DB_URL" -q -c "notify pgrst, 'reload schema'"
