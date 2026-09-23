-- Rename `signal_outcomes.excursion` to `directional_return_at_horizon`.
--
-- The column has always held `(exit_mark - entry_mark) / entry_mark`, signed by
-- the signal's implied direction: the return at the horizon's *endpoint*. An
-- excursion is a property of the **path** — the furthest the underlying
-- travelled between the two marks — and nothing in this system observes a path.
-- Two marks are taken, one at each end, and everything between them is unseen.
--
-- The two quantities coincide only when the move is monotone, and where they
-- differ it is always in the flattering direction, because a maximum favourable
-- excursion is by construction at least as large as the endpoint return. That
-- is the category's characteristic lie — quoting a best-moment measure as
-- though a position had been held — so the old name asserted about this
-- arithmetic precisely the thing the arithmetic does not do.
--
-- Data-preserving: `rename column` keeps every row, every index and the
-- unique partial index, and `signal_outcomes` is at zero rows on the only
-- deployment this has been applied to. Guarded so a re-run is a no-op rather
-- than an error, because these files are run by hand.

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name   = 'signal_outcomes'
      and column_name  = 'excursion'
  ) then
    alter table public.signal_outcomes
      rename column excursion to directional_return_at_horizon;
  end if;
end;
$$;

-- The append-only trigger reads this column by name. plpgsql resolves `old.x`
-- against the record's *runtime* shape, so the rename above would not have
-- failed here at migration time — it would have failed at the first attempt to
-- retire a row, with `record "old" has no field "excursion"`, which is the one
-- permitted update and therefore the path corrections take. Renaming the column
-- without this is a live break of the correction mechanism.
--
-- `set search_path = ''` is restated rather than left to the earlier
-- `alter function`: `create or replace function` replaces the function's
-- configuration along with its body, so omitting it here would silently unpin
-- what `20260916060000_function_search_path.sql` pinned. Empty rather than
-- `'public'` because the body references no table and calls no function
-- outside `pg_catalog`.
create or replace function public.enforce_outcome_immutability()
returns trigger
language plpgsql
set search_path = ''
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
      and old.directional_return_at_horizon
          is not distinct from new.directional_return_at_horizon
      and old.revision = new.revision) then
    return new;
  end if;

  raise exception
    'outcome % (horizon %, label %) is immutable. To correct it, insert a new row with supersedes=% and revision=%, then set superseded_at on this one.',
    old.id, old.horizon, old.label, old.id, old.revision + 1;
end;
$$;
