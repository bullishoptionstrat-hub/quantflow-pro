-- ============================================================================
-- ROLLBACK for 20260828000000_provenance.sql
--
-- Restores the schema to its pre-migration shape. Verified by executing it
-- against a real Postgres loaded with the production schema and diffing the
-- column list before and after (see IMPLEMENTATION_LEDGER.md, Wave 3).
--
-- Destructive by nature: dropping the columns discards any provenance recorded
-- while the migration was applied. flow_outcomes is dropped entirely, since it
-- did not exist before.
-- ============================================================================

drop table if exists public.flow_outcomes;

-- ─── power_alerts ───────────────────────────────────────────────────────────
drop index if exists public.idx_power_alerts_dedup;
alter table public.power_alerts drop constraint if exists power_alerts_synthetic_demo_ck;
alter table public.power_alerts drop constraint if exists power_alerts_confidence_ck;
alter table public.power_alerts
  drop column if exists is_synthetic,
  drop column if exists is_demo,
  drop column if exists source,
  drop column if exists confidence,
  drop column if exists schema_version,
  drop column if exists dedup_key;

-- ─── price_history ──────────────────────────────────────────────────────────
alter table public.price_history drop constraint if exists price_history_delay_ck;
alter table public.price_history drop constraint if exists price_history_synthetic_demo_ck;
alter table public.price_history
  drop column if exists source,
  drop column if exists is_synthetic,
  drop column if exists is_demo,
  drop column if exists is_delayed,
  drop column if exists estimated_delay_seconds,
  drop column if exists received_at,
  drop column if exists schema_version;

-- ─── flow_archive ───────────────────────────────────────────────────────────
drop index if exists public.uq_flow_archive_provider_event;
drop index if exists public.idx_flow_archive_synthetic;
drop index if exists public.idx_flow_archive_source_event_at;

alter table public.flow_archive drop constraint if exists flow_archive_delay_ck;
alter table public.flow_archive drop constraint if exists flow_archive_inference_ck;
alter table public.flow_archive drop constraint if exists flow_archive_confidence_ck;
alter table public.flow_archive drop constraint if exists flow_archive_quality_ck;
alter table public.flow_archive drop constraint if exists flow_archive_synthetic_demo_ck;
alter table public.flow_archive drop constraint if exists flow_archive_raw_or_derived_ck;
alter table public.flow_archive drop constraint if exists flow_archive_grade_ck;
alter table public.flow_archive drop constraint if exists flow_archive_side_ck;

alter table public.flow_archive
  drop column if exists provider_timestamp,
  drop column if exists exchange_timestamp,
  drop column if exists received_at,
  drop column if exists ingested_at,
  drop column if exists processed_at,
  drop column if exists source_type,
  drop column if exists raw_or_derived,
  drop column if exists is_synthetic,
  drop column if exists is_demo,
  drop column if exists is_delayed,
  drop column if exists estimated_delay_seconds,
  drop column if exists is_inferred,
  drop column if exists inference_method,
  drop column if exists confidence,
  drop column if exists quality_score,
  drop column if exists provider_status,
  drop column if exists schema_version,
  drop column if exists calculation_version,
  drop column if exists provider_event_id,
  drop column if exists classification_grade,
  drop column if exists inferred_side;
