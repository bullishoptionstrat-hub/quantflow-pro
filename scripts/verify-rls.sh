#!/usr/bin/env bash
# Wave 9 RLS gate — proves row-level security actually isolates users, by
# issuing real unauthorized requests as the `anon` role rather than trusting
# that the policies read correctly.
set -uo pipefail
PGHOST="${PGHOST:-/tmp}"; PGPORT="${PGPORT:-5433}"; PGUSER="${PGUSER:-postgres}"; DB="${DB:-qf}"
P="psql -h $PGHOST -p $PGPORT -U $PGUSER -d $DB -tA"
A='11111111-1111-1111-1111-111111111111'
B='22222222-2222-2222-2222-222222222222'
FAIL=0
chk(){ if [ "$2" = "$3" ]; then echo "  pass ✅  $1"; else echo "  FAIL ❌  $1 (expected '$3', got '$2')"; FAIL=1; fi; }

$P >/dev/null 2>&1 <<SQL
do \$\$ begin if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if; end \$\$;
grant usage on schema public to anon;
grant select, insert, update, delete on all tables in schema public to anon;
insert into auth.users(id,email) values ('$A','a@x.com') on conflict do nothing;
insert into auth.users(id,email) values ('$B','b@x.com') on conflict do nothing;
delete from watchlist;
insert into watchlist(user_id,symbol) values ('$A','SPY'),('$B','QQQ');
SQL

# Runs $2 as the user identified by $1 and prints ONLY the query result.
# The result is tagged with a marker because psql also echoes SET/RESET.
as_user(){ $P <<SQL 2>&1 | sed -n 's/^RESULT://p'
create or replace function auth.uid() returns uuid language sql stable as \$\$ select $1 \$\$;
set role anon;
select 'RESULT:'||($2);
reset role;
SQL
}

echo "==> RLS isolation"
chk "user A sees only their own watchlist row" \
    "$(as_user "'$A'::uuid" "select coalesce(string_agg(symbol,','),'none') from watchlist")" "SPY"
chk "user B sees only their own watchlist row" \
    "$(as_user "'$B'::uuid" "select coalesce(string_agg(symbol,','),'none') from watchlist")" "QQQ"
chk "UNAUTHENTICATED request sees nothing" \
    "$(as_user "null::uuid" "select coalesce(string_agg(symbol,','),'none') from watchlist")" "none"
# DELETE and INSERT cannot nest inside a scalar select, so these two run raw.
del_count=$($P <<SQL 2>&1 | sed -n 's/^DELETE //p'
create or replace function auth.uid() returns uuid language sql stable as \$\$ select '$A'::uuid \$\$;
set role anon;
delete from watchlist where symbol='QQQ';
reset role;
SQL
)
chk "user A cannot DELETE user B's row" "$del_count" "0"
chk "user A cannot READ user B's api_keys" \
    "$(as_user "'$A'::uuid" "select count(*)::text from api_keys")" "0"

echo "==> privilege escalation"
esc=$($P <<SQL 2>&1 | grep -c "violates row-level security" || true
create or replace function auth.uid() returns uuid language sql stable as \$\$ select '$A'::uuid \$\$;
set role anon;
insert into watchlist(user_id,symbol) values ('$B','ESCALATED');
reset role;
SQL
)
chk "user A cannot INSERT a row owned by user B (RLS rejects it)" "$esc" "1"

if [ "$FAIL" -eq 0 ]; then echo "==> RLS GATE PASSED"; else echo "==> RLS GATE FAILED"; fi
exit $FAIL
