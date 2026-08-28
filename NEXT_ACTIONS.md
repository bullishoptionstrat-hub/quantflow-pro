# NEXT_ACTIONS.md

Concrete next steps so a new session resumes without re-deriving context.
Read `PROJECT_STATE.md` first, then this.

**State:** Wave 0 v2 (post-merge audit) complete at head `47fa8c0`. 355 tests, 0 failures.
Stopped at Wave 0 per the master prompt's START HERE instruction.

## 1. Fix finding #29 — the WebSocket bypasses route auth (HIGH, do this first)

The six REST routes are behind `requireAuth`; Socket.IO has **no auth handshake at all** and
`cors: { origin: '*', credentials: true }`, while broadcasting the same payloads
(`flow_batch`, `macro_update`, `sentiment_update`, `news_update`, `cboe_update`,
`spot_update`). Route auth currently provides the appearance of protection without the
substance — the cheapest path to the data is the unguarded one.

- Add `io.use()` verifying the Supabase JWT from `socket.handshake.auth.token`, rejecting
  the connection when absent/invalid.
- Narrow the socket CORS to the same allowlist the HTTP layer uses (`server.ts:43`).
- Frontend `lib/socket.ts` must then pass the session token when connecting.
- Regression test: an unauthenticated socket connection receives no `flow_batch`.

## 2. Fix finding #27 — `occ.ts` zero-sentinel + undeclared next-day delay (HIGH)

Highest severity of the three new findings, and the pattern is already solved: apply the
same treatment `cboe.ts` received in `b547428`.

- `Number(x) || 0` -> `number | null` via the strict `num()` helper (export it from a shared
  module rather than copying it a third time).
- `vsMonthlyAverage` must be `null` when `monthlyDailyAverage` is unknown, not `0`.
- Verify the `fiftytwo_week_high` key against a real payload — it is snake_case among
  camelCase siblings and the sentinel would hide a permanent 0.
- Attach `upstreamProvenance({ source:'occ', is_delayed:true, estimated_delay_seconds:... })`.
  `packages/domain/src/pointInTime.ts` already models this as `OCC_CLEARING_LAG` (09:00 ET
  next business day) — use it rather than inventing a number.

## 3. Fix finding #26 — CBOE chain `asOf` falls back to `now()` (MEDIUM)

`cboeOptions.ts:197`. Leave `asOf` null when the source carries no timestamp and flag
`TRADE_DATE_INFERRED`; derive `delayedMinutes` from `asOf` instead of asserting a constant.
`packages/domain/src/freshness.ts` `validatePayload()` already implements the verdict logic.

## 4. Fix finding #28 — auth conflates outage with bad credentials (MEDIUM)

`middleware/auth.ts`. Log the swallowed cause with source; have `requireAuth` distinguish
"token rejected" (401) from "could not verify" (503).

## 5. Wire `@quantflow/domain` into the backend build

The package is vendored, typechecked and tested (45 tests) but nothing in `backend/` imports
it, so `DataResult<T>`, `asOf()` and the freshness contracts are not yet load-bearing. This
was deliberately deferred: it adds cross-package build ordering that affects the Render
deploy, which cannot be tested from this environment. Do it on a machine that can run the
Render build, and it makes actions 1-3 substantially cleaner.

## 6. Standing human actions (no code change resolves these)

- **Rotate the credentials** in `quantflow.zip` and `qf-firecrawl (1).zip` (finding #7).
  They are in git history; deleting the files does not undo the exposure.
- Supply a Tradier token + egress allowance for `api.tradier.com` / `ws.tradier.com` if the
  live-data-dependent gates (W5 real chains, W7 scheduler, W8 training) are to be closed.

## Do NOT re-run Waves 1-10 from scratch

They were executed against the pre-merge tree and their work is in the branch. Where the
merge invalidated a conclusion, `REPO_AUDIT.md` -> "Corrections to rows above" says so
explicitly. Re-running blind would duplicate work and risk reverting main's improvements.
