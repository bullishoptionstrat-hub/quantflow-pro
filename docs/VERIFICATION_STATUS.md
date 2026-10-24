# Verification status: what has been checked locally, and what only a live provider can check

Dated 2026-10-24, at `main` = `fde46ed` (after #95–#98). This is a record of one moment.
The counts below are evidence of that moment only, and will go stale; re-run the commands
to get today's numbers.

## External blocker: GitHub Actions is billing-locked

`.github/workflows/verify.yml` runs on every push and every pull request. **Since the lock,
no job has actually run.** Each run reports `failure` about three seconds after it is
created, and the job records no executed steps. That holds for runs #80 through #108 and for every merge of
#90 through #98.

So:

- **No claim in this repository says CI passed**, and none should until a real Actions run
  goes green.
- Every result below comes from a local run in the development container.
- Once billing is resolved: re-run `verify` on `main`, then on the current branch head.
  Treat any failure as real, not as residue from the lock.

## Local results at `fde46ed`

| Suite | Command | Result |
|---|---|---|
| Backend: typecheck (src, test, tools, engine module) and suite | `cd backend && npm run verify` | 959 pass, 0 fail |
| Backend against real PostgreSQL 17 + PostgREST | `cd backend && npm run test:pg` | 27 pass, 0 fail |
| Frontend: typecheck and Vitest | `cd frontend && npm run verify` | 168 pass, 0 fail |
| Flow-engine module | `cd quantflow-modules/flow-engine && npm test` | 30 pass, 0 fail |

Mutation passes ran for every change in #95–#98. Each mutation was applied, the relevant
tests were run, and the original was restored. Every mutation that survived on the first
pass now fails a test added for it. The one exception is an equivalent mutation, which is
recorded as such in that PR. Survivors are named in each PR and in `CLAUDE.md`.

## Locally verified versus needing a live provider

| Behaviour | Locally verified | Needs live validation |
|---|---|---|
| Keys come from the environment only; no key in source (#95) | Yes. The guard fails on both `NAME=value` and the object-literal form. | — |
| Exposed keys revoked at the vendor (#95) | No. Rotation happens outside this repo. | **Yes:** `npm run security:verify` after rotation asks each vendor whether the old key still works. |
| Tradier subscribes to option contracts, turns timesales into prints, refuses cancels (#93) | Yes, against fixtures in Tradier's documented shapes. | **Yes.** The documentation is SEARCH_ONLY, `api.tradier.com` is blocked here, and no production session has run. |
| Tradier universe settings, and refusal on a malformed value (#96) | Yes. | Whether the universe contains real OCC symbols. |
| Tradier signals held until the stream validates (#96) | Yes. The validator, the recorder hold, coverage and the doctor are all driven by tests. | **Yes.** It flips to VALIDATED only on a real stream; `docs/TRADIER_LIVE_VALIDATION.md` has the first-boot checklist. |
| Polygon disabled, with the reason stated on `/api/health` (#94) | Yes. | — (kept disabled by decision) |
| Entry mark persisted when taken; a restart before M15 still grades (#97) | Yes, in both stores, including real PostgreSQL. | **Applying the migration to the live Supabase project.** Until then, entry-mark writes there fail; the failures are counted and grading falls back to the old behaviour. |
| Isolated ingestion instances; the live pipeline unchanged (#98) | Yes. 11 isolation tests; a keyless boot recorded 72 of 72 signals through the default instance. | — |
| §I staleness re-runs at 1 s and 5 s (#98) | The replay and the H-001 wiring, on fixtures. | Not run: no confirmatory data exists, and the step that turns replayed signals into H-001 candidates is not built. |
| Supabase gateway, pooler, and a real service key | No. The local stack is PostgREST, not Supabase. | **Yes** (ROADMAP 1.1c). |
