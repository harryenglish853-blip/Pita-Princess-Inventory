#!/usr/bin/env bash
# Runs the SQL workflow tests in supabase/tests against the local database.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DB_URL="${DB_URL:-postgres://postgres@127.0.0.1:54322/postgres}"
psql "$DB_URL" -q -v ON_ERROR_STOP=1 -f "$ROOT/supabase/tests/helpers.sql" >/dev/null 2>&1
status=0
for f in "$ROOT"/supabase/tests/[0-9]*.sql; do
  echo "== $(basename "$f")"
  rc=0; out=$(psql "$DB_URL" -q -v ON_ERROR_STOP=1 -f "$f" 2>&1) || rc=$?
  echo "$out" | sed -e 's/^psql:[^:]*:[0-9]*: //'
  if [ "$rc" != "0" ]; then status=1; fi
  # a skipped suite is a failure: CI always loads the demo seed
  if echo "$out" | grep -q "SKIPPED"; then echo "!! $(basename "$f") was skipped"; status=1; fi
done
exit $status
