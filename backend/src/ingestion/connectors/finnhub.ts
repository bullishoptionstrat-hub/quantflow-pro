/**
 * Finnhub — spot quotes, for display only.
 *
 * A second underlying-price source, so the tape, the watchlist and the
 * strategy builder are not dark whenever Twelve Data is keyless, rate-limited
 * or missing a symbol.
 *
 * **It is deliberately not the grader's mark source.** Finnhub's terms say:
 *
 *   "You hereby agree to not redistribute or share access to data or derived
 *    results from the data obtained from Finnhub with anyone or any 3rd party
 *    without written approval from Finnhub."
 *
 * `/api/track-record` publishes derived results to anyone who can reach it, so
 * grading against a Finnhub mark would route around a quoted restriction —
 * the same reason Yahoo is not consulted as a spot fallback. `FINNHUB_QUOTES`
 * is `PROHIBITED` for `PERSIST` in both business modes to make that refusal
 * enforced rather than remembered, and `getSpotPrice` stays Twelve Data only.
 *
 * A previous connector of the same name existed and was deleted: it streamed
 * equity trades and handed each price to `simulatePrints`, putting
 * manufactured *option* prints on the tape of a credentialed deployment. This
 * one publishes what Finnhub actually sends, and nothing else.
 *
 * Free tier is 60 calls/minute. Ten symbols on a 60s cycle is ten.
 */
import axios from 'axios';
import { quoteTimestamp, type SpotQuote } from './twelveData';
import { describeHttpError } from '../httpError';

const API_KEY = process.env.FINNHUB_API_KEY || '';
const BASE = 'https://finnhub.io/api/v1';
const WATCHED = ['SPY', 'QQQ', 'NVDA', 'AAPL', 'TSLA', 'MSFT', 'AMD', 'META', 'AMZN', 'MSTR'];
const POLL_MS = 60_000;

/** Health of the last fetch cycle, reported to /api/health each cycle. */
export interface FinnhubHealth {
  ok: boolean;
  /** Operator-facing, and public: this reaches the unauthenticated /api/health. */
  reason?: string;
}

const spotCache = new Map<string, SpotQuote>();
let onSpot: ((q: SpotQuote) => void) | null = null;
let onHealth: ((h: FinnhubHealth) => void) | null = null;

export function onFinnhubSpot(handler: (q: SpotQuote) => void): void { onSpot = handler; }
export function onFinnhubHealth(handler: (h: FinnhubHealth) => void): void { onHealth = handler; }

/** Finnhub's own board. Merging with Twelve Data's is the caller's job. */
export function getFinnhubSpotQuotes(): Map<string, SpotQuote> { return spotCache; }

/** A number the vendor actually sent, or null. Never a zero standing in. */
function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

async function fetchQuote(symbol: string): Promise<boolean> {
  const { data } = await axios.get(`${BASE}/quote`, {
    params: { symbol },
    // In a header, not the query string: `/api/health` publishes vendor error
    // bodies and a URL in one is a credential in one.
    headers: { 'X-Finnhub-Token': API_KEY },
    timeout: 8000,
  });

  // `/quote` answers 200 with every field zero for a symbol it does not cover.
  // A price of zero is not a price, and caching it would put $0.00 on the tape
  // in live styling — the Stooq failure with a different vendor.
  const price = num(data?.c);
  if (price === null || price <= 0) return false;

  const quote: SpotQuote = {
    symbol,
    price,
    change: num(data?.d) ?? 0,
    changePct: num(data?.dp) ?? 0,
    // `/quote` carries no volume. Null says that; zero would claim none traded.
    volume: null,
    // `t` is unix **seconds**. `quoteTimestamp` normalizes it, and is the one
    // place that decision lives — writing `data.t` straight through is what
    // dated half the tape's board to 1970 the last time a second write path
    // was added to a spot cache.
    timestamp: quoteTimestamp(data?.t),
    source: 'finnhub',
  };

  spotCache.set(symbol, quote);
  onSpot?.(quote);
  return true;
}

async function fetchAll(): Promise<void> {
  let priced = 0;
  let lastError: string | undefined;

  for (const symbol of WATCHED) {
    try {
      if (await fetchQuote(symbol)) priced++;
    } catch (err) {
      lastError = describeHttpError(err);
    }
  }

  if (priced > 0) {
    onHealth?.({ ok: true });
  } else {
    onHealth?.({
      ok: false,
      reason: lastError ?? 'Finnhub returned no priced symbols.',
    });
  }
}

export async function startFinnhub(): Promise<void> {
  // No key is a configuration answer, not a failure. `startConnector` reads
  // `CONNECTOR_CREDENTIALS` and reports `disabled` naming the variable, so
  // returning quietly here is the contract, not a swallowed error.
  if (!API_KEY) return;

  await fetchAll();
  // `.unref()` so a poller never holds the event loop open — see the guard in
  // `missingIsNotZero.test.ts`.
  setInterval(fetchAll, POLL_MS).unref();
  console.log(`[finnhub] Started — spot quotes for ${WATCHED.length} symbols every 60s`);
}
