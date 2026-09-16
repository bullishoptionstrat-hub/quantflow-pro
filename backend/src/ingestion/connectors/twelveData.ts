/**
 * Twelve Data — Real-time stock quotes, technicals, earnings
 * Free: 800 API credits/day, WebSocket streaming included
 * Docs: https://twelvedata.com/docs
 */
import axios from 'axios';
import WebSocket from 'ws';
import { numeric } from '../optionalNumber';
import { describeHttpError } from '../httpError';

const API_KEY = process.env.TWELVE_DATA_API_KEY || '';
const BASE = 'https://api.twelvedata.com';
const WS_URL = 'wss://ws.twelvedata.com/v1/quotes/price';
const WATCHED = ['SPY', 'QQQ', 'NVDA', 'AAPL', 'TSLA', 'MSFT', 'AMD', 'META', 'AMZN', 'MSTR'];

/**
 * The canonical spot-quote shape, shared by every source that fills the board.
 *
 * It lives here because Twelve Data was the first and remains the reference
 * implementation — `wireContract.test.ts` checks the frontend's copy against
 * this declaration, and `deadSources.test.ts` checks `quoteTimestamp` against
 * this file's write paths. A second source imports both rather than restating
 * either.
 *
 * `volume` is nullable because Finnhub's `/quote` does not carry one: it
 * returns current, change, percent change, high, low, open and previous close,
 * and nothing else. A zero there would be the `?? 0` defect all over again —
 * "no volume traded" is a different claim from "this source does not report
 * volume".
 *
 * That paragraph was written here and then contradicted eight lines down: both
 * of this file's write paths built the field as `parseInt(q.volume ?? 0)`, so
 * the null it argues for was never once published. `change` and `changePct`
 * were worse, because the *type* forbade the honest answer — they were
 * `number`, so both connectors had no way to say "not sent" and both wrote a
 * zero. Finnhub sends `d`/`dp` as null for any symbol without a previous close
 * (a fresh listing, a halted name), and the tape rendered that as an
 * authoritative `+0.00%`.
 *
 * `price` stays non-nullable, and that is the distinction: a quote with no
 * price is not a quote, so both connectors refuse the row instead of
 * publishing a null. An unknown *change* still leaves a usable price.
 */
export interface SpotQuote {
  symbol: string;
  price: number;
  /** `null` where the vendor did not send one. Never a zero standing in. */
  change: number | null;
  changePct: number | null;
  volume: number | null;
  timestamp: number;
  source: 'twelvedata' | 'finnhub';
}

/**
 * One clock for `SpotQuote.timestamp`.
 *
 * The two paths that write this cache disagreed about the unit. TwelveData's
 * WebSocket stamps its price events in unix **seconds**; `fetchQuotesBatch`
 * stamps `Date.now()`, in **milliseconds**. Both went into the same field, so
 * the cache held quotes measured on two scales and the first consumer to
 * compare one against `Date.now()` would read every streamed quote as 1970 —
 * i.e. as permanently stale. Nothing read the field until the ticker tape did,
 * which is why it survived.
 *
 * Anything below 1e12 is seconds (1e12 ms is 2001, and no equity quote we
 * accept predates that); anything at or above it is already milliseconds. A
 * missing or unparseable stamp falls back to receipt time rather than to zero,
 * because a quote we just received is not a quote from the epoch.
 *
 * The REST path now publishes the vendor's own stamp where it sends one,
 * instead of overwriting it with receipt time — the same rule as
 * `RawPrint.quoteTs`. Stamping a quote from the last session as if it arrived
 * now manufactures exactly the freshness a staleness check exists to judge,
 * and off-hours is when that misreads worst.
 */
export function quoteTimestamp(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return Date.now();
  return n < 1e12 ? Math.round(n * 1000) : Math.round(n);
}

/**
 * Health of the last REST cycle, reported to /api/health.
 *
 * `degraded` exists because this connector has two paths and they fail
 * independently. The WebSocket carries the board during a session; the REST
 * batch is a fallback. A dead fallback while the stream delivers is a real
 * fact about the deployment and not an outage, and collapsing the two into
 * one boolean forces a choice between overstating and hiding it.
 *
 * Same shape as `FREDHealth` for the same reason — see the wiring in
 * `startIngestion`, which routes `degraded` to the note channel.
 */
export interface TwelveDataHealth {
  ok: boolean;
  /** `ok` and `degraded` together: contributing, but not by every path. */
  degraded?: boolean;
  /** Operator-facing, and public: this reaches the unauthenticated /api/health. */
  reason?: string;
}

const spotCache = new Map<string, SpotQuote>();
let onSpotUpdate: ((q: SpotQuote) => void) | null = null;
let onHealth: ((h: TwelveDataHealth) => void) | null = null;
let wsCreditsUsed = 0;

/**
 * Receipt time of the last cache write, by either path.
 *
 * Deliberately not `SpotQuote.timestamp`: that is the *vendor's* stamp, which
 * off-hours is the last session's close and would read as stale on a perfectly
 * healthy stream. The question this answers is narrower and is about us — did
 * anything at all deliver recently — so it is measured on our clock.
 */
let lastCacheWriteAt = 0;

export function onTwelveDataSpot(handler: (q: SpotQuote) => void): void {
  onSpotUpdate = handler;
}

export function onTwelveDataHealth(handler: (h: TwelveDataHealth) => void): void {
  onHealth = handler;
}

/**
 * How long after the last delivered quote the stream is still credited with
 * carrying the board. Two REST cycles: one missed poll is a blip, two with
 * nothing from the socket either means nothing is arriving.
 */
export const STREAM_GRACE_MS = 120_000;

/** Exported for tests; the running process only ever reads it through health. */
export function lastDeliveryAt(): number { return lastCacheWriteAt; }

export function getSpotQuotes(): Map<string, SpotQuote> {
  return spotCache;
}

/**
 * The mark for a symbol, or null when this board has never quoted it.
 *
 * Returned `0` for an unknown symbol, which its one caller defended against
 * with `px > 0 ? px : undefined`. The sentinel is removed rather than the
 * guard kept: a zero mark reaching the grader would score every outcome
 * against a price of nothing, and the next caller does not inherit the guard.
 */
export function getSpotPrice(symbol: string): number | null {
  return spotCache.get(symbol)?.price ?? null;
}

function startWebSocket(): void {
  const ws = new WebSocket(`${WS_URL}?apikey=${API_KEY}`);

  ws.on('open', () => {
    ws.send(JSON.stringify({ action: 'subscribe', params: { symbols: WATCHED.join(',') } }));
    console.log('[twelvedata] WebSocket connected');
  });

  ws.on('message', (raw: Buffer) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.event === 'price' && msg.symbol) {
        // Twelve Data sends its numbers as strings, so `numeric` rather than
        // `num`. A row with no usable price is dropped, not published at zero.
        const price = numeric(msg.price);
        if (price === null || price <= 0) return;
        const quote: SpotQuote = {
          symbol: msg.symbol,
          price,
          change: numeric(msg.day_change),
          changePct: numeric(msg.day_change_percent),
          volume: numeric(msg.volume),
          timestamp: quoteTimestamp(msg.timestamp),
          source: 'twelvedata',
        };
        spotCache.set(msg.symbol, quote);
        lastCacheWriteAt = Date.now();
        onSpotUpdate?.(quote);
        wsCreditsUsed++;
      }
    } catch {}
  });

  ws.on('error', () => {});
  ws.on('close', () => { setTimeout(startWebSocket, 5000).unref(); });
}

/**
 * Why a failing cycle is *reported* and not just logged.
 *
 * `startConnector` records what `start()` returned once and never looks again,
 * and `fetchQuotesBatch` swallowed every failure in its own try/catch — so
 * `startTwelveData` resolved cleanly on a batch that had already failed and the
 * board read `connected` with an empty cache behind it. That is the third
 * instance of the family that gave Stooq `onStooqHealth` and CoinGecko its
 * own, and this is the one that matters most: `markSources` lists exactly
 * `['twelvedata']`, so every graded outcome takes its mark from here. A silent
 * failure on this source is indistinguishable from a quiet market.
 *
 * Measured against the live API on 2026-09-16, free Basic plan:
 *
 *   1 symbol   → HTTP 200, a real SPY quote
 *   10 symbols → HTTP 429, "You have run out of API credits for the current
 *                minute. 10 API credits were used, with the current limit
 *                being 8."
 *
 * Twelve Data charges one credit per symbol per request, so `WATCHED.length`
 * *is* the credit cost of a cycle, and 10 against a cap of 8 cannot succeed —
 * not intermittently, ever. The batch strategy is deliberately left alone here:
 * whether the REST fallback needs to succeed at all depends on whether the
 * WebSocket carries the board during a session, and that is a market-hours
 * measurement. This change makes the failure *visible* so that measurement has
 * something to read.
 */
async function fetchQuotesBatch(): Promise<void> {
  try {
    const symbols = WATCHED.join(',');
    const { data } = await axios.get(`${BASE}/quote`, {
      params: { symbol: symbols, apikey: API_KEY },
      timeout: 8000,
    });

    let priced = 0;
    let refused = 0;

    const process = (sym: string, q: any) => {
      // A per-symbol `status: 'error'` is the vendor declining that symbol —
      // counted, because ten of them is a rejected key and returning silently
      // from all ten used to look identical to a successful cycle.
      if (!q) return;
      if (q.status === 'error') { refused++; return; }
      // `parseFloat(q.close ?? q.price ?? 0)` published $0.00 into the spot
      // cache for a symbol the batch answered without a price — and the cache
      // feeds every socket's ticker tape.
      const price = numeric(q.close) ?? numeric(q.price);
      if (price === null || price <= 0) { refused++; return; }
      const quote: SpotQuote = {
        symbol: sym,
        price,
        change: numeric(q.change),
        changePct: numeric(q.percent_change),
        volume: numeric(q.volume),
        timestamp: quoteTimestamp(q.timestamp),
        source: 'twelvedata',
      };
      spotCache.set(sym, quote);
      lastCacheWriteAt = Date.now();
      onSpotUpdate?.(quote);
      priced++;
    };

    // Response is either a single object or a map of symbol→data
    if (data?.symbol) {
      process(data.symbol, data);
    } else if (data?.status === 'error') {
      // Twelve Data answers some refusals with HTTP 200 and an error body —
      // the same asymmetry `classifyProbeStatus` exists for. Read as a map of
      // symbols this would be one entry named `status`, and the cycle would
      // report success having priced nothing.
      reportFailure(`HTTP 200 with an error body — ${describeBody(data)}`);
      return;
    } else {
      Object.entries(data ?? {}).forEach(([sym, q]) => process(sym, q as any));
    }

    if (priced > 0) {
      onHealth?.({ ok: true });
    } else {
      reportFailure(
        `Twelve Data returned no priced symbol${refused > 0 ? ` (${refused} refused)` : ''}.`,
      );
    }
  } catch (err: any) {
    const detail = describeHttpError(err);
    const reason = err?.response?.status === 429
      // The vendor's own words carry the arithmetic; what it cannot know is
      // that the number it is quoting back is our batch size.
      ? `${detail} This deployment requests ${WATCHED.length} symbols per cycle ` +
        `and Twelve Data charges one credit per symbol.`
      : detail;
    reportFailure(reason);
  }
}

/**
 * A failed REST cycle, told apart from a dead source.
 *
 * The stream and the batch are independent paths into one cache. If the socket
 * delivered a quote within `STREAM_GRACE_MS` the board is still being fed and
 * saying `error` would be false — but so would saying nothing, which is the
 * state this whole change exists to end. It goes out as degraded: connected,
 * with the reason attached. With nothing arriving by either path there is no
 * such distinction left to draw, and it is an outright failure.
 */
function reportFailure(reason: string): void {
  const streaming = lastCacheWriteAt > 0 && Date.now() - lastCacheWriteAt < STREAM_GRACE_MS;
  if (streaming) {
    console.warn('[twelvedata] REST batch failed, stream still delivering:', reason);
    onHealth?.({ ok: true, degraded: true, reason: `REST quote batch failing: ${reason}` });
  } else {
    console.warn('[twelvedata] quote batch error:', reason);
    onHealth?.({ ok: false, reason });
  }
}

/** The vendor's message from a 200-with-error body, scrubbed and clipped. */
function describeBody(data: any): string {
  return describeHttpError({ response: { status: 200, data } }).replace(/^HTTP 200 — /, '');
}

export async function startTwelveData(): Promise<void> {
  if (!API_KEY) { console.log('[twelvedata] No key — skipped'); return; }

  await fetchQuotesBatch();
  startWebSocket();

  // REST fallback every 60s
  setInterval(fetchQuotesBatch, 60_000).unref();
  console.log('[twelvedata] Started — WebSocket streaming + 60s REST fallback');
}
