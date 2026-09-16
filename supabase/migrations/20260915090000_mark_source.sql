-- Which source priced each mark on a graded outcome.
--
-- The grader used to take its underlying price from one hard-wired vendor
-- (`getSpotPrice`, Twelve Data's cache), so "where did this price come from?"
-- was answerable from the deployment's configuration and nowhere else. It now
-- resolves from a ranked registry, and a track record whose rows cannot say
-- which vendor priced them cannot be audited after the fact.
--
-- Nullable, because a mark is: an outcome with no usable price is UNGRADED and
-- carries neither. The CHECK below is what makes the pairing structural — the
-- same move as `signal_outcomes_ungraded_has_reason`, which refuses an UNGRADED
-- row with no stated reason because it cannot be told apart from a bug. A mark
-- with no source is the same shape of unreadable row.
--
-- Safe against the append-only trigger: `enforce_outcome_immutability` fires on
-- UPDATE and DELETE only, and adding a nullable column is neither. Existing
-- rows keep NULL, which is correct rather than backfilled — nothing here knows
-- what priced them, and inventing 'twelvedata' for history would be exactly the
-- fabricated-provenance this column exists to prevent.

alter table public.signal_outcomes
  add column if not exists entry_mark_source text,
  add column if not exists exit_mark_source  text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'signal_outcomes_mark_has_source'
  ) then
    alter table public.signal_outcomes
      add constraint signal_outcomes_mark_has_source
      check (
        (entry_mark is null or entry_mark_source is not null)
        and (exit_mark is null or exit_mark_source is not null)
      )
      -- Rows written before this migration have marks and no source, and they
      -- are history: validating against them would either fail the migration or
      -- invite a backfill that invents provenance. The constraint binds every
      -- row written from here on, which is the set it can actually protect.
      not valid;
  end if;
end $$;
