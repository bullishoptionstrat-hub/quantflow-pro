-- ============================================================================
-- WAVE 3 — Truth Firewall provenance columns
--
-- DESIGN RULE: extend the existing tables. No parallel "v2" tables are created,
-- because the current schema is sound (flow_archive already separates event_at
-- from created_at) and duplicating it would strand both copies.
--
-- Every statement is idempotent (IF NOT EXISTS / DROP IF EXISTS) so re-running
-- is safe. The paired rollback is 20260828000000_provenance.down.sql.
--
-- Backward compatibility: every added column is NULLABLE or has a DEFAULT, so
-- existing writers and readers keep working untouched. Nothing is renamed.
-- ============================================================================

-- ─── flow_archive: full provenance envelope ─────────────────────────────────

alter table public.flow_archive
  -- Times. event_at already exists and stays the authoritative exchange time.
  add column if not exists provider_timestamp   timestamptz,
  add column if not exists exchange_timestamp   timestamptz,
  add column if not exists received_at          timestamptz,
  add column if not exists ingested_at          timestamptz,
  add column if not exists processed_at         timestamptz,

  -- Provenance. Defaults are the SAFE value: false for "is this real",
  -- so a row inserted by an un-migrated writer is never assumed live.
  add column if not exists source_type          text,
  add column if not exists raw_or_derived       text not null default 'raw',
  add column if not exists is_synthetic         boolean not null default false,
  add column if not exists is_demo              boolean not null default false,
  add column if not exists is_delayed           boolean not null default false,
  add column if not exists estimated_delay_seconds integer,
  add column if not exists is_inferred          boolean not null default false,
  add column if not exists inference_method     text,
  add column if not exists confidence           numeric(4,3),
  add column if not exists quality_score        numeric(4,3),
  add column if not exists provider_status      text,
  add column if not exists schema_version       integer not null default 2,
  add column if not exists calculation_version  text,

  -- Idempotency: the provider's own id for this event, when it has one.
  add column if not exists provider_event_id    text,

  -- Classification honesty (Wave 4 vocabulary).
  add column if not exists classification_grade text,
  add column if not exists inferred_side        text;

-- Constraints mirror validateProvenance() in backend/src/config/provenance.ts.
-- The database refuses the same malformed states the application refuses, so a
-- direct SQL writer cannot bypass the Truth Firewall.

alter table public.flow_archive drop constraint if exists flow_archive_delay_ck;
alter table public.flow_archive add constraint flow_archive_delay_ck
  check (not is_delayed or estimated_delay_seconds is not null);

alter table public.flow_archive drop constraint if exists flow_archive_inference_ck;
alter table public.flow_archive add constraint flow_archive_inference_ck
  check (not is_inferred or (inference_method is not null and confidence is not null));

alter table public.flow_archive drop constraint if exists flow_archive_confidence_ck;
alter table public.flow_archive add constraint flow_archive_confidence_ck
  check (confidence is null or (confidence >= 0 and confidence <= 1));

alter table public.flow_archive drop constraint if exists flow_archive_quality_ck;
alter table public.flow_archive add constraint flow_archive_quality_ck
  check (quality_score is null or (quality_score >= 0 and quality_score <= 1));

-- is_synthetic and is_demo travel together, exactly as in the app.
alter table public.flow_archive drop constraint if exists flow_archive_synthetic_demo_ck;
alter table public.flow_archive add constraint flow_archive_synthetic_demo_ck
  check (is_synthetic = is_demo);

alter table public.flow_archive drop constraint if exists flow_archive_raw_or_derived_ck;
alter table public.flow_archive add constraint flow_archive_raw_or_derived_ck
  check (raw_or_derived in ('raw','derived'));

alter table public.flow_archive drop constraint if exists flow_archive_grade_ck;
alter table public.flow_archive add constraint flow_archive_grade_ck
  check (classification_grade is null or
         classification_grade in ('OBSERVED','STRONG_INFERENCE','WEAK_INFERENCE','UNKNOWN'));

alter table public.flow_archive drop constraint if exists flow_archive_side_ck;
alter table public.flow_archive add constraint flow_archive_side_ck
  check (inferred_side is null or
         inferred_side in ('BUY','SELL','BUY_LEAN','SELL_LEAN','AMBIGUOUS'));

-- Dedup / idempotency: one row per (source, provider_event_id) when the
-- provider supplies an id. Partial index so rows without one are unaffected.
create unique index if not exists uq_flow_archive_provider_event
  on public.flow_archive (source, provider_event_id)
  where provider_event_id is not null;

-- Query paths that actually exist in the app.
create index if not exists idx_flow_archive_synthetic
  on public.flow_archive (is_synthetic, event_at desc);
create index if not exists idx_flow_archive_source_event_at
  on public.flow_archive (source, event_at desc);

-- ─── price_history: provenance for cached bars ──────────────────────────────

alter table public.price_history
  add column if not exists source              text,
  add column if not exists is_synthetic        boolean not null default false,
  add column if not exists is_demo             boolean not null default false,
  add column if not exists is_delayed          boolean not null default false,
  add column if not exists estimated_delay_seconds integer,
  add column if not exists received_at         timestamptz,
  add column if not exists schema_version      integer not null default 2;

alter table public.price_history drop constraint if exists price_history_delay_ck;
alter table public.price_history add constraint price_history_delay_ck
  check (not is_delayed or estimated_delay_seconds is not null);

alter table public.price_history drop constraint if exists price_history_synthetic_demo_ck;
alter table public.price_history add constraint price_history_synthetic_demo_ck
  check (is_synthetic = is_demo);

-- ─── power_alerts: provenance so an alert can prove what triggered it ───────

alter table public.power_alerts
  add column if not exists is_synthetic       boolean not null default false,
  add column if not exists is_demo            boolean not null default false,
  add column if not exists source             text,
  add column if not exists confidence         numeric(4,3),
  add column if not exists schema_version     integer not null default 2,
  -- Dedup key for Wave 9's alert cooldown.
  add column if not exists dedup_key          text;

alter table public.power_alerts drop constraint if exists power_alerts_synthetic_demo_ck;
alter table public.power_alerts add constraint power_alerts_synthetic_demo_ck
  check (is_synthetic = is_demo);

alter table public.power_alerts drop constraint if exists power_alerts_confidence_ck;
alter table public.power_alerts add constraint power_alerts_confidence_ck
  check (confidence is null or (confidence >= 0 and confidence <= 1));

create index if not exists idx_power_alerts_dedup
  on public.power_alerts (dedup_key, created_at desc)
  where dedup_key is not null;

-- ─── flow_outcomes: Wave 7's grading target ─────────────────────────────────
-- New table, justified: no existing table stores forward returns, and grading
-- results have a different lifecycle (written later, by a scheduled job) than
-- the events they grade.

create table if not exists public.flow_outcomes (
  id                  uuid primary key default gen_random_uuid(),
  flow_event_id       text not null references public.flow_archive(id) on delete cascade,

  -- Causal timestamps. These MUST differ where the concept requires it.
  signal_at           timestamptz not null,
  actionable_at       timestamptz not null,
  horizon             text not null check (horizon in ('15m','1h','1d')),
  evaluated_at        timestamptz,

  entry_mark          numeric(14,4),
  exit_mark           numeric(14,4),
  underlying_return   numeric(10,6),

  -- UNGRADED is a first-class outcome: an ambiguous side or missing marks is
  -- never guessed into a win or a loss.
  label               text not null default 'UNGRADED'
                      check (label in ('WIN','LOSS','FLAT','UNGRADED')),
  ungraded_reason     text,

  -- Honest scope: free data gives underlying returns, not option P&L.
  return_basis        text not null default 'underlying'
                      check (return_basis in ('underlying','option_mark')),

  is_synthetic        boolean not null default false,
  is_demo             boolean not null default false,
  calculation_version text,
  schema_version      integer not null default 2,
  created_at          timestamptz not null default now(),

  -- One grade per event per horizon.
  unique (flow_event_id, horizon)
);

-- An actionable time before the signal time would be lookahead.
alter table public.flow_outcomes drop constraint if exists flow_outcomes_causality_ck;
alter table public.flow_outcomes add constraint flow_outcomes_causality_ck
  check (actionable_at >= signal_at);

-- A graded row must say what it was graded from.
alter table public.flow_outcomes drop constraint if exists flow_outcomes_graded_ck;
alter table public.flow_outcomes add constraint flow_outcomes_graded_ck
  check (label = 'UNGRADED' or underlying_return is not null);

-- An ungraded row must say why.
alter table public.flow_outcomes drop constraint if exists flow_outcomes_ungraded_reason_ck;
alter table public.flow_outcomes add constraint flow_outcomes_ungraded_reason_ck
  check (label <> 'UNGRADED' or evaluated_at is null or ungraded_reason is not null);

create index if not exists idx_flow_outcomes_event on public.flow_outcomes (flow_event_id);
create index if not exists idx_flow_outcomes_label on public.flow_outcomes (label, horizon);
create index if not exists idx_flow_outcomes_training
  on public.flow_outcomes (signal_at)
  where label <> 'UNGRADED' and is_synthetic = false;

alter table public.flow_outcomes enable row level security;

drop policy if exists "flow_outcomes_public_read" on public.flow_outcomes;
create policy "flow_outcomes_public_read" on public.flow_outcomes
  for select using (true);
