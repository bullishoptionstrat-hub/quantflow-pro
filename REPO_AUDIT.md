# REPO_AUDIT.md — Subsystem Classification

Governed by `CLAUDE_CODE_MASTER_PROMPT.md`. **The repository is the source of truth.**
Every row below was verified by reading the file and tracing runtime behavior in this or the
immediately prior session — not inferred from filenames, comments, or prior summaries.

- Wave: 0 (Repository Truth) · Base commit: `1c4e2fc` · Branch: `claude/quantflow-forensic-audit-64z608`
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
