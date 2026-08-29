-- QuantFlow Pro — durable signal history
--
-- The application enforces these rules in `backend/src/persistence`. They are
-- repeated here as constraints because application-layer enforcement lasts
-- exactly as long as every writer goes through the application, and a research
-- record that can be corrupted by one `psql` session is not a record.
--
-- Rules made structural below:
--   1. decision_at >= last_event_at >= first_event_at  (no lookahead)
--   2. a graded outcome cannot be edited or deleted    (append-only)
--   3. one live outcome per (signal, horizon)          (no silent duplicates)
--   4. RLS default-deny on every table                 (not public research data)

begin;

-- ─── Signals ────────────────────────────────────────────────────────────────

create table if not exists public.signal_history (
  -- Content hash. Stable across process restarts, unlike the engine's
  -- sequence id, which restarts at 1 on every boot.
  signal_key        text primary key,
  content_hash      text not null,
  engine_id         text not null,

  kind              text not null,
  underlying        text not null,
  side              text not null,
  total_premium     numeric not null,
  total_size        bigint  not null,
  iso               boolean not null default false,
  score             numeric not null,
  score_breakdown   jsonb   not null default '{}'::jsonb,
  legs              jsonb   not null,
  spread_guess      text,

  -- Time. `first_event_at` is retained for display and is deliberately NOT
  -- the measurement column; see the comment below.
  first_event_at    timestamptz not null,
  last_event_at     timestamptz not null,
  decision_at       timestamptz not null,
  decision_basis    text not null,
  latency_ms        integer not null default 0,

  -- Provenance
  source            text not null,
  dataset_id        text not null,
  rights_class      text not null,
  synthetic         boolean not null default false,
  recorded_at       timestamptz not null default now(),

  constraint signal_history_timeline_ordered
    check (decision_at >= last_event_at and last_event_at >= first_event_at),
  constraint signal_history_decision_basis_valid
    check (decision_basis in ('OBSERVED', 'EVENT_TIME_ONLY')),
  constraint signal_history_rights_class_valid
    check (rights_class in ('PERMITTED', 'PROHIBITED', 'UNVERIFIED', 'UNKNOWN_DATASET'))
);

comment on column public.signal_history.first_event_at is
  'DEPRECATED for research windows: the first print of the cluster, at which '
  'moment the signal did not yet exist. Measuring from here grants the backtest '
  'the burst duration as free information. Use decision_at.';

comment on column public.signal_history.decision_at is
  'max(last_event_at, received_at, emitted_at) — the earliest instant the signal '
  'was actionable. The only column a forward measurement may start from.';

comment on column public.signal_history.decision_basis is
  'OBSERVED = every term was measured. EVENT_TIME_ONLY = no receipt/emission '
  'clock was available (replay), so decision_at is a lower bound that credits '
  'zero latency. The two must not be pooled in one claim.';

create index if not exists signal_history_decision_at_idx
  on public.signal_history (decision_at desc);
create index if not exists signal_history_underlying_idx
  on public.signal_history (underlying, decision_at desc);
-- Partial: the research population is the real, permitted, observed subset,
-- and it is the one every track-record query filters to.
create index if not exists signal_history_research_idx
  on public.signal_history (kind, decision_at desc)
  where synthetic = false
    and rights_class = 'PERMITTED'
    and decision_basis = 'OBSERVED';

-- ─── Outcomes ───────────────────────────────────────────────────────────────

create table if not exists public.signal_outcomes (
  id              bigserial primary key,
  signal_key      text not null references public.signal_history(signal_key) on delete restrict,
  horizon         text not null,
  label           text not null,
  excursion       numeric,
  entry_mark      numeric,
  exit_mark       numeric,
  due_at          timestamptz not null,
  evaluated_at    timestamptz not null,
  ungraded_reason text,
  revision        integer not null default 1,
  supersedes      bigint references public.signal_outcomes(id),
  -- Retires this row. Separate from `supersedes` on the replacement: keeping
  -- them in one column creates a chicken-and-egg deadlock, because the new row
  -- cannot be inserted while the old one is live and the old one cannot be
  -- retired before the new one exists.
  superseded_at   timestamptz,

  constraint signal_outcomes_horizon_valid
    check (horizon in ('M15', 'H1', 'D1', 'EXPIRY')),
  constraint signal_outcomes_label_valid
    check (label in ('POSITIVE', 'NEGATIVE', 'FLAT', 'UNGRADED')),
  -- An UNGRADED row with no reason cannot be told apart from a grading bug.
  constraint signal_outcomes_ungraded_has_reason
    check (label <> 'UNGRADED' or (ungraded_reason is not null and length(trim(ungraded_reason)) >= 10)),
  constraint signal_outcomes_evaluated_after_due
    check (evaluated_at >= due_at)
);

-- One live row per (signal, horizon). Corrections supersede; they never
-- duplicate.
create unique index if not exists signal_outcomes_one_live
  on public.signal_outcomes (signal_key, horizon)
  where superseded_at is null;

create index if not exists signal_outcomes_signal_idx
  on public.signal_outcomes (signal_key);

-- Append-only enforcement. A graded outcome is a recorded measurement; editing
-- it in place rewrites history with no trace that anything changed.
create or replace function public.enforce_outcome_immutability()
returns trigger
language plpgsql
as $$
begin
  if (tg_op = 'DELETE') then
    raise exception
      'signal_outcomes is append-only: DELETE on outcome % rejected. Supersede it instead.',
      old.id;
  end if;

  -- Retiring a row (setting superseded_at) is the one permitted update, and
  -- only once.
  if (old.superseded_at is null and new.superseded_at is not null
      and old.label is not distinct from new.label
      and old.excursion is not distinct from new.excursion
      and old.revision = new.revision) then
    return new;
  end if;

  raise exception
    'outcome % (horizon %, label %) is immutable. To correct it, insert a new row with supersedes=% and revision=%, then set superseded_at on this one.',
    old.id, old.horizon, old.label, old.id, old.revision + 1;
end;
$$;

drop trigger if exists trg_outcome_immutability on public.signal_outcomes;
create trigger trg_outcome_immutability
  before update or delete on public.signal_outcomes
  for each row execute function public.enforce_outcome_immutability();

-- ─── Write incidents ────────────────────────────────────────────────────────
--
-- A duplicate key carrying different content is not a retry. Treating it as
-- idempotent — the usual default — silently accepts a rewrite of history, so
-- it is recorded here and the original row is kept.

create table if not exists public.signal_write_incidents (
  id                     bigserial primary key,
  signal_key             text not null,
  incident_type          text not null,
  existing_content_hash  text not null,
  incoming_content_hash  text not null,
  detected_at            timestamptz not null default now(),
  note                   text not null,

  constraint signal_write_incidents_type_valid
    check (incident_type in ('HISTORY_COLLISION'))
);

create index if not exists signal_write_incidents_detected_idx
  on public.signal_write_incidents (detected_at desc);

-- ─── Collection gaps ────────────────────────────────────────────────────────
--
-- OBSERVED_EMPTY (we were collecting, nothing happened) and NOT_OBSERVED (we
-- were not collecting) are different facts. Conflating them lets an outage be
-- read as a quiet market — and outages cluster in volatile sessions, which is
-- exactly where a signal would be tested hardest.

create table if not exists public.collection_gaps (
  id          text primary key,
  kind        text not null,
  started_at  timestamptz not null,
  ended_at    timestamptz not null,
  reason      text not null,
  source      text,

  constraint collection_gaps_kind_valid
    check (kind in ('OBSERVED_EMPTY', 'NOT_OBSERVED', 'MARKET_CLOSED')),
  constraint collection_gaps_window_ordered
    check (ended_at >= started_at),
  constraint collection_gaps_reason_substantive
    check (length(trim(reason)) >= 10)
);

create index if not exists collection_gaps_window_idx
  on public.collection_gaps (started_at, ended_at);

-- ─── RLS: default deny ──────────────────────────────────────────────────────
--
-- These tables hold reconstructable options microstructure. They are not
-- public data and they get no public read policy. The service role is the only
-- research path; it bypasses RLS by design.
--
-- Note for anyone verifying this locally: without a table-level GRANT the
-- local `anon` role is refused at the privilege layer, which proves nothing
-- about RLS. Supabase grants anon SELECT by default, so a real proof must
-- GRANT first and then confirm zero rows come back.

alter table public.signal_history          enable row level security;
alter table public.signal_outcomes         enable row level security;
alter table public.signal_write_incidents  enable row level security;
alter table public.collection_gaps         enable row level security;

alter table public.signal_history          force row level security;
alter table public.signal_outcomes         force row level security;
alter table public.signal_write_incidents  force row level security;
alter table public.collection_gaps         force row level security;

commit;
