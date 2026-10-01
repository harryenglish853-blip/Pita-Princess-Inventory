#!/usr/bin/env bash
# Docker-free local Supabase-compatible stack:
#   Postgres 16 (must already be installed)  :54322
#   Supabase Auth (GoTrue)                   :9999
#   PostgREST                                :3001
#   Gateway (/auth/v1, /rest/v1)             :54321
# Prefer `supabase start` when Docker is available; this exists for CI and
# sandboxes where container images cannot be pulled.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
STATE="$ROOT/.local-stack"
BIN="$STATE/bin"
PGBIN="${PGBIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
PGDATA="$STATE/pgdata"
DB_URL="postgres://postgres@127.0.0.1:54322/postgres"
JWT_SECRET="${JWT_SECRET:-local-dev-jwt-secret-with-at-least-32-characters}"
mkdir -p "$BIN" "$STATE/logs"

if [ ! -x "$BIN/postgrest" ]; then
  curl -sSL https://github.com/PostgREST/postgrest/releases/download/v12.2.3/postgrest-v12.2.3-linux-static-x64.tar.xz | tar xJ -C "$BIN"
fi
if [ ! -x "$BIN/auth" ]; then
  curl -sSL https://github.com/supabase/auth/releases/download/v2.180.0/auth-v2.180.0-x86.tar.gz | tar xz -C "$BIN"
fi

run_pg() { if [ "$(id -u)" = "0" ]; then su postgres -c "$*"; else bash -c "$*"; fi; }

if [ ! -d "$PGDATA" ]; then
  mkdir -p "$PGDATA"; [ "$(id -u)" = "0" ] && chown -R postgres "$STATE/pgdata" "$STATE/logs"
  run_pg "$PGBIN/initdb -D $PGDATA -U postgres --auth=trust" >/dev/null
fi
if ! pg_isready -h 127.0.0.1 -p 54322 >/dev/null 2>&1; then
  run_pg "$PGBIN/pg_ctl -D $PGDATA -o '-p 54322 -k /tmp' -l $STATE/logs/postgres.log start" >/dev/null
  until pg_isready -h 127.0.0.1 -p 54322 >/dev/null 2>&1; do sleep 0.3; done
fi
psql "$DB_URL" -q -v ON_ERROR_STOP=1 -f "$ROOT/scripts/local-stack/bootstrap.sql" >/dev/null

eval "$(node "$ROOT/scripts/local-stack/keys.mjs" "$JWT_SECRET")"

# --- Auth (runs its own migrations into the auth schema) ---
pkill -f "$BIN/auth" 2>/dev/null || true
env GOTRUE_DB_DRIVER=postgres \
  DATABASE_URL="postgres://supabase_auth_admin:postgres@127.0.0.1:54322/postgres" \
  GOTRUE_API_HOST=127.0.0.1 PORT=9999 API_EXTERNAL_URL=http://127.0.0.1:54321/auth/v1 \
  GOTRUE_SITE_URL=http://localhost:3000 GOTRUE_URI_ALLOW_LIST="http://localhost:3000/**" \
  GOTRUE_JWT_SECRET="$JWT_SECRET" GOTRUE_JWT_EXP=3600 GOTRUE_JWT_AUD=authenticated \
  GOTRUE_JWT_DEFAULT_GROUP_NAME=authenticated GOTRUE_JWT_ADMIN_ROLES=service_role \
  GOTRUE_DISABLE_SIGNUP=false GOTRUE_EXTERNAL_EMAIL_ENABLED=true GOTRUE_MAILER_AUTOCONFIRM=true \
  GOTRUE_RATE_LIMIT_EMAIL_SENT=1000 GOTRUE_LOG_LEVEL=warn \
  nohup "$BIN/auth" > "$STATE/logs/auth.log" 2>&1 &
until curl -sf http://127.0.0.1:9999/health >/dev/null; do sleep 0.3; done

# --- App schema ---
if [ "${SKIP_MIGRATIONS:-0}" != "1" ]; then
  "$ROOT/scripts/local-stack/migrate.sh"
fi

# --- PostgREST ---
pkill -f "$BIN/postgrest" 2>/dev/null || true
env PGRST_DB_URI="postgres://authenticator:postgres@127.0.0.1:54322/postgres" \
  PGRST_DB_SCHEMAS=public PGRST_DB_ANON_ROLE=anon PGRST_JWT_SECRET="$JWT_SECRET" \
  PGRST_SERVER_PORT=3001 PGRST_SERVER_HOST=127.0.0.1 PGRST_DB_MAX_ROWS=5000 PGRST_LOG_LEVEL=warn \
  nohup "$BIN/postgrest" > "$STATE/logs/postgrest.log" 2>&1 &

pkill -f "local-stack/gateway.mjs" 2>/dev/null || true
nohup node "$ROOT/scripts/local-stack/gateway.mjs" > "$STATE/logs/gateway.log" 2>&1 &
until curl -s http://127.0.0.1:54321/rest/v1/ >/dev/null 2>&1; do sleep 0.3; done

cat > "$ROOT/.env.local" <<ENV
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
NEXT_PUBLIC_SUPABASE_ANON_KEY=$SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY=$SUPABASE_SERVICE_ROLE_KEY
# local-only test secrets (never reuse in production)
CRON_SECRET=local-cron-secret
TOAST_WEBHOOK_SECRET=local-toast-secret
APP_URL=http://localhost:3000
ENV
echo "Local stack ready: API http://127.0.0.1:54321  DB $DB_URL  (.env.local written)"
