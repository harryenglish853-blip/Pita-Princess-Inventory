#!/usr/bin/env bash
# Drops and recreates the app database objects, re-applies migrations and seed.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DB_URL="${DB_URL:-postgres://postgres@127.0.0.1:54322/postgres}"
export PGOPTIONS="-c client_min_messages=warning"
psql "$DB_URL" -q -v ON_ERROR_STOP=1 <<SQL
drop schema if exists public cascade; create schema public; 
grant usage on schema public to anon, authenticated, service_role;
grant all on schema public to postgres;
drop schema if exists app cascade;
drop schema if exists local_stack cascade;
delete from auth.users;
SQL
SEED="${SEED:-1}" "$ROOT/scripts/local-stack/migrate.sh"
