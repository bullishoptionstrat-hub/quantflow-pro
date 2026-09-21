# QuantFlow Pro

**A self-hosted options-flow terminal and point-in-time research system.**

What it is today, stated against evidence rather than ambition: the terminal,
the classification engine, the rights registry and the durable signal history
are real and tested. **No entitled real options-event source is configured on
this deployment**, so the flow feed carries simulated prints — marked per row —
and no real graded outcome exists yet. See
[`docs/CLAIMS_LEDGER.md`](docs/CLAIMS_LEDGER.md) for every capability claim and
its evidence, and [`docs/FORENSIC_AUDIT.md`](docs/FORENSIC_AUDIT.md) for what is
known to be broken.

Built by Quantum Edge Capital LLC.

---

## Architecture

```
┌─────────────────────────┐    WebSocket    ┌──────────────────────────┐
│   Next.js 14 Frontend   │◄───────────────►│  Node.js Express Backend │
│   (Vercel — free tier)  │    REST API     │  (Render.com — free tier) │
└─────────────────────────┘                 └──────────┬───────────────┘
                                                       │
                                         ┌─────────────▼──────────────┐
                                         │  Supabase (Postgres + RLS) │
                                         └─────────────────────────────┘
```

**Data Sources:**
- Tradier (WebSocket options time & sales)
- Polygon.io (REST options trades)
- Simulation fallback (always-on demo mode)

---

## Quick Start

### Prerequisites
- Node.js 18+
- Python 3.11+
- npm 9+

### 1. Clone & Install

```bash
git clone https://github.com/bullishoptionstrat-hub/quantflow-pro.git
cd quantflow-pro

# Frontend
cd frontend && npm install && cd ..

# Backend
cd backend && npm install && cd ..

```

### 2. Environment Variables

```bash
# Frontend
cp .env.example frontend/.env.local
# Edit frontend/.env.local with your values

# Backend
cp .env.example backend/.env
# Edit backend/.env with your API keys

```

### 3. Run Supabase Schema

1. Create a project at https://supabase.com
2. Open the SQL Editor
3. Run `supabase/schema.sql` — the seven application tables
4. Run every file in `supabase/migrations/` **in filename order**

Step 4 is not optional. `schema.sql` creates none of the four tables the
recorder and grader write to (`signal_history`, `signal_outcomes`,
`signal_write_incidents`, `collection_gaps`); those live in
`migrations/20260829120000_signal_history.sql`. Skipping it gives a database
where every signal write fails and `/api/track-record` stays empty forever,
with nothing on screen saying why. `backend/test/schemaSetup.test.ts` holds
this instruction to the tables the code actually addresses.

`supabase/gate-proofs.sql` is optional and re-runnable: it proves the
signal-history constraints refuse what they claim to. Every `ERROR:` in its
output is a pass.

### 4. Start All Services

```bash
# Terminal 1 — Backend
cd backend && npm run dev

# Terminal 2 — Frontend
cd frontend && npm run dev
```

Open http://localhost:3000

---

## Production Deployment (Free Tier)

### Frontend → Vercel

1. Push to GitHub
2. Import repo at https://vercel.com/new
3. Set the project **Root Directory** to `frontend`
4. Set env vars from `.env.example`
5. Update `frontend/vercel.json` rewrites with your Render backend URL
6. Deploy

### Backend → Render.com

1. Push to GitHub
2. Create a **Blueprint** deployment from the repository root
3. Select the root `render.yaml`
4. Add all env vars from `.env.example` in Render dashboard
5. Deploy

**Render free tier:** Services sleep after 15 min inactivity. Use Uptime Robot for keep-alive pings.

---

## Features

| Feature | Status |
|---------|--------|
| Live flow feed (Socket.IO) | ⚠️ simulated prints unless an entitled options-event source is configured |
| Virtual scroll (500 events, 50 DOM rows) | ✅ |
| Heat score (InsiderFinance-style) | ✅ |
| Sweep/Block/Split classifier | ✅ |
| Heuristic heat score with per-component breakdown | ✅ |
| Power Alerts (voice + push) | ✅ |
| GEX chart (gamma exposure) | ✅ |
| Dark pool panel | ⚠️ renders the vendor's own delay notice; prints simulated absent a licensed feed |
| Multi-leg BSM calculator | ✅ |
| Strategy optimizer (6 strategies) | ✅ |
| Heat map by symbol | ✅ |
| Personal watchlist | ✅ |
| 7 filter controls | ✅ |
| CSV export | ✅ |
| TradingView modal | ✅ |
| Mobile nav (bottom tabs) | ✅ |
| Supabase auth (login/register) | ✅ |
| Rights-gated ingestion (refuses prohibited sources) | ✅ |
| Durable signal history + restart-safe grading | ✅ |
| 17 data source connectors | ⚠️ 2 connected on a keyless boot |

---

## API Reference

| Endpoint | Description |
|----------|-------------|
| `GET /api/health` | Server health + ingestion status |
| `GET /api/flow` | Paginated flow events (filters: symbol, type, sentiment, minPremium, minHeat) |
| `GET /api/flow/stats` | Aggregate statistics |
| `GET /api/flow/symbols` | Available symbols |
| `GET /api/darkpool` | Dark pool prints (24hr delay) |
| `GET /api/darkpool/summary` | By-symbol dark pool summary |
| `GET /api/gex?symbol=SPX` | GEX levels + gamma flip |
| `GET /api/chain?symbol=SPY&expiration=2025-01-17` | Options chain |
| `GET /api/chain/expirations?symbol=SPY` | Available expirations |

---

## Environment Variables Reference

### Frontend (`frontend/.env.local`)

| Variable | Description |
|----------|-------------|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anonymous key |
| `NEXT_PUBLIC_WS_URL` | Backend WebSocket URL |

### Backend (`backend/.env`)

| Variable | Description |
|----------|-------------|
| `PORT` | Server port (default 3001) |
| `FRONTEND_URL` | CORS origin |
| `SUPABASE_URL` | Supabase URL |
| `SUPABASE_SERVICE_KEY` | Service role key (server only) |
| `TRADIER_TOKEN` | [Sign up free](https://developer.tradier.com/user/sign_up) |
| `POLYGON_API_KEY` | [Sign up free](https://polygon.io/dashboard/signup) |
| `FINNHUB_API_KEY` | [Sign up free](https://finnhub.io/register) — spot quotes for the display board only; not used for grading, see `FINNHUB_QUOTES` in the rights registry |

---

## Disclaimer

QuantFlow Pro is a data visualization tool only. Not investment advice. Options trading involves substantial risk of loss and is not appropriate for all investors. Past performance does not guarantee future results.

© 2025 Quantum Edge Capital LLC
