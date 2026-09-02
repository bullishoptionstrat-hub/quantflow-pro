# DATA_SOURCE_REGISTRY.md

Every data source the code touches. **$0 permanent budget** — any source requiring payment is
marked BLOCKED, never silently approximated.

**Verification status is explicit and honest.** This session cannot reach any provider (egress
proxy 403s all of them) and cannot fetch vendor doc pages (WebFetch `EGRESS_BLOCKED`), so:

- `VERIFIED-SEARCH-2026-08` — confirmed via current secondary sources cross-checked this session
- `UNVERIFIED` — taken from repo code/comments; **not confirmed**. Must be re-checked in Wave 2
  against the official page before any quota logic depends on it.

No number in this file was invented. Where I don't know, it says UNVERIFIED.

> **As of Wave 2 these declarations are ENFORCED IN CODE**, not just documented:
> `backend/src/providers/registry.ts` holds the machine-readable version and
> `backend/src/providers/quota.ts` enforces it. An `UNVERIFIED` limit is spent at only
> **50%** of its declared value (`UNVERIFIED_SAFETY_FACTOR`) — if we are not sure where the
> ceiling is, we must not walk up to our guess of it.

## Active in the ingestion path

| Source | Provides | Rate limit | Verification | Auth | Realtime? | Status |
|---|---|---|---|---|---|---|
| **Tradier** | Option chains, WS timesale/trade | UNVERIFIED | — | `TRADIER_TOKEN` bearer | Realtime WS **with brokerage account**; sandbox delayed | Configured, unverifiable here |
| **Polygon** | Option trades REST | **5 req/min free**; free tier is **end-of-day / 15-min delayed**, not realtime options trades | VERIFIED-SEARCH-2026-08 | `POLYGON_API_KEY` query param | **NO** on free | ✅ **FIXED in W2**: poll is now quota-gated and runs at 15 s (4 req/min, inside the 5 req/min budget). Still marked `is_delayed: 900s` because the free tier is not realtime |
| **Finnhub** | Equity trade WS | UNVERIFIED | — | token in WS URL | Realtime equities | ⚠️ Used to **fabricate** option flow (`index.ts:454-456`) — must stop (Wave 1/4) |
| **Yahoo** | Quotes, option chains | Unofficial/undocumented | VERIFIED-SEARCH-2026-08 that **v7 requires crumb+cookie** | None sent (User-Agent only) | Delayed ~15 min | ⚠️ **Likely BROKEN**; also re-emits daily cumulative volume as new trades. ToS: scraping restricted — no redistribution |
| **CBOE** | VIX term structure, put/call ratios | UNVERIFIED | — | None (public CDN) | **Delayed** | Endpoint path plausible; `/api/macro/vix` hardcodes `termStructure:'contango'` — must be computed |
| **Stooq** | Futures/indices/yields CSV | UNVERIFIED | — | None | **Delayed / EOD** | — |
| **FlashAlpha** | Pre-computed GEX/DEX/VEX | **5 req/day** (per code comment) | UNVERIFIED | `x-api-key` | Delayed | Real GEX source, **not wired to `/api/gex`**; budget reset is one-shot + server-local midnight |
| **MarketData.app** | Option chains (OPRA) | UNVERIFIED | — | `MARKETDATA_TOKEN` | UNVERIFIED | Unverifiable here |
| **Schwab** | Chains/flow | UNVERIFIED | — | OAuth refresh token | UNVERIFIED | Requires brokerage account |
| **Tastytrade** | Chains/quotes WS | UNVERIFIED | — | user/pass session | UNVERIFIED | Requires account; gates fetches on `Math.random()>0.9` |
| **TwelveData** | Spot quotes + WS | UNVERIFIED | — | API key | UNVERIFIED | — |
| **FMP** | Earnings, insiders, news | UNVERIFIED | — | API key | Delayed | — |
| **CoinGecko** | Crypto prices | UNVERIFIED | — | Optional demo key | Delayed | — |
| **FRED** | Macro series | UNVERIFIED | — | API key (free) | EOD/monthly | Official, stable, genuinely free |
| **Reddit** | WSB sentiment | UNVERIFIED | — | OAuth client | N/A | ToS: no redistribution of user content |
| **NewsAPI** | Headlines | UNVERIFIED (free tier historically 100 req/day, **dev-only, no production use**) | — | API key | Delayed | ⚠️ ToS restriction must be confirmed before any deploy |

## Referenced but NOT integrated

| Source | Note |
|---|---|
| **FINRA** | `README.md:31` claims "FINRA (dark pool prints)". **No FINRA code exists.** FINRA ATS data is **weekly aggregate volume**, never intraday prints |
| **Upstash Redis** | Env vars provisioned in `render.yaml`; no client code exists |
| **Alpaca / Alpha Vantage** | Keys in `.env.example`; no code |

## Explicitly BLOCKED (cost money — will not be approximated)

| Capability | Why blocked |
|---|---|
| Realtime OPRA options trades/NBBO | Licensed feed. No free tier exists |
| Historical option tick data | Paid |
| Option-level P&L for outcome grading | Requires historical option marks — paid. Wave 7 uses **underlying** returns only, stated plainly |
| True intraday dark-pool prints | Licensed (TRF/SIP). FINRA free data is weekly aggregates |
