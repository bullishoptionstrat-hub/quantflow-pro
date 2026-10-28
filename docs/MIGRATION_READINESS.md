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

### 2a. Proposal B compatibility run (disposable PostgreSQL 16, 2026-10-28)

Run on a throwaway local cluster against a table with the same column
definition (`synthetic boolean not null default false`). This is not
production validation.

| Case | Before drop default | After drop default |
|---|---|---|
| Insert omitting `synthetic` | stored `false` | refused, 23502 |
| Explicit `null` | refused (NOT NULL) | refused |
| Explicit `true` / `false` | stored | stored |
| Bulk insert of 3 rows, one `null` | — | **whole statement refused**; the two valid rows are not stored |
| Bulk insert, all explicit | — | stored |
| Upsert omitting `synthetic` that **conflicts** with an existing row | — | **refused**: NOT NULL is checked on the proposed row before `ON CONFLICT` runs |
| Upsert with explicit value, conflicting | — | update applied |
| `ON CONFLICT DO NOTHING`, field omitted | — | refused |
| `UPDATE` of another column on an existing row | — | allowed |
| Rows stored before the change | unchanged | unchanged |
| Re-running the `alter` | — | no-op, no error |

Two consequences for the writer. A batch is all-or-nothing, so one row
missing the field loses the whole batch, not just that row. And an upsert
must carry the field even when it only updates. `supabaseStore.toRow` always
writes `synthetic` (`r.synthetic !== false`), so neither applies to the
current code. PostgREST fills a key missing from some objects in a bulk body
with NULL unless the request sends `Prefer: missing=default`; this was not
measured here.

### 2b. Proposal B and PostgREST (2026-10-28)

| Layer | Finding | Basis |
|---|---|---|
| What the client sends | One write path into `signal_history`: `supabaseStore.ts` `.insert(toRow(rec))`, a **single object** that always carries `synthetic: r.synthetic !== false`, a boolean. There is no bulk insert, upsert or update of this table in `src/` or `tools/`. | Source, this commit |
| postgrest-js 2.110.8 (installed) | For an **array** body it builds `?columns=` from the union of every row's keys. With the default `defaultToNull: true`, a row missing a key is sent without it under that column list. `defaultToNull: false` adds `Prefer: missing=default`. | Installed `dist/index.cjs` |
| What PostgREST does with a missing key under `?columns=` | Expected NULL, or the column default under `missing=default`. **UNKNOWN**: docs.postgrest.org is blocked by this session's network policy, and no PostgREST binary is available here. | Not established |
| What PostgreSQL enforces | NOT NULL with no default refuses the row. One bad row refuses the whole statement. | Disposable PG16, §2a |

Compatibility: with the current writer the change is safe, because it never omits the field and never writes in bulk. A future bulk writer would need `synthetic` on every row. Under Proposal B, `missing=default` would no longer supply `false`; it would fall back to NULL and be refused. That is the intended failure.

Still unverified: PostgREST's own handling of the cases above, and Supabase's gateway in front of it.
