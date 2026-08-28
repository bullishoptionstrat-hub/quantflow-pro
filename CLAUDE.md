# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Architecture

QuantFlow Pro is an options-flow terminal split into three independently deployed services plus Supabase:

```
Next.js 14 frontend (Vercel)  <-- REST + Socket.IO -->  Node/Express backend (Render)  -->  Python FastAPI ML service (Render)
                                                                    |
                                                              Supabase (Postgres + RLS)
```

- **`frontend/`** — Next.js 14 App Router, TypeScript, Zustand (`store/useStore.ts`) for client state, Socket.IO client (`lib/socket.ts`) for the live flow feed, Supabase SSR client for auth. Routes live under `app/` as one directory per feature (`flow`, `dark-pool`, `gex`, `heat-map`, `calculator`, `optimizer`, `power-alerts`, `watchlist`, `macro`, `news`, `settings`, `(auth)`). `middleware.ts` gates every non-auth, non-`/api` route behind a Supabase session, redirecting to `/login` when absent.
- **`backend/`** — Express + Socket.IO server (`src/server.ts`). `startIngestion(io)` (`src/ingestion/index.ts`) drives a pull/push pipeline from many market-data connectors (`src/ingestion/connectors/*` — Tradier, Polygon, Alpaca, Finnhub, plus 13 free-tier connectors: FlashAlpha, MarketData.app, Schwab, Tastytrade, TwelveData, FMP, CoinGecko, FRED, Reddit, NewsAPI, CBOE, Yahoo, Stooq). Every source normalizes to a `RawPrint` and funnels through `ingestPrint()` in `src/ingestion/flowEngineAdapter.ts`, which publishes the contract's NBBO, feeds the trade to the flow engine (`src/flow-engine/`), and maps finalized signals onto the wire shape. Signals are batched by `emitSignals` (100ms window) and broadcast as a **single global `flow_batch`**. REST routes under `src/routes/*` mirror the API reference below. When no live vendor keys are configured, ingestion falls back to an always-on simulation mode so the app still functions.
- **`backend/src/flow-engine/`** — the classification + scoring engine, vendored from `quantflow-modules/flow-engine` (the module is ESM; the backend is CJS, so it is copied rather than imported, with relative-import extensions stripped). It is byte-identical to the module apart from an added `resetDaily()`. **Change the engine here, and mirror it to the module** — or the module's test suite stops being a valid baseline for what ships.
- **`backend/src/enrichment/`** — the web-enrichment seam. `firecrawl/` is vendored from `quantflow-modules/firecrawl/src/services/firecrawl` (ESM module, CJS backend, so copied with relative-import extensions stripped — **change one, mirror it to the other**); `index.ts` is what the backend adds around it. Two rules live there and nowhere else: enrichment is **demand-driven, never scheduled** (its calls cost metered Firecrawl credits, so nothing fetches unless a request asks), and `AUTH` / `INSUFFICIENT_CREDITS` **latch the service off** until restart rather than retrying against a key that will not recover. Surfaced at `GET /api/sentiment/context`, `/context/status`, and `/regulatory/:slug`, and reported under `enrichment` in `/api/health`. With no `FIRECRAWL_API_KEY` it reports `disabled` and the rest of the app is unaffected.
- **`ml-service/`** — FastAPI service (`main.py`) exposing `/score` and `/score/batch` for unusual-flow scoring. Uses a trained `GradientBoostingClassifier` (`train.py` → `models/flow_scorer.pkl`) when present, otherwise falls back to a heuristic scorer — training the model is optional, not required to run the service.
- **`supabase/`** — `schema.sql` (source of truth, run manually in the Supabase SQL editor) plus `migrations/` for incremental changes. Tables are RLS-protected; `user_profiles` extends `auth.users`, and `api_keys.key_value` is a plaintext column intended to be encrypted via Supabase Vault in production (not yet wired up — treat as sensitive).
- **`quantflow-modules/`** — `flow-engine/` is the canonical home of the classification engine (sweep/block/split/multi-leg, NBBO side inference, deterministic unusualness scoring, outcome tracking) and holds the engine test suite plus the Polygon replay adapter for validating against real historical tape. It is **now integrated** into the backend via the vendored copy described above. `firecrawl/` is a web-enrichment module (FINRA doc sync, news context, research workflows) and is **now integrated** via a vendored copy at `backend/src/enrichment/firecrawl/` — same arrangement as the flow engine, and the same mirroring obligation. Check whether work belongs here vs. in `backend/src/ingestion` before duplicating logic.
- Root-level `qf-firecrawl (1).zip`, `qf-flow-engine.zip`, `quantflow.zip` are uploaded archives, not part of the working tree — the unpacked, current sources are `quantflow-modules/` and this repo itself.

## Commands

```bash
# Frontend
cd frontend && npm install
npm run dev      # http://localhost:3000
npm run build
npm run lint      # next lint — no test script defined

# Backend
cd backend && npm install
npm run dev       # ts-node-dev, auto-restart, http://localhost:3001
npm run build      # tsc -> dist/
npm start          # node dist/server.js
npm test          # tsx --test test/*.test.ts — adapter/wire-mapping tests
npm run typecheck  # tsc --noEmit

# ML service
cd ml-service && pip install -r requirements.txt
python train.py                              # optional: trains models/flow_scorer.pkl
uvicorn main:app --reload --port 8000

# flow-engine module (canonical source; backend ships a vendored copy)
cd quantflow-modules/flow-engine && npm install
npm test        # tsx --test test/engine.test.ts test/outcome.test.ts
npm run typecheck
```

Environment setup: copy `.env.example` to `frontend/.env.local`, `backend/.env`, and `ml-service/.env` respectively (see README's "Environment Variables Reference" for the full key list per service — Supabase URL/keys, Tradier/Polygon/Alpaca/Finnhub API keys, Upstash Redis). Run `supabase/schema.sql` in the Supabase SQL editor before first run (RLS-protected tables; the app expects them to exist).

Deployment: frontend → Vercel (root directory `frontend`, rewrites in `frontend/vercel.json` must point at the deployed backend URL); backend + ML → Render via the root `render.yaml` Blueprint (each service's `rootDir` is set there). Render's free tier sleeps services after 15 minutes of inactivity.

## Notes

- Tests cover the flow engine (`quantflow-modules/flow-engine`, 14 tests) and the backend seams (`backend/test`, 29 tests: the adapter, the health-error formatter, and the enrichment latch) — both `node:test` via `tsx`. `frontend/` has none. Verify frontend changes and route behaviour by running the dev servers and exercising the affected pages manually.
- **The flow event wire shape is `frontend/lib/types.ts` `FlowEvent`** — snake_case, shared by `/api/flow` and the `flow_batch` socket event. (Before the engine integration the backend emitted an unrelated camelCase shape that the frontend silently failed to read.) Change it in both places at once; `getFlowStats()` and `routes/flow.ts` filter on these field names and would return empty results, not errors, if they drift.
- Side inference is `AMBIGUOUS` whenever the NBBO is missing or stale, and that carries a -15 score penalty — it is a deliberate honesty contract, not a bug. The Polygon trades path has no quote feed, so its signals are non-directional until one is wired up. Chain-snapshot connectors (marketData, schwab, tastytrade, yahoo) synthesize prints from aggregate volume and are flagged `synthetic: true` on the wire.
- `heatScore.ts` / `sweepDetector.ts` are superseded by the flow engine. Four connectors still import them to build their own events, but those values are discarded by the adapter — do not add new callers.
- The backend's CORS and Socket.IO config both currently allow `origin: '*'` — be deliberate before tightening or relying on this for anything security-sensitive.
- Simulation/fallback mode means the app is fully functional without any live market-data API keys configured; don't assume missing keys are a bug when testing locally.
- `sourceErrors` in `/api/health` is served **unauthenticated**, so every string that reaches it is public. `src/ingestion/httpError.ts` is the one place that formats a vendor failure for it: it carries the vendor's own response body through (a hardcoded guess about *why* a source is down is how that route ended up confidently wrong) and scrubs anything credential-shaped on the way out. Use `describeHttpError` for new connector failures rather than hand-rolling a string, and keep connector keys in headers rather than query strings.
- Enrichment responses carry `context_only: true` and a `disclaimer` field. That is an honesty contract of the same kind as `synthetic` and `side: AMBIGUOUS` — Firecrawl news is a context layer and must never be presented as a trade trigger. Keep it on the payload; a comment does not reach an API client.
- The enrichment routes are registered **above** `/:symbol` in `routes/sentiment.ts`. That route matches any single path segment, so a single-segment route declared after it is captured as a ticker symbol.
- `/api/sentiment/regulatory/:slug` resolves against a server-side allowlist rather than accepting a `?url=`. A caller-supplied URL would make an authenticated endpoint into a request forwarder billed to this account — SSRF and credit drain in one. Adding a source is a code change.
