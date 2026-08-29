# NEXT_ACTIONS.md

Concrete next steps so a new session resumes without re-deriving context.
Read `PROJECT_STATE.md` first, then this.

**State:** findings #26-#29 from the Wave 0 v2 audit are all FIXED with
regression coverage. 385 tests, 0 failures. Head is pushed on
`claude/quantflow-forensic-audit-64z608`; PR #5 open (draft).

## 1. Wire `@quantflow/domain` into the backend build

The highest-value remaining structural step, and it is now clearly motivated:
three separate fixes (#23, #26, #27) each hand-rolled a piece of what the
vendored kernel already implements properly.

- `DataResult<T>` (result.ts) replaces the ad-hoc `number | null` + `fetchStatus`
  pattern now duplicated across `cboe.ts` and `occ.ts`.
- `validatePayload()` / `FreshnessContract` (freshness.ts) replaces the
  hand-rolled `ageMinutesFrom` + `tradeDateInferred` in `cboeOptions.ts`, and
  brings the STALE/PARTIAL/DEGRADED taxonomy with it.
- `asOf()` (pointInTime.ts) is needed before any backtest is trustworthy, and
  nothing in `backend/` can reach it today.

Deferred so far because it adds cross-package build ordering that affects the
Render deploy, which cannot be exercised from this environment. Do it where the
Render build can actually be run.

## 2. Measure OCC's delay instead of declaring a floor

`KNOWN_LIMITATIONS.md` records this. `estimated_delay_seconds: 86400` is a
conservative floor; over a weekend the true lag is ~72h. Confirm against a real
payload whether the OCC endpoint returns an activity date, and derive from it.
Needs egress to `marketdata.theocc.com`.

## 3. Audit the remaining connectors for the same two defect classes

`cboe.ts`, `occ.ts` and `cboeOptions.ts` each turned out to carry a zero
sentinel; two of the three also mis-stated freshness. That is 3 for 3 on the
files examined closely, so treat the other ~13 connectors as unaudited rather
than clean. Grep starting points:

    grep -rn '|| 0\|?? 0' backend/src/ingestion/connectors/
    grep -rn 'new Date().toISOString()' backend/src/ingestion/connectors/

## 4. Standing human actions (no code change resolves these)

- **Rotate the credentials** in `quantflow.zip` and `qf-firecrawl (1).zip`
  (finding #7). They are in git history; deleting the files does not undo it.
- Supply a Tradier token + egress allowance for `api.tradier.com` /
  `ws.tradier.com` to close the live-data gates (W5 real chains, W7 scheduler,
  W8 training).

## Do NOT re-run Waves 1-10 from scratch

They were executed against the pre-merge tree and their work is in the branch.
Where the merge invalidated a conclusion, `REPO_AUDIT.md` -> "Corrections to
rows above" says so explicitly.
