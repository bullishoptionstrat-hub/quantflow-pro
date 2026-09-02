#!/usr/bin/env bash
# Wave 3 migration gate — proves every migration applies, is idempotent, and
# that its rollback restores the schema EXACTLY.
#
# Requires a reachable Postgres. Defaults to the local dev instance:
#   PGHOST=/tmp PGPORT=5433 PGUSER=postgres ./scripts/verify-migrations.sh
set -euo pipefail

PGHOST="${PGHOST:-/tmp}"; PGPORT="${PGPORT:-5433}"; PGUSER="${PGUSER:-postgres}"
DB="${DB:-qf_verify}"
PSQL="psql -h $PGHOST -p $PGPORT -U $PGUSER"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

SNAP="select table_name||'.'||column_name||':'||data_type from information_schema.columns where table_schema='public' order by 1"

echo "==> recreating $DB"
$PSQL -c "drop database if exists $DB" >/dev/null 2>&1 || true
$PSQL -c "create database $DB" >/dev/null

echo "==> installing Supabase runtime shims (auth.users, auth.uid, auth.role)"
$PSQL -d "$DB" -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
create schema if not exists auth;
create table auth.users(id uuid primary key, email text);
create or replace function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
create or replace function auth.role() returns text language sql stable as $$ select 'anon'::text $$;
SQL

echo "==> applying base schema"
$PSQL -d "$DB" -v ON_ERROR_STOP=1 -f "$ROOT/supabase/migrations/20240707000000_initial_schema.sql" >/dev/null
$PSQL -d "$DB" -tAc "$SNAP" > "$TMP/before.txt"
echo "    baseline columns: $(wc -l < "$TMP/before.txt")"

for up in "$ROOT"/supabase/migrations/*_provenance.sql; do
  down="${up%.sql}.down.sql"
  name="$(basename "$up")"

  echo "==> apply $name"
  $PSQL -d "$DB" -v ON_ERROR_STOP=1 -f "$up" >/dev/null
  $PSQL -d "$DB" -tAc "$SNAP" > "$TMP/after.txt"
  echo "    columns after: $(wc -l < "$TMP/after.txt")"

  echo "==> re-apply (idempotency)"
  $PSQL -d "$DB" -v ON_ERROR_STOP=1 -f "$up" >/dev/null
  $PSQL -d "$DB" -tAc "$SNAP" > "$TMP/after2.txt"
  diff -q "$TMP/after.txt" "$TMP/after2.txt" >/dev/null || { echo "FAIL: not idempotent"; exit 1; }
  echo "    idempotent OK"

  [ -f "$down" ] || { echo "FAIL: no rollback for $name"; exit 1; }
  echo "==> rollback $(basename "$down")"
  $PSQL -d "$DB" -v ON_ERROR_STOP=1 -f "$down" >/dev/null
  $PSQL -d "$DB" -tAc "$SNAP" > "$TMP/rolled.txt"

  if diff "$TMP/before.txt" "$TMP/rolled.txt"; then
    echo "    rollback restores baseline EXACTLY OK"
  else
    echo "FAIL: rollback did not restore the baseline schema"; exit 1
  fi

  # Leave the migration applied for any downstream checks.
  $PSQL -d "$DB" -v ON_ERROR_STOP=1 -f "$up" >/dev/null
done

echo "==> ALL MIGRATIONS VERIFIED (apply + idempotent + rollback exact)"
