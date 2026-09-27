# research/

§95 and §98. **Empty on purpose, and the emptiness is load-bearing.**

There are zero real graded outcomes in this system. `signal_outcomes` holds 0
rows; every one of the 4,559 signals in `signal_history` is synthetic. So there
is nothing to test, and `rejected/` is empty because nothing has been rejected
rather than because nothing has failed.

**The template exists now precisely because the data does not.** §95 requires a
hypothesis be frozen *before* validation is examined, and the cheapest moment to
write an honest failure criterion is while there is no result to be disappointed
by. A pre-registration written after the first look is not a pre-registration.

- `hypotheses/` — one file per frozen question. Frozen means the failure
  criterion was written before any result existed.
- `rejected/` — hypotheses that failed. **Never deleted.** They are the
  denominator of the search (§100): one strategy out of five hundred looking
  excellent is not the same evidence as one pre-registered strategy looking
  excellent, and the only way that stays visible is if the other 499 are still
  on disk.

**2026-09-27.** Three additions, all before any real data:

- `hypotheses/H-001-v2-…` — H-001 re-frozen with an exact stop date, a unit of
  analysis, an estimand, an inference plan, a precision target instead of
  n ≥ 30, an equivalence margin, matched controls and a strictly causal quote.
  v1 is preserved unchanged; both files are pinned by hash in
  `backend/test/researchIntegrity.test.ts`.
- `DATASET_EXPOSURE_LEDGER.csv` — every look at data, with its role
  (DEVELOPMENT / VALIDATION / HOLDOUT / CONTAMINATED). A role is never reset.
  Today every row is synthetic or operational, and none touches H-001-v2's
  windows — which a test asserts.
- `SEARCH_LEDGER.csv` — every registered version, superseded ones included.
- `manifests/` — the rights a research dataset carries, per axis. Both
  candidates are UNVERIFIED on every axis; nothing may be imported against them.
