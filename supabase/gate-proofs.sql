-- QuantFlow Pro — database gate proofs
--
-- Re-runnable evidence that the rules in 20260829120000_signal_history.sql are
-- actually enforced by the database, not just by the application.
--
-- Each block is either an operation that MUST succeed or one that MUST be
-- refused. The refusals are the proof, so this runs with ON_ERROR_STOP off and
-- prints them. Read the output: every "ERROR:" below is a pass.
--
--   psql -d <db> -f supabase/gate-proofs.sql

\set ON_ERROR_STOP off
\timing off

-- Reset. The append-only trigger refuses DELETE on graded outcomes — which is
-- the whole point of gate G3c — so this script cannot clean up after itself
-- with a plain DELETE. It disables the trigger for the reset and re-enables it
-- immediately, BEFORE any gate runs, so nothing below is proven against a
-- disarmed table. (Without this the script is not re-runnable: the second run
-- fails its own cleanup and then proves gates against stale rows.)
alter table public.signal_outcomes disable trigger trg_outcome_immutability;
delete from public.signal_outcomes;
alter table public.signal_outcomes enable trigger trg_outcome_immutability;

delete from public.signal_write_incidents;
delete from public.collection_gaps;
delete from public.signal_history;

\echo '--- reset complete; immutability trigger is re-armed for every gate below'
select tgenabled = 'O' as immutability_trigger_armed
  from pg_trigger where tgname = 'trg_outcome_immutability';

\echo ''
\echo '=== G1  decision time ordering ==================================='

\echo '--- G1a  decision_at BEFORE last_event_at  (must be refused)'
insert into public.signal_history (
  signal_key, content_hash, engine_id, kind, underlying, side,
  total_premium, total_size, score, legs,
  first_event_at, last_event_at, decision_at, decision_basis,
  source, dataset_id, rights_class
) values (
  'g1-bad', 'h', 'sig_1', 'SWEEP', 'SPY', 'BUY', 250000, 100, 82, '[]'::jsonb,
  '2026-08-29 14:30:00+00', '2026-08-29 14:30:01+00', '2026-08-29 14:30:00.5+00',
  'OBSERVED', 'tradier', 'TRADIER_STREAM', 'PERMITTED'
);

\echo '--- G1b  last_event_at BEFORE first_event_at  (must be refused)'
insert into public.signal_history (
  signal_key, content_hash, engine_id, kind, underlying, side,
  total_premium, total_size, score, legs,
  first_event_at, last_event_at, decision_at, decision_basis,
  source, dataset_id, rights_class
) values (
  'g1-bad2', 'h', 'sig_1', 'SWEEP', 'SPY', 'BUY', 250000, 100, 82, '[]'::jsonb,
  '2026-08-29 14:30:05+00', '2026-08-29 14:30:00+00', '2026-08-29 14:30:10+00',
  'OBSERVED', 'tradier', 'TRADIER_STREAM', 'PERMITTED'
);

\echo '--- G1c  a well-ordered timeline  (must be ACCEPTED)'
insert into public.signal_history (
  signal_key, content_hash, engine_id, kind, underlying, side,
  total_premium, total_size, score, legs,
  first_event_at, last_event_at, decision_at, decision_basis, latency_ms,
  source, dataset_id, rights_class
) values (
  'g1-ok', 'hash-a', 'sig_1', 'SWEEP', 'SPY', 'BUY', 250000, 100, 82, '[]'::jsonb,
  '2026-08-29 14:30:00+00', '2026-08-29 14:30:00.5+00', '2026-08-29 14:30:00.53+00',
  'OBSERVED', 30, 'tradier', 'TRADIER_STREAM', 'PERMITTED'
);

\echo '--- G1d  an invented decision basis  (must be refused)'
insert into public.signal_history (
  signal_key, content_hash, engine_id, kind, underlying, side,
  total_premium, total_size, score, legs,
  first_event_at, last_event_at, decision_at, decision_basis,
  source, dataset_id, rights_class
) values (
  'g1-basis', 'h', 'sig_1', 'SWEEP', 'SPY', 'BUY', 250000, 100, 82, '[]'::jsonb,
  '2026-08-29 14:30:00+00', '2026-08-29 14:30:01+00', '2026-08-29 14:30:02+00',
  'PROBABLY_FINE', 'tradier', 'TRADIER_STREAM', 'PERMITTED'
);

\echo '--- G1e  an invented rights class  (must be refused)'
insert into public.signal_history (
  signal_key, content_hash, engine_id, kind, underlying, side,
  total_premium, total_size, score, legs,
  first_event_at, last_event_at, decision_at, decision_basis,
  source, dataset_id, rights_class
) values (
  'g1-rights', 'h', 'sig_1', 'SWEEP', 'SPY', 'BUY', 250000, 100, 82, '[]'::jsonb,
  '2026-08-29 14:30:00+00', '2026-08-29 14:30:01+00', '2026-08-29 14:30:02+00',
  'OBSERVED', 'tradier', 'TRADIER_STREAM', 'PROBABLY_OK'
);

\echo ''
\echo '=== G2  signal identity ==========================================='

\echo '--- G2a  a second row on the same key  (must be refused)'
insert into public.signal_history (
  signal_key, content_hash, engine_id, kind, underlying, side,
  total_premium, total_size, score, legs,
  first_event_at, last_event_at, decision_at, decision_basis,
  source, dataset_id, rights_class
) values (
  'g1-ok', 'hash-DIFFERENT', 'sig_2', 'SWEEP', 'SPY', 'BUY', 999999, 100, 82, '[]'::jsonb,
  '2026-08-29 14:30:00+00', '2026-08-29 14:30:01+00', '2026-08-29 14:30:02+00',
  'OBSERVED', 'tradier', 'TRADIER_STREAM', 'PERMITTED'
);

\echo '--- G2b  the original is unchanged'
select signal_key, content_hash, total_premium from public.signal_history where signal_key = 'g1-ok';

\echo '--- G2c  an invented incident type  (must be refused)'
insert into public.signal_write_incidents
  (signal_key, incident_type, existing_content_hash, incoming_content_hash, note)
values ('g1-ok', 'PROBABLY_FINE', 'a', 'b', 'test');

\echo ''
\echo '=== G3  outcome immutability ======================================'

\echo '--- G3a  a graded outcome  (must be ACCEPTED)'
insert into public.signal_outcomes
  (signal_key, horizon, label, excursion, due_at, evaluated_at, revision)
values ('g1-ok', 'M15', 'POSITIVE', 0.0042,
        '2026-08-29 14:45:00+00', '2026-08-29 14:45:01+00', 1);

\echo '--- G3b  flipping the label in place  (must be refused)'
update public.signal_outcomes set label = 'NEGATIVE'
  where signal_key = 'g1-ok' and horizon = 'M15';

\echo '--- G3c  DELETE of a graded outcome  (must be refused)'
delete from public.signal_outcomes where signal_key = 'g1-ok' and horizon = 'M15';

\echo '--- G3d  a SECOND live row for the same (signal, horizon)  (must be refused)'
insert into public.signal_outcomes
  (signal_key, horizon, label, excursion, due_at, evaluated_at, revision)
values ('g1-ok', 'M15', 'NEGATIVE', -0.001,
        '2026-08-29 14:45:00+00', '2026-08-29 14:45:02+00', 2);

\echo '--- G3e  supersession: retire the old row, then insert the correction  (must be ACCEPTED)'
update public.signal_outcomes set superseded_at = now()
  where signal_key = 'g1-ok' and horizon = 'M15' and superseded_at is null;
insert into public.signal_outcomes
  (signal_key, horizon, label, excursion, due_at, evaluated_at, revision, supersedes)
select 'g1-ok', 'M15', 'NEGATIVE', -0.0010,
       '2026-08-29 14:45:00+00', '2026-08-29 14:45:02+00', 2, id
  from public.signal_outcomes
 where signal_key = 'g1-ok' and horizon = 'M15' and revision = 1;

\echo '--- G3f  BOTH revisions survive; exactly one is live'
select revision, label, excursion,
       case when superseded_at is null then 'LIVE' else 'SUPERSEDED' end as state
  from public.signal_outcomes where signal_key = 'g1-ok' order by revision;

\echo '--- G3g  an UNGRADED outcome with no reason  (must be refused)'
insert into public.signal_outcomes
  (signal_key, horizon, label, due_at, evaluated_at, revision)
values ('g1-ok', 'H1', 'UNGRADED',
        '2026-08-29 15:30:00+00', '2026-08-29 15:30:01+00', 1);

\echo '--- G3h  an UNGRADED outcome WITH a reason  (must be ACCEPTED)'
insert into public.signal_outcomes
  (signal_key, horizon, label, due_at, evaluated_at, revision, ungraded_reason)
values ('g1-ok', 'H1', 'UNGRADED',
        '2026-08-29 15:30:00+00', '2026-08-29 15:30:01+00', 1,
        'side was AMBIGUOUS so the signal implied no direction');

\echo '--- G3i  an outcome evaluated BEFORE it fell due  (must be refused)'
insert into public.signal_outcomes
  (signal_key, horizon, label, due_at, evaluated_at, revision)
values ('g1-ok', 'D1', 'POSITIVE',
        '2026-08-30 14:30:00+00', '2026-08-29 14:31:00+00', 1);

\echo '--- G3j  an invented horizon  (must be refused)'
insert into public.signal_outcomes
  (signal_key, horizon, label, due_at, evaluated_at, revision)
values ('g1-ok', 'M5', 'POSITIVE',
        '2026-08-29 14:35:00+00', '2026-08-29 14:35:01+00', 1);

\echo '--- G3k  an outcome for a signal that was never recorded  (must be refused)'
insert into public.signal_outcomes
  (signal_key, horizon, label, due_at, evaluated_at, revision)
values ('never-recorded', 'M15', 'POSITIVE',
        '2026-08-29 14:45:00+00', '2026-08-29 14:45:01+00', 1);

\echo ''
\echo '=== G4  collection gaps ==========================================='

\echo '--- G4a  an inverted gap window  (must be refused)'
insert into public.collection_gaps (id, kind, started_at, ended_at, reason)
values ('g-bad', 'NOT_OBSERVED', '2026-08-29 15:00:00+00', '2026-08-29 14:00:00+00',
        'render free tier spun the service down while idle');

\echo '--- G4b  a trivial reason  (must be refused)'
insert into public.collection_gaps (id, kind, started_at, ended_at, reason)
values ('g-thin', 'NOT_OBSERVED', '2026-08-29 14:00:00+00', '2026-08-29 15:00:00+00', 'oops');

\echo '--- G4c  an invented gap kind  (must be refused)'
insert into public.collection_gaps (id, kind, started_at, ended_at, reason)
values ('g-kind', 'PROBABLY_FINE', '2026-08-29 14:00:00+00', '2026-08-29 15:00:00+00',
        'render free tier spun the service down while idle');

\echo '--- G4d  a well-formed gap  (must be ACCEPTED)'
insert into public.collection_gaps (id, kind, started_at, ended_at, reason)
values ('g-ok', 'NOT_OBSERVED', '2026-08-29 14:00:00+00', '2026-08-29 15:00:00+00',
        'render free tier spun the service down after 15 minutes idle');

\echo ''
\echo '=== G5  RLS is default-deny ======================================='
\echo '--- Granting anon SELECT FIRST, exactly as Supabase does by default.'
\echo '--- Without the grant, anon is refused at the PRIVILEGE layer, which'
\echo '--- proves nothing about RLS. With it, RLS must be what returns zero.'

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
end $$;

grant usage on schema public to anon;
grant select on public.signal_history, public.signal_outcomes,
                public.signal_write_incidents, public.collection_gaps to anon;

\echo '--- as the owner: rows exist'
select 'owner' as who, (select count(*) from public.signal_history) as signals,
       (select count(*) from public.signal_outcomes) as outcomes,
       (select count(*) from public.collection_gaps) as gaps;

set role anon;
\echo '--- as anon WITH SELECT GRANTED: every table must return 0'
select 'anon' as who, (select count(*) from public.signal_history) as signals,
       (select count(*) from public.signal_outcomes) as outcomes,
       (select count(*) from public.collection_gaps) as gaps;
reset role;

\echo '--- no policy grants public read on any of the four tables'
select count(*) as public_read_policies
  from pg_policies
 where schemaname = 'public'
   and tablename in ('signal_history','signal_outcomes','signal_write_incidents','collection_gaps');

\echo ''
\echo '=== done — every ERROR above is a gate doing its job ==============='
