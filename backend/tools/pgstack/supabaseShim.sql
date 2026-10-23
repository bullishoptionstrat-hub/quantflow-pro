-- The parts of a Supabase project that `supabase/` assumes exist and that a
-- bare PostgreSQL does not have. Only those parts: the three API roles, the
-- role PostgREST logs in as, an `auth.users` for the foreign keys, and an
-- `auth.uid()` for the application tables' policies.
--
-- Two properties are load-bearing, because the test is worthless without them:
--   * `service_role` has BYPASSRLS, as on Supabase, and is the only role that
--     may read the four history tables (they are FORCE ROW LEVEL SECURITY with
--     no policies). A shim that granted `anon` bypassrls would make every
--     read test pass for the wrong reason.
--   * Table grants come from DEFAULT PRIVILEGES set before any table exists,
--     which is how Supabase grants `anon`/`authenticated` access to `public`.
--     So `anon` really holds SELECT, and it is RLS — not a missing grant —
--     that returns it nothing. That is the distinction the history migration's
--     own comment warns about.

create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;
create role authenticator login noinherit;
grant anon, authenticated, service_role to authenticator;

grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public
  grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public
  grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public
  grant all on functions to anon, authenticated, service_role;

create schema auth;
grant usage on schema auth to anon, authenticated, service_role;

create table auth.users (
  id    uuid primary key,
  email text
);

-- Supabase's definition: the JWT's `sub`, from either setting PostgREST has
-- used to carry it (`request.jwt.claim.sub` before v10, `request.jwt.claims`
-- after).
create function auth.uid() returns uuid
  language sql stable
  as $$
    select coalesce(
      nullif(current_setting('request.jwt.claim.sub', true), ''),
      (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
    )::uuid
  $$;
