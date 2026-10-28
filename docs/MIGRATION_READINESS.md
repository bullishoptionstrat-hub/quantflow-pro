# Production migration readiness (2026-10-28)

Neither migration below has been applied to production by this work. The checks were run against a disposable local PostgreSQL 16.x cluster with the Supabase roles stubbed; that is not Supabase, and passing there does not make either change safe by itself.

## 1. `supabase/migrations/20261024100000_signal_entry_marks.sql` (on disk, unapplied in production as of the last read-only check)

**What happens without it.**
- Every `writeEntryMark` fails and is counted in `entryMarkWriteFailures`. Grading continues from the in-memory mark.
- Every `getEntryMark` during `recover()` throws and is counted in `entryMarkReadFailures`. Recovery then falls back to an outcome row's mark if one exists.
- A signal with no outcome row yet (that is, one restarted before M15) stays pending and is retried at the next boot. It is not graded from a fresh price.
- Net effect: a restart in the first 15 minutes after a decision still loses that entry mark, which is the loss this table exists to prevent.

**Verified on the disposable cluster:**
- The migration applies cleanly and re-runs cleanly.
- It refuses each of these:
  - a second mark for the same signal (primary key);
  - `UPDATE` and `DELETE` (write-once trigger);
  - a mark for a signal not in `signal_history` (foreign key);
  - a non-positive price (CHECK).
- A valid mark inserts.

**Preflight (read-only):**
- `select to_regclass('public.signal_entry_marks')` returns null.
- `signal_history` exists.

**Apply:** the file as-is. It is additive: one new table, its trigger, and RLS that denies by default.

**After applying:**
1. Re-run the same probes inside a transaction that rolls back.
2. Confirm that `history.grader.entryMarkWriteFailures` stops growing on `/api/health`.

**Rollback:**
- `drop table public.signal_entry_marks` is safe only before any mark has been written.
- After that, roll forward instead, because the marks are the evidence the table exists to keep.

## 2. Proposal: `docs/proposals/20261028_synthetic_no_default.sql` (not a migration yet)

**Risk.** `signal_history.synthetic` is `not null default false`. Measured on the disposable cluster, an insert that omits the column stores `f`, which means a real signal. The only writer, `toRow`, now sends `synthetic: r.synthetic !== false`, so the code fails closed already. The default is what would mislabel rows for any future writer, including a manual SQL insert.

**Change.** `alter column synthetic drop default`. Measured on the disposable cluster:
- an insert that omits the column is refused (23502);
- an explicit `true` still inserts;
- re-running the change is harmless.

**Preflight:** `select count(*) from public.signal_history where synthetic is null` must return 0. It is guaranteed by `not null`, and the query checks it.

**Risks:**
- Any external writer that relied on the default starts failing loudly. None is known in this repo.
- The change takes a brief `ACCESS EXCLUSIVE` lock and rewrites no rows.

**Rollback:** `alter table public.signal_history alter column synthetic set default false;`
