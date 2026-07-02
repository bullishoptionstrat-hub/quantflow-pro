# QuantFlow Pro

**Institutional-grade options flow terminal** — replicating FlowAlgo + InsiderFinance + CheddarFlow + OptionStrat in a single self-hosted stack.

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
                                         │  Python FastAPI ML Service  │
                                         │  (Render.com — free tier)  │
                                         └─────────────────────────────┘
                                                       │
                                         ┌─────────────▼──────────────┐
                                         │  Supabase (Postgres + RLS) │
                                         └─────────────────────────────┘
```

**Data Sources:**
- Tradier (WebSocket options time & sales)
- Polygon.io (REST options trades)
- Alpaca (market data)
- Finnhub (trade ticks)
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

# ML Service
cd ml-service && pip install -r requirements.txt && cd ..
```

### 2. Environment Variables

```bash
# Frontend
cp .env.example frontend/.env.local
# Edit frontend/.env.local with your values

# Backend
cp .env.example backend/.env
# Edit backend/.env with your API keys

# ML Service
cp .env.example ml-service/.env
```

### 3. Run Supabase Schema

1. Create a project at https://supabase.com
2. Open the SQL Editor
3. Run `supabase/schema.sql`

### 4. Train ML Model (optional — heuristics work without it)

```bash
cd ml-service
python train.py
# Output: models/flow_scorer.pkl
```

### 5. Start All Services

```bash
# Terminal 1 — Backend
cd backend && npm run dev

# Terminal 2 — ML Service
cd ml-service && uvicorn main:app --reload --port 8000

# Terminal 3 — Frontend
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

### Backend + ML → Render.com

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
| Live options flow feed (Socket.IO) | ✅ |
| Virtual scroll (500 events, 50 DOM rows) | ✅ |
| Heat score (InsiderFinance-style) | ✅ |
| Sweep/Block/Split classifier | ✅ |
| Power Alerts (voice + push) | ✅ |
| GEX chart (gamma exposure) | ✅ |
| Dark pool prints (24hr delay) | ✅ |
| Multi-leg BSM calculator | ✅ |
| Strategy optimizer (6 strategies) | ✅ |
| Heat map by symbol | ✅ |
| Personal watchlist | ✅ |
| 7 filter controls | ✅ |
| CSV export | ✅ |
| TradingView modal | ✅ |
| Mobile nav (bottom tabs) | ✅ |
| Supabase auth (login/register) | ✅ |
| ML unusual score (GradientBoosting) | ✅ |
| 5 data source connectors | ✅ |

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

**ML Service:**
| Endpoint | Description |
|----------|-------------|
| `GET /health` | ML service health |
| `POST /score` | Score single flow event |
| `POST /score/batch` | Score up to 100 events |

---

## Environment Variables Reference

### Frontend (`frontend/.env.local`)

| Variable | Description |
|----------|-------------|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anonymous key |
| `NEXT_PUBLIC_WS_URL` | Backend WebSocket URL |
| `NEXT_PUBLIC_ML_URL` | ML service URL |

### Backend (`backend/.env`)

| Variable | Description |
|----------|-------------|
| `PORT` | Server port (default 3001) |
| `FRONTEND_URL` | CORS origin |
| `SUPABASE_URL` | Supabase URL |
| `SUPABASE_SERVICE_KEY` | Service role key (server only) |
| `TRADIER_TOKEN` | [Sign up free](https://developer.tradier.com/user/sign_up) |
| `POLYGON_API_KEY` | [Sign up free](https://polygon.io/dashboard/signup) |
| `ALPACA_KEY` + `ALPACA_SECRET` | [Sign up free](https://app.alpaca.markets/signup) |
| `FINNHUB_API_KEY` | [Sign up free](https://finnhub.io/register) |
| `UPSTASH_REDIS_REST_URL` | [Sign up free](https://upstash.com/) |
| `UPSTASH_REDIS_REST_TOKEN` | Upstash token |

---

## Disclaimer

QuantFlow Pro is a data visualization tool only. Not investment advice. Options trading involves substantial risk of loss and is not appropriate for all investors. Past performance does not guarantee future results.

© 2025 Quantum Edge Capital LLC
