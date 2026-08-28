# REPO_AUDIT.md — Subsystem Classification

Governed by `CLAUDE_CODE_MASTER_PROMPT.md`. **The repository is the source of truth.**
Every row below was verified by reading the file and tracing runtime behavior in this or the
immediately prior session — not inferred from filenames, comments, or prior summaries.

- Wave: 0 (Repository Truth) · Base commit: `1c4e2fc` · Branch: `claude/quantflow-forensic-audit-64z608`
- **Wave 0 re-run (v2), 2026-08-28, post-merge head `47fa8c0`.** `origin/main` advanced to `2d110b8`
  (PRs #6-#10) adding 41 files / ~6,150 insertions. Rows below the `## WAVE 0 v2` heading cover
  that newly-merged surface; rows above it predate the merge and some are now STALE — each such
  row is corrected in place under v2 rather than silently edited, so the change is visible.
- Detailed evidence for findings `#n` lives in [`docs/FORENSIC_AUDIT.md`](docs/FORENSIC_AUDIT.md).
  This file is the **classification index**; that file is the **findings table**. Not duplicated.

Legend: WORKING · PARTIAL · BROKEN · DUPLICATED · DEAD CODE · SYNTHETIC-DEMO · UNSAFE · MISSING

## Backend (`backend/`)

| Subsystem | Class | Evidence | Note |
|---|---|---|---|
| Express server + routing | WORKING | `src/server.ts:19-48`; build passes | Boots, routes mount, 404 fallback present |
| Startup env validation | WORKING | `src/config/env.ts`; 13 tests pass | Added Session 1. Prod refuses to boot on missing/blank secret |
| `DATA_MODE` provenance gate | PARTIAL | `src/config/dataMode.ts`; 18 tests pass | Backend-only. **No UI/API propagation, no `is_demo`** → Wave 1 |
| Flow event store | PARTIAL | `src/ingestion/index.ts:112-114` | In-memory ring buffer (500), lost on restart (#12) |
| Simulation generator | SYNTHETIC-DEMO | `index.ts:473-499` | Now gated + tagged (#1). Was `sources['simulation']='connected'` |
| Seed generator | SYNTHETIC-DEMO | `index.ts:575-631` | 50 invented events, gated + tagged Session 1 |
| Dark-pool generator | SYNTHETIC-DEMO | `index.ts:547-573` | 100% fabricated; served with a **false regulatory notice** (#2) |
| GEX (`getGEXLevels`) | SYNTHETIC-DEMO | `index.ts:130-141`, `633-661` | Fully invented for every symbol (#3) → Wave 5 |
| `sweepDetector.classifySweep` | PARTIAL | `sweepDetector.ts:66-71` | "SWEEP" reduces to `size>200`; callers pass fabricated exchange lists (#9) |
| `sweepDetector.classifyPrint` | DEAD CODE | `sweepDetector.ts:28-58` | Correct 2s-window grouping — **never called** → Wave 4 |
| `heatScore` | PARTIAL | `heatScore.ts:57-89` | Inputs imputed (`avgVolume: size*10`) so size/OI term is constant (#11); IV penalty branch unreachable (`iv>100` vs decimal IV) |
| `auth.ts` (`requireAuth`) | DEAD CODE | imported nowhere | **All routes anonymous** (#5) → Wave 9 |
| `rateLimiter` | PARTIAL / UNSAFE | `rateLimiter.ts:9-16` | In-memory (resets on restart); trusts `x-forwarded-for` (#15) |
| CORS / Helmet | UNSAFE | `server.ts:24-33` | `origin:'*'` + `credentials:true` (invalid combo ⇒ no restriction); CSP disabled (#14) |
| Supabase persistence | MISSING | zero `supabase.from(` in backend | Full schema exists, **never written to** (#12) |
| Redis / Upstash | MISSING | env vars provisioned, no client code | Comments claim "use Redis in production" |

## Connectors (`backend/src/ingestion/connectors/`, 13 files)

All share an implicit `start*()` / `on*(handler)` / `get*()` shape — the basis for Wave 2's
`MarketDataProvider` interface (adapter, not rewrite).

| Connector | Class | Note |
|---|---|---|
| `yahoo.ts` | **BROKEN (new finding W0-A)** | Calls `query1/v7/finance/quote` + `/v7/finance/options` with only a User-Agent. Yahoo has required **crumb + cookie** on v7 since 2023; requests without them are rejected. Also re-emits *daily cumulative* `opt.volume` as if it were a new trade every 3 min (double-counts premium), stamps `timestamp: now`, and derives C/P via `contractSymbol.includes('C')` — latently wrong for tickers containing "C" |
| `flashAlpha.ts` | PARTIAL | Real GEX source but **never wired into `/api/gex`** (#3). Daily-budget reset is a one-shot `setTimeout` at *server-local* midnight, not ET (#22) — after day 2 it never resets |
| `tastytrade.ts` | PARTIAL | Gates chain fetches on `Math.random() > 0.9` |
| `cboe.ts` | PARTIAL | Real endpoints; `/api/macro/vix` hardcodes `termStructure:'contango'` regardless of values |
| `polygon`(in `index.ts`) | PARTIAL | **Only source using a real event time** (`sip_timestamp`, `index.ts:404`) |
| `finnhub`(in `index.ts`) | SYNTHETIC-DEMO | Fabricates option trades from equity ticks at `Math.random()>0.85` (`index.ts:454-456`) — synthetic wearing a **real source name** |
| marketData, schwab, twelveData, fmp, coinGecko, fred, reddit, newsApi, stooq | UNVERIFIED | Code reads plausibly; **cannot be runtime-verified** — no keys and egress proxy 403s all providers |

## Frontend (`frontend/`)

| Subsystem | Class | Evidence | Note |
|---|---|---|---|
| Next.js 14 app, 15 routes | WORKING | prod build passes | |
| Supabase auth (login/register/middleware) | PARTIAL | `middleware.ts:41` | Matcher excludes `api/*`; backend unprotected regardless (#5) |
| `generateSeedFlow` | SYNTHETIC-DEMO | `lib/utils.ts:70-110` | Independent fake generator, hardcoded 2024 spots (NVDA 942) |
| `useFlowFeed` simulator | SYNTHETIC-DEMO | `hooks/useFlowFeed.ts:97-102` | Injects invented event every 8s when socket down |
| Dark-pool page | SYNTHETIC-DEMO | `app/dark-pool/page.tsx:10-30` | Entirely client-generated fiction |
| `blackScholes.ts` | PARTIAL | `lib/blackScholes.ts:82-93` | Pricing/greeks sound; `computeGEX` **omits the ×100 contract multiplier** (magnitude off 100×) → Wave 5 |
| `isMarketOpen` | PARTIAL | `lib/utils.ts:36-41` | IANA zone (DST-correct) but no holiday/half-day calendar |
| Settings page | UNSAFE | `app/settings/page.tsx` | Collects API keys into React state; Save persists nothing |
| WebSocket contract | **BROKEN** | backend emits `symbol/callPut/heatScore`; frontend expects `underlying/option_type/heat_score` | Field names disagree ⇒ live events render blank/NaN |
| Test infrastructure | MISSING | no vitest/jest | → added in Wave 1 |

## ML service (`ml-service/`)

| Subsystem | Class | Evidence |
|---|---|---|
| FastAPI app | WORKING | imports clean |
| `train.py` | **UNSAFE / SYNTHETIC-DEMO** | Trains on rng fiction; labels drawn first then features from disjoint per-label ranges ⇒ **AUC 1.0000 by construction** (reproduced). `size_vol_ratio` is the constant 0.2; `fill_ratio` is noise (#4) |
| Train/serve feature parity | **BROKEN** | `train.py:68` `size/(size*5)` = 0.2 constant vs `main.py:107` `size/avg_volume` variable; `fill_ratio` noise vs hardcoded 0.5 |
| `/symbols/heat` | SYNTHETIC-DEMO | `main.py:220-229` returns `random.uniform(40,95)` |
| Test infrastructure | MISSING | no pytest → Wave 8 |

## Database (`supabase/`)

| Subsystem | Class | Note |
|---|---|---|
| Schema + RLS policies | WORKING (as SQL) / MISSING (in use) | Never receives a row (#12) |
| `flow_archive.event_at` | WORKING (design) | Correctly separates event vs insert time — nothing writes it |
| Schema copies | DUPLICATED | `schema.sql` vs `supabase/schema.sql` vs migration diverge (`uuid_generate_v4` vs `gen_random_uuid`) (#18) |
| `api_keys.key_value` | UNSAFE | Plaintext; comment says "should be encrypted in production" |
| Growth vs 500 MB free cap | MISSING controls | No retention/partitioning (#13) |

## Disconnected modules (`quantflow-modules/`)

| Module | Class | Note |
|---|---|---|
| `flow-engine` | **WORKING but DEAD CODE** | 14/14 tests pass, tsc strict clean. `nbbo.ts` returns `AMBIGUOUS` when NBBO missing/stale — **already satisfies Wave 4's exit criterion**. `outcome/tracker.ts` has `UNGRADED`. **Nothing imports it** → integrate in Waves 4/7 |
| `firecrawl` | WORKING but DEAD CODE | tsc strict clean; not wired in |

## Deploy / repo hygiene

| Item | Class | Note |
|---|---|---|
| `render.yaml` ×2 | DUPLICATED | Root vs `backend/` differ (#18) |
| `vercel.json` | PARTIAL | Backend host hardcoded in 5 rewrites |
| Committed zips | **UNSAFE** | **Five** archives. `quantflow.zip` + `qf-firecrawl (1).zip` carry **real credentials** (#7 — rotation required). `Archive.zip`, `quantflow-pro-main.zip` rescanned: clean |
| Dependency CVEs | UNSAFE | frontend 18 vulns (2 critical: `next@14.2.3`, unused `next-auth`); backend 1 moderate (unused `uuid`) (#16) |

## Current build/test status — real output, `npm run verify`, exit 0

```
> quantflow-pro-backend@1.0.0 typecheck      → tsc -p tsconfig.all.json   (clean)
> quantflow-pro-backend@1.0.0 test           → # tests 31 / # pass 31 / # fail 0
> quantflow-pro-backend@1.0.0 build          → tsc                        (clean)
> flow-engine@1.0.0 typecheck + test         → # tests 14 / # pass 14 / # fail 0
> qf-firecrawl@1.0.0 typecheck               → tsc --noEmit               (clean)
> frontend typecheck + build                 → ✓ Compiled successfully (15 routes)
VERIFY_EXIT=0
```

Caveat, stated plainly: green means **types compile and the guards behave**. It does **not**
mean any market-data path is correct — most are synthetic or unverifiable here.

## Environmental blockers (verified this session)

| Blocker | Evidence |
|---|---|
| No market-data network | `curl` → `CONNECT tunnel failed, response 403` for Yahoo, CBOE, Stooq, CoinGecko, Alpha Vantage |
| No API keys | `.env.example` is all placeholders |
| Vendor docs unfetchable | WebFetch `EGRESS_BLOCKED` (alphavantage, vercel, supabase, cloudflare). WebSearch works |
| Cannot push | 403 on git **and** MCP `create_branch` — read-only App install |


---

# WAVE 0 v2 — POST-MERGE SURFACE (head `47fa8c0`, 2026-08-28)

`origin/main` (`2d110b8`) landed a competing flow-engine integration plus two keyless
connectors. That code was merged in `9219ee7` but had never been audited subsystem-by-
subsystem. Everything below was verified by reading the file in this session.

## Corrections to rows above (they were true pre-merge, and are now STALE)

| Row | Was | Now | Evidence |
|---|---|---|---|
| CORS / Helmet | UNSAFE — `origin:'*'` + `credentials:true` (#14) | **PARTIAL** — allowlist `[FRONTEND_URL, 'http://localhost:3000']` + `credentials:true`, which is a valid combination. CSP still disabled (`contentSecurityPolicy: false`). | `src/server.ts:43-44`, `:39` |
| `auth.ts` (`requireAuth`) | DEAD CODE — imported nowhere, all routes anonymous (#5) | **PARTIAL** — now gates all six data routes | `src/server.ts:50-55` |
| GEX (`getGEXLevels`) | SYNTHETIC-DEMO — fully invented | **PARTIAL** — a real chain-derived path now exists alongside the generator, which is gated to demo mode | `connectors/cboeOptions.ts`, `ingestion/index.ts` |
| `sweepDetector` / `heatScore` | PARTIAL — the live classification path | **DEAD CODE** for classification. The flow engine replaced them; four connectors still call them but the adapter discards the values. | `CLAUDE.md`; `ingestion/flowEngineAdapter.ts` |

I stated earlier in this session that CORS was still `origin:'*'`. That was accurate against
the pre-merge tree and is **no longer true** — main fixed it. Correcting it here rather than
leaving the stale claim standing.

## Newly-merged subsystems

| Subsystem | Class | Evidence | Note |
|---|---|---|---|
| `src/flow-engine/**` (vendored) | WORKING | diff vs `quantflow-modules/flow-engine/src/**` | **Vendoring claim VERIFIED.** Only differences are `.js` import-extension stripping and the documented added `resetDaily()`. The module's 14 tests therefore remain a valid baseline for what ships — which is the whole reason `CLAUDE.md` demands the copies stay in sync. |
| `ingestion/flowEngineAdapter.ts` | WORKING | 267 backend tests pass | Single production engine→wire translator. Now also carries the provenance envelope and `classification_grade` (merged in `9219ee7`). |
| `connectors/cboeOptions.ts` | WORKING | `:106-116`, `:143-159` | **The most honest connector in the repo.** GEX is `gamma × OI × 100 × spot² × 0.01` — the ×100 contract multiplier is present (this is the bug that was missing in `frontend/lib/blackScholes.ts`), spot² is derived and explained, and the sign convention is call-positive / put-negative. It explicitly refuses to route daily aggregate volume through `ingestPrint()` because attaching a day's volume to `last_trade_price` would fabricate a premium no single trade paid. |
| `connectors/cboeOptions.ts` — `asOf` | **UNSAFE** | `:197` | `asOf: d.last_trade_time ?? new Date().toISOString()`. A payload with no timestamp is stamped **now**, so stale data reads as current. This is the freshness-fabrication class that `packages/domain/src/freshness.ts` exists to prevent (its `TRADE_DATE_INFERRED` flag is precisely this case). `delayedMinutes` is a hardcoded constant, not measured. → new finding #26 |
| `connectors/occ.ts` | **UNSAFE** | `:41-50` | Same zero-sentinel defect just fixed in `cboe.ts`, replicated: `Number(x) \|\| 0` on all seven numeric fields. `\|\| 0` is worse than `?? 0` — it also collapses a legitimate 0 and NaN. Worst case is `vsMonthlyAverage: monthlyAvg > 0 ? ... : 0`, which asserts "today is 0× the trailing average" when the average is simply unknown. Note `e.fiftytwo_week_high` is snake_case while its siblings are camelCase; if that key is wrong the field silently reads 0 forever and the sentinel hides it. → new finding #27 |
| `connectors/occ.ts` — provenance | **UNSAFE** | whole file | OCC publishes **cleared** volume on a next-business-day cycle (the Tier-3 kernel models this as `OCC_CLEARING_LAG` = 09:00 ET the following day). This connector carries no `is_delayed`, no `estimated_delay_seconds` and no provenance envelope, and its output reaches `/api/health` via `getIngestionStatus()`. Next-day data presented without a delay flag. → part of finding #27 |
| `middleware/auth.ts` | PARTIAL | `:44-46`, `:60-63` | Correctly gates the six data routes and is fail-closed. But `optionalAuth` swallows its catch (`// swallow – auth is optional`) and `requireAuth` delegates to it — so a **Supabase outage is indistinguishable from an invalid token**: both yield `401 Unauthorized`. An operator cannot tell "your credentials are wrong" from "our auth provider is down". → new finding #28 |
| `frontend/lib/apiFetch.ts` + `next.config.js` rewrites | WORKING | `server.ts:40-42` | Browser traffic now goes through the frontend's `/api/*` proxy, which is server-to-server and sends no `Origin` — this is what makes the narrowed CORS allowlist workable. |
| `TIER4_FINAL_REPORT.md` (690 lines) | DOCUMENTATION — unverified | tracked at root | A prior session's report. Not treated as authoritative here; where I checked its claims against code they were mixed (its CORS claim is now true, but was not true when written). |
| Tracked archives | UNSAFE (unchanged) | `git ls-files '*.zip'` → 8 files, 1.5 MB | Grew from 5 to 8. The three new ones (`files (2).zip`, `quantflow-pro-main (2).zip`, `quantflowtier3.zip`) were scanned this session and contain **only placeholder credentials**. The original exposure in `quantflow.zip` and `qf-firecrawl (1).zip` is unchanged and **still requires rotation** (#7). |
| `packages/domain/**` | WORKING | 45 tests pass | Vendored from `quantflowtier3.zip` this session. Supplies point-in-time (`availableAt` vs `effectiveAt`), freshness contracts, `DataResult<T>`, DST-aware market calendar — all previously absent (verified: 0 repo-wide matches for `availableAt`/`LookaheadError`/`Cadence` before vendoring). One ordering bug found and fixed (#25). |

## Current build/test status — real output, 2026-08-28, head `47fa8c0`

```
npm --prefix backend run typecheck   → tsc -p tsconfig.all.json   (clean, exit 0)
npm --prefix backend test            → # tests 267  # pass 267  # fail 0
npm --prefix quantflow-modules/flow-engine test → # tests 14   # pass 14   # fail 0
npm --prefix packages/domain test    → # tests 45   # pass 45   # fail 0
npm --prefix frontend test           → Test Files 3 passed (3)   Tests 29 passed (29)
```

**355 tests, 0 failures.** Pre-merge this branch stood at 243 backend + 14 + 29 = 286.

## Wave 0 v2 exit criteria

- [x] Every newly-merged subsystem classified with evidence from reading the file.
- [x] Stale pre-merge rows corrected in place rather than silently overwritten.
- [x] Load-bearing `CLAUDE.md` vendoring claim independently verified by diff.
- [x] Real build/test output recorded.
- [x] Three new defects found (#26, #27, #28) and recorded in `docs/FORENSIC_AUDIT.md`.

**Not proceeding past Wave 0**, per the master prompt's START HERE instruction.
