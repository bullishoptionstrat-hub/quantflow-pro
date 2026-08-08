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
- **`backend/`** — Express + Socket.IO server (`src/server.ts`). `startIngestion(io)` (`src/ingestion/index.ts`) drives a pull/push pipeline from many market-data connectors (`src/ingestion/connectors/*` — Tradier, Polygon, Alpaca, Finnhub, plus 13 free-tier connectors: FlashAlpha, MarketData.app, Schwab, Tastytrade, TwelveData, FMP, CoinGecko, FRED, Reddit, NewsAPI, CBOE, Yahoo, Stooq), scores each event with `heatScore.ts` and classifies it (sweep/block/split) with `sweepDetector.ts`, then batches and broadcasts over Socket.IO (`queueBroadcast` in `server.ts`, 100ms batch window, both a global `flow_batch` and a per-symbol room emit). REST routes under `src/routes/*` mirror the API reference below. When no live vendor keys are configured, ingestion falls back to an always-on simulation mode so the app still functions.
- **`ml-service/`** — FastAPI service (`main.py`) exposing `/score` and `/score/batch` for unusual-flow scoring. Uses a trained `GradientBoostingClassifier` (`train.py` → `models/flow_scorer.pkl`) when present, otherwise falls back to a heuristic scorer — training the model is optional, not required to run the service.
- **`supabase/`** — `schema.sql` (source of truth, run manually in the Supabase SQL editor) plus `migrations/` for incremental changes. Tables are RLS-protected; `user_profiles` extends `auth.users`, and `api_keys.key_value` is a plaintext column intended to be encrypted via Supabase Vault in production (not yet wired up — treat as sensitive).
- **`quantflow-modules/`** — standalone, **not yet integrated** into `backend/`. `flow-engine/` is a from-scratch options-flow classification engine (sweep/block/split/multi-leg, NBBO side inference, deterministic unusualness scoring, outcome tracking) meant to eventually replace/upgrade `backend/src/ingestion/{heatScore,sweepDetector}.ts`; it has its own test suite and a Polygon replay adapter for validating against real historical tape. `firecrawl/` is a web-enrichment module (FINRA doc sync, news context, research workflows). Check whether work belongs here vs. in `backend/src/ingestion` before duplicating logic.
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
npm start          # node dist/server.js — no test/lint script defined

# ML service
cd ml-service && pip install -r requirements.txt
python train.py                              # optional: trains models/flow_scorer.pkl
uvicorn main:app --reload --port 8000

# flow-engine module (standalone, not wired into backend yet)
cd quantflow-modules/flow-engine && npm install
npm test        # tsx --test test/engine.test.ts test/outcome.test.ts
npm run typecheck
```

Environment setup: copy `.env.example` to `frontend/.env.local`, `backend/.env`, and `ml-service/.env` respectively (see README's "Environment Variables Reference" for the full key list per service — Supabase URL/keys, Tradier/Polygon/Alpaca/Finnhub API keys, Upstash Redis). Run `supabase/schema.sql` in the Supabase SQL editor before first run (RLS-protected tables; the app expects them to exist).

Deployment: frontend → Vercel (root directory `frontend`, rewrites in `frontend/vercel.json` must point at the deployed backend URL); backend + ML → Render via the root `render.yaml` Blueprint (each service's `rootDir` is set there). Render's free tier sleeps services after 15 minutes of inactivity.

## Notes

- There is no automated test suite for `backend/` or `frontend/` — only `quantflow-modules/flow-engine` has tests (`node:test`, run via `tsx`). Verify backend/frontend changes by running the dev servers and exercising the affected routes/pages manually.
- The backend's CORS and Socket.IO config both currently allow `origin: '*'` — be deliberate before tightening or relying on this for anything security-sensitive.
- Simulation/fallback mode means the app is fully functional without any live market-data API keys configured; don't assume missing keys are a bug when testing locally.
