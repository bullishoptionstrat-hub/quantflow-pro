-- When each mark on a graded outcome was true, on the vendor's clock.
--
-- `20260915090000_mark_source.sql` made it impossible to record a mark without
-- knowing *where* the price came from. This is the same argument one step
-- further: it was still possible to record one without knowing *when*, and the
-- grader was measuring a move between two prices having never established that
-- one came after the other.
--
-- That was invisible while the mark cache refreshed every sixty seconds and
-- reachable the moment it refreshed every nineteen minutes — the free-tier
-- rotation in `connectors/twelveData.ts`. At the M15 checkpoint such a cache
-- routinely returns a price stamped *before* the decision instant, so the
-- excursion was measured backwards across the signal it was grading. Same
-- shape as the NBBO look-ahead the engine already refuses: there a quote
-- stamped after the trade sailed through a subtraction, here a mark stamped
-- before the checkpoint sailed through a division.
--
-- These are the vendor's stamps, not receipt time. Off-hours they differ by
-- hours and the receipt-time answer is the flattering one — it reports a price
-- from the last close as though it had just been observed.
--
-- The horizon column stays a *scheduling* label: when the checkpoint fell due.
-- These two are what was actually measured between, kept as instants rather
-- than collapsed into a duration for the same reason `MAX_EXCURSION` is named
-- on the payload instead of presented as a held return — a reader months later
-- should be able to see that an `M15` row spanned nineteen minutes instead of
-- taking the label's word for it.
--
-- Nullable, because a mark is: an UNGRADED outcome carries neither price nor
-- stamp. Safe against the append-only trigger — `enforce_outcome_immutability`
-- fires on UPDATE and DELETE, and adding a nullable column is neither.

alter table public.signal_outcomes
  add column if not exists entry_mark_at timestamptz,
  add column if not exists exit_mark_at  timestamptz;

comment on column public.signal_outcomes.entry_mark_at is
  'When the entry price was true, on the vendor''s clock — not when this '
  'process received it. The grader refuses an entry mark older than the '
  'shortest horizon it measures, because past that the excursion''s '
  'denominator is a price from before the signal existed.';

comment on column public.signal_outcomes.exit_mark_at is
  'When the checkpoint price was true. The grader refuses a mark stamped '
  'before due_at: a mark source that refreshes more slowly than the horizon '
  'is long never observed the checkpoint it is being used to grade.';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'signal_outcomes_mark_has_as_of'
  ) then
    alter table public.signal_outcomes
      add constraint signal_outcomes_mark_has_as_of
      check (
        (entry_mark is null or entry_mark_at is not null)
        and (exit_mark is null or exit_mark_at is not null)
        -- The grader's forward rule, made structural. A row claiming a move
        -- between two prices must be able to show which came first; equal
        -- stamps measure no interval and a reversed pair measures one
        -- backwards. This is the `decision_at >= last_event_at` move applied
        -- to the marks rather than to the prints.
        and (
          entry_mark_at is null or exit_mark_at is null
          or exit_mark_at > entry_mark_at
        )
      )
      -- Rows written before this migration have marks and no stamps, and they
      -- are history: validating against them would either fail the migration
      -- or invite a backfill that invents a clock. The constraint binds every
      -- row written from here on, which is the set it can protect.
      not valid;
  end if;
end $$;
