# Poller audit matrix (2026-10-28)

Read from the code at `898a21c`; nothing here was run against a live vendor.

**Overlap** describes the poller as it stands now: `no — singleFlight` means it runs through `ingestion/singleFlight.ts`, which skips a tick while a cycle is running and catches a rejected cycle. Skipped ticks are not queued or coalesced; they are counted on `/api/health` under `ingestion.pollers`. Every timer listed here is `.unref()`ed. `pollerSingleFlight.test.ts` scans every file in `src/` for an async poller started without the wrapper.

| Poller | File | Interval | Overlap | Notes |
|---|---|---|---|---|
| Schwab chain | connectors/schwab.ts | 60 s | no — singleFlight | Worst case is 7 × (8 s timeout + 1.5 s pause) = 66.5 s. That exceeds the interval, so ticks are skipped and counted. |
| Schwab token | connectors/schwab.ts | 28 min | no — singleFlight | |
| Cboe chain | index.ts `startCboeOptions` | 20 s | no — singleFlight | A 20 s request plus the parse of a payload up to ~13 MB exceeds the interval, so ticks are skipped. |
| OCC volume | index.ts `startOcc` | 5 min | no — singleFlight | |
| Tastytrade poll / login | connectors/tastytrade.ts | 5 min / 23 h | no — singleFlight | |
| MarketData | connectors/marketData.ts | 15 min | no — singleFlight | Daily credit budget, reset by `scheduleDailyReset`. |
| Twelve Data REST | connectors/twelveData.ts | `REST_TICK_MS` | no — singleFlight | Cadence is derived from the credit budget. |
| FMP ×3, Finnhub, CoinGecko ×2, Cboe, Yahoo, Reddit, NewsAPI, Stooq, FRED, Event Registry | connectors/* | 30 s – 6 h | no — singleFlight | Yahoo never starts: it is refused by the rights gate. |
| Tradier universe refresh | index.ts | `TRADIER_UNIVERSE_REFRESH_MS` | no — singleFlight | **Fixed here:** a build that finished after its socket closed could overwrite the new connection's universe and send the dead session's id on the new socket. The captured socket is now compared before anything is written. |
| Tradier reconnect | index.ts | 5 s after `close`; backoff on connect failure | one socket at a time | A new socket is opened only from `close`, which fires once per socket, so reconnects do not stack. Liveness: `wsLiveness.ts`. |
| Entitlement sweep | index.ts | 1 h | not guarded | Overlap would need probes taking longer than 1 h; each probe has a 10 s timeout. A late result would only rewrite a diagnostic. Left as is. |
| Grader tick + coverage | index.ts `startSignalHistory` | 60 s | grader has its own in-flight guard | Skips are counted in `ticksSkippedInFlight`. The coverage tick is synchronous. |
| Engine idle drain, daily reset, dark-pool sim | index.ts | 1 s / 60 s / 5 min | synchronous | Cannot overlap. |
| Simulation feed | index.ts | sim interval | synchronous | |
| Rate-limiter sweep | middleware/rateLimiter.ts | — | synchronous | |

## Remaining gaps

- **Shutdown:** there is no shutdown path. Timers are `.unref()`ed and the process exits with them, so nothing is cancelled cleanly. Writes still in flight at exit are covered by the grader's reconcile-before-retry rule.
- **Live behaviour:** no skip has been observed against a live vendor. The overlap figures above come from timeouts and intervals in the code.

## Shutdown (2026-10-28)

Render sends SIGTERM and then SIGKILL after the service's shutdown delay,
default 30s and configurable up to 300s (https://render.com/docs/deploys).
The 10s drain fits inside the default. What Render sends when a free
instance spins down was not found in its documentation and is unverified.

Once shutdown starts:

- no `singleFlight` poller starts a cycle; a running cycle is left to finish;
- the Tradier, Twelve Data and Tastytrade sockets do not schedule a reconnect
  when they close;
- open vendor sockets and timers are not closed explicitly. Every timer is
  `.unref()`ed and the process exits once the drain ends, which closes them.

`shutdownStopsWork.test.ts` covers the first two.
