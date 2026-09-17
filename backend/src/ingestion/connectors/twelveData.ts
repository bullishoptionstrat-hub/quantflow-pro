/**
 * Twelve Data — Real-time stock quotes, technicals, earnings
 * Free: 800 API credits/day, WebSocket streaming included
 * Docs: https://twelvedata.com/docs
 */
import axios from 'axios';
import WebSocket from 'ws';
import { numeric } from '../optionalNumber';
import { describeHttpError } from '../httpError';
import { scheduleDailyReset } from '../dailyReset';

const API_KEY = process.env.TWELVE_DATA_API_KEY || '';
const BASE = 'https://api.twelvedata.com';
const WS_URL = 'wss://ws.twelvedata.com/v1/quotes/price';
const WATCHED = ['SPY', 'QQQ', 'NVDA', 'AAPL', 'TSLA', 'MSFT', 'AMD', 'META', 'AMZN', 'MSTR'];

/**
 * What the free Basic plan actually sells, measured rather than assumed.
 *
 * Twelve Data charges **one API credit per symbol per request**, so a batch's
 * symbol count *is* its price. Both caps below are the vendor's own, and both
 * were taken from the vendor rather than from a comment in this file: the
 * per-minute cap came back quoted inside a 429 body on 2026-09-16 ("10 API
 * credits were used, with the current limit being 8"), and the daily cap is
 * the pricing page's "8 API (800 a day)", read 2026-09-17.
 *
 * The poller this replaces asked for all ten watched symbols every sixty
 * seconds. Ten credits against a per-minute cap of eight is the 429 the ledger
 * already records — but the arithmetic that actually decides the design is the
 * other one: ten symbols on a 60s timer is **14,400 credits a day against a
 * cap of 800**, eighteen times over. Chunking the request under the
 * per-minute cap clears the 429 and still exhausts the day in about eighty
 * cycles — a fix that reports healthy for an hour and then goes quiet, which
 * is the exact failure family this connector was given a health channel for.
 * So the cadence is derived from the daily budget below, not chosen.
 */
export const PER_MINUTE_CREDIT_CAP = 8;
export const DAILY_CREDIT_CAP = 800;

/**
 * Credits deliberately left unspent on quotes.
 *
 * Only part of this is derived. `startEntitlementProbes` asks Twelve Data for
 * `/price?symbol=SPY` at boot and hourly, which is **24 a day** on a process
 * that stays up and one more per wake on a process that does not — and on
 * Render's free tier it does not. The doctor's `--probe` spends on demand,
 * operator-driven and unbounded. So the floor is 24 and the rest is margin:
 * **200 is a deliberately generous reservation, not a computed one.**
 *
 * Generous is the right direction here, and cheaply so. Spending the margin
 * buys a shorter rotation — 600 usable credits is a 19-minute pass over eight
 * symbols, 750 would be 15 — and the rotation is already too slow to serve the
 * M15 horizon either way, so the marks bought with it are not the ones that
 * were missing. Getting it wrong the other way costs the entitlement probe,
 * which is the thing that tells the operator whether the mark source works at
 * all. A slower rotation is visible in the note; a probe that cannot run
 * reports `unknown` about the one source the grader depends on, which is the
 * quiet failure this whole file keeps being rewritten for.
 */
export const RESERVED_DAILY_CREDITS = 200;

/**
 * Credits held back inside each *minute*, for the same reason and learned the
 * hard way.
 *
 * Reserving only a daily slice left the per-minute cap unprotected, and the
 * first live boot with this rotation proved it: the boot pass asked for its
 * eight symbols, `startEntitlementProbes` asked for `/price?symbol=SPY` in the
 * same minute, and the vendor answered *the probe* with "9 API credits were
 * used, with the current limit being 8". The rotation was fine; what broke was
 * the entitlement check — which then reported `unknown` for the one source the
 * grader depends on, precisely the signal that probe exists to provide. A
 * budget that starves the instrument measuring it is not a budget.
 *
 * So a request is cut to what leaves room for the probe beside it, rather than
 * to the whole cap.
 */
export const RESERVED_PER_MINUTE_CREDITS = 2;

/** The largest request the rotation will send. */
export const MAX_SYMBOLS_PER_REQUEST = PER_MINUTE_CREDIT_CAP - RESERVED_PER_MINUTE_CREDITS;

/** The rotation's clock: one minute, the granularity the per-minute cap is written in. */
export const REST_TICK_MS = 60_000;

const DAY_MS = 86_400_000;

/**
 * Split the symbols that need a REST quote into requests the plan will answer.
 *
 * At most one request per minute, and no chunk may exceed the per-minute cap
 * *less the reservation* — the entitlement probe spends from the same minute,
 * and a request sized to the whole cap refuses it. A rotation costs
 * `symbols.length` credits however it is cut: chunking is what stops the 429,
 * never what stops the overspend.
 */
export function chunkSymbols(symbols: readonly string[]): string[][] {
  const chunks: string[][] = [];
  for (let i = 0; i < symbols.length; i += MAX_SYMBOLS_PER_REQUEST) {
    chunks.push(symbols.slice(i, i + MAX_SYMBOLS_PER_REQUEST));
  }
  return chunks;
}

/**
 * How long one full pass over the REST symbols must last to fit inside the day.
 *
 * Eight symbols — this deployment's measured state, see `startWebSocket` — is
 * 75 rotations a day, one every 19 minutes. That is **longer than the M15
 * grading horizon**, which is why the number is returned from here instead of
 * being written down as a constant: a mark for a REST-priced symbol can be
 * older than the horizon it grades, and `streamCoverageNote` says so on
 * /api/health rather than leaving M15 looking supported.
 */
export function rotationIntervalMs(creditsPerRotation: number): number {
  if (creditsPerRotation <= 0) return DAY_MS;
  const rotations = Math.floor((DAILY_CREDIT_CAP - RESERVED_DAILY_CREDITS) / creditsPerRotation);
  if (rotations < 1) return DAY_MS;
  return Math.ceil(DAY_MS / rotations);
}

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
 * WebSocket stamps its price events in unix **seconds**; `fetchQuotes`
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

/**
 * What the socket is actually entitled to carry, as the vendor reports it.
 *
 * This file's own header said "the WebSocket carries the board during a
 * session; the REST batch is a fallback". Measured against the live account on
 * 2026-09-17, subscribing to all ten watched symbols at once:
 *
 *   success → QQQ, AAPL
 *   fails   → SPY, NVDA, TSLA, MSFT, AMD, META, AMZN, MSTR
 *
 * Probed apart, SPY alone is refused and QQQ alone is accepted, so this is a
 * plan scoped **by symbol** and not a cap on how many. `entitlement.ts`
 * predicted exactly that shape from Twelve Data's public demo key; this is it
 * on the real one. The same eight symbols are served without complaint over
 * REST in a single 8-credit request, so the declared architecture is inverted:
 * the socket is the narrow path, and REST is the *only* path for most of the
 * board.
 *
 * Read from the `subscribe-status` ack rather than hard-coded, because a list
 * of two tickers written into this file would be an assertion about someone
 * else's plan — the move commit 06f6a91 exists to stop. The ack's `status`
 * string is not the signal (`ok` when all accepted, `warning` on a partial,
 * `error` when none): the `success` and `fails` arrays are.
 */
let streamAccepted = new Set<string>();
let streamRefused: string[] = [];
let streamAckAt = 0;

/**
 * Last delivery per symbol — a different question from `lastCacheWriteAt`.
 *
 * An accepted symbol leaves the REST rotation only while it is actually
 * arriving. Keeping this per symbol is what avoids the obvious bug in the
 * global version: with QQQ streaming, one global "something arrived recently"
 * test would suppress REST for the whole board and starve the eight symbols
 * that have no other path to a mark.
 */
const lastDeliveryBySymbol = new Map<string, number>();

/** The vendor's `subscribe-status` ack, recorded. Exported for tests. */
export function recordSubscribeStatus(accepted: string[], refused: string[]): void {
  streamAccepted = new Set(accepted);
  streamRefused = [...refused];
  streamAckAt = Date.now();
  // Re-scope the rotation now rather than at the end of the current pass: the
  // chunks queued a moment ago were cut before we knew what the socket covers.
  pendingChunks = [];
  reportCoverage();
}

/**
 * The entitlement gap, reported when it is learned rather than at the end of a
 * pass — a 24-minute-old answer to "what is my mark source actually carrying"
 * is not much of an answer.
 *
 * It never upgrades a failing cycle. A socket refusing eight symbols *and* a
 * dead rotation is an outage, and reporting that as `degraded` because the ack
 * happened to arrive second is the flattering read this connector's health
 * channel exists to refuse.
 */
function reportCoverage(): void {
  if (lastRestOk === false) return;
  const note = streamCoverageNote();
  if (note) onHealth?.({ ok: true, degraded: true, reason: note });
}

/** The last REST verdict, so `reportCoverage` cannot talk over it. */
let lastRestOk: boolean | null = null;

/**
 * The symbols this rotation has to buy.
 *
 * `WATCHED` minus what the socket is both entitled to and currently
 * delivering. Before the ack lands `streamAccepted` is empty and the rotation
 * covers everything, which is the safe direction: at boot we do not yet know
 * what the plan allows, and over-covering costs credits while under-covering
 * costs marks.
 */
export function restSymbols(): string[] {
  const now = Date.now();
  return WATCHED.filter((s) => {
    if (!streamAccepted.has(s)) return true;
    const last = lastDeliveryBySymbol.get(s);
    // Not `?? 0`: "this symbol has never arrived" is a different statement
    // from "it last arrived at the epoch", and only one of them is true at
    // boot. The zero would work here by accident — it is infinitely stale, so
    // the symbol gets covered — which is exactly how a defaulted reading earns
    // its way into code and then outlives the accident.
    return last === undefined || now - last >= STREAM_GRACE_MS;
  });
}

/**
 * The entitlement gap, in the operator's words.
 *
 * `markSources` lists exactly `['twelvedata']`, so this sentence is the answer
 * to "which of my symbols can the grader actually price, and how fresh is that
 * price". Before it, a plan refusing eight of ten symbols on the socket and a
 * poller that could never complete one cycle both reported `connected`.
 */
export function streamCoverageNote(): string | null {
  if (streamAckAt === 0 || streamRefused.length === 0) return null;
  const minutes = Math.round(rotationIntervalMs(restSymbols().length) / 60_000);
  return (
    `WebSocket carries ${streamAccepted.size} of ${WATCHED.length} watched symbols — ` +
    `the plan refuses ${streamRefused.join(', ')}. Those are priced by REST on a ` +
    `${minutes}-minute rotation (free tier: ${DAILY_CREDIT_CAP} credits/day), which is ` +
    `longer than the M15 horizon — an M15 mark on them can be older than the move it grades.`
  );
}

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

/**
 * The mark for a symbol *with the stamp the vendor gave it*, or null.
 *
 * Added beside `getSpotPrice` rather than replacing it: that name is referenced
 * in `entitlement.ts`, `finnhub.ts`, `fred.ts` and `rights.ts`, and the bare
 * price is still what the ticker tape wants. What the grader needs and could
 * never ask for is *when the price was true*.
 *
 * `SpotQuote.timestamp` is the vendor's own stamp, normalized to milliseconds
 * by `quoteTimestamp` — deliberately not `lastDeliveryBySymbol`, which is when
 * we received it. Those differ by the whole point: off-hours the vendor's stamp
 * is the last session's close, and reporting a mark as fresh because it arrived
 * recently is the manufactured freshness `RawPrint.quoteTs` exists to prevent.
 * A price from the last close cannot measure a fifteen-minute move, and the
 * grader can only know that if it is told the price's own age.
 */
export function getSpotMark(symbol: string): { price: number; asOf: number } | null {
  const q = spotCache.get(symbol);
  if (!q || !(q.price > 0)) return null;
  return { price: q.price, asOf: q.timestamp };
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
      if (msg.event === 'subscribe-status') {
        // The vendor answering "which of these am I allowed to send you" — the
        // one place that question gets a free, authoritative answer.
        const named = (rows: unknown): string[] =>
          Array.isArray(rows)
            ? rows.map((r: any) => r?.symbol).filter((x: unknown): x is string => typeof x === 'string')
            : [];
        recordSubscribeStatus(named(msg.success), named(msg.fails));
        if (streamRefused.length > 0) {
          console.warn(`[twelvedata] socket refused ${streamRefused.length} of ${WATCHED.length} symbols:`,
            streamRefused.join(', '));
        }
        return;
      }
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
        lastDeliveryBySymbol.set(msg.symbol, lastCacheWriteAt);
        onSpotUpdate?.(quote);
      }
    } catch {}
  });

  ws.on('error', () => {});
  ws.on('close', () => { setTimeout(startWebSocket, 5000).unref(); });
}

/**
 * The rotation, mid-flight.
 *
 * `pendingChunks` holds what is left of the current pass; `lastRotationStartAt`
 * is when that pass began. One fixed 60s tick drives both, rather than a timer
 * whose delay is recomputed each firing: the per-minute cap is written in
 * minutes, so a one-minute clock is the natural granularity — and a re-arming
 * `setTimeout` would be a poller outside the scope of the guard in
 * `missingIsNotZero.test.ts`, which walks `setInterval` only. Widening that
 * boundary is worth doing on its own; slipping a new poller across it is not.
 */
let pendingChunks: string[][] = [];
let lastRotationStartAt = 0;

/** The credits this rotation may actually spend in a day. */
export const USABLE_DAILY_CREDITS = DAILY_CREDIT_CAP - RESERVED_DAILY_CREDITS;

/**
 * Credits spent today — the backstop the derived cadence needs to be safe.
 *
 * `rotationIntervalMs` paces a *continuously running* process into the daily
 * cap. Render's free tier sleeps after 15 minutes and this is the deployment
 * target, so the process is expected to restart repeatedly — and every start
 * runs a boot rotation, which the pacing alone never sees. Ten wakes is ten
 * rotations in an hour against a cadence that budgeted for two.
 *
 * Like every other metered connector here, the counter is in memory and a
 * restart zeroes it, so this bounds a running process rather than the vendor's
 * actual day. Making it survive restarts needs the persistence layer the
 * roadmap's Phase 0.2 is about; it is not something this connector can claim
 * on its own.
 */
let dailyCreditsUsed = 0;

/** Exported for tests; the running process reads it through health. */
export function creditsUsedToday(): number { return dailyCreditsUsed; }

/**
 * Charge the budget for a request, or refuse it.
 *
 * Counted on the *request*, not on a successful response: the 429 body that
 * started all of this says "10 API credits were used", so a refused batch is
 * billed exactly like an answered one.
 */
function spend(credits: number): boolean {
  if (dailyCreditsUsed + credits > USABLE_DAILY_CREDITS) return false;
  dailyCreditsUsed += credits;
  return true;
}

/**
 * Why a failing cycle is *reported* and not just logged.
 *
 * `startConnector` records what `start()` returned once and never looks again,
 * and the REST path swallowed every failure in its own try/catch — so
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
 * Twelve Data charges one credit per symbol per request, so the request's
 * symbol count *is* the credit cost of a cycle, and 10 against a cap of 8
 * cannot succeed — not intermittently, ever.
 *
 * That measurement deferred the batch strategy to "whether the REST fallback
 * needs to succeed depends on whether the WebSocket carries the board during a
 * session". It does not: the socket's own `subscribe-status` ack refuses eight
 * of the ten watched symbols on this plan (see `recordSubscribeStatus`), and
 * REST is the only path those eight have. So the fallback is not a fallback,
 * and the request is now scoped to `restSymbols()` and cut to fit the
 * per-minute cap, on a cadence `rotationIntervalMs` derives from the daily one.
 */
async function fetchQuotes(symbols: readonly string[]): Promise<void> {
  try {
    const { data } = await axios.get(`${BASE}/quote`, {
      params: { symbol: symbols.join(','), apikey: API_KEY },
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
      lastDeliveryBySymbol.set(sym, lastCacheWriteAt);
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
      reportSuccess();
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
      // The count has to come from the request that was refused, not from
      // `WATCHED`: once the rotation is chunked those differ, and a reason
      // reporting ten symbols for a request that sent eight sends the operator
      // looking for a batch size the code no longer uses.
      ? `${detail} This request asked for ${symbols.length} symbol` +
        `${symbols.length === 1 ? '' : 's'} and Twelve Data charges one credit per symbol.`
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
  // Set even on the degraded branch below: the socket carrying the board does
  // not make the REST rotation that just failed a success.
  lastRestOk = false;
  const streaming = lastCacheWriteAt > 0 && Date.now() - lastCacheWriteAt < STREAM_GRACE_MS;
  if (streaming) {
    console.warn('[twelvedata] REST batch failed, stream still delivering:', reason);
    onHealth?.({ ok: true, degraded: true, reason: `REST quote batch failing: ${reason}` });
  } else {
    console.warn('[twelvedata] quote batch error:', reason);
    onHealth?.({ ok: false, reason });
  }
}

/**
 * A cycle that priced something, with the standing entitlement gap attached.
 *
 * A rotation can succeed completely and the board still be served worse than
 * the code claims — eight of ten symbols arriving on a 19-minute REST pass
 * instead of a stream is a real fact about the deployment. It goes out on the
 * note channel, which the settings page renders as DEGRADED, so "the request
 * worked" never reads as "the source is healthy".
 */
function reportSuccess(): void {
  lastRestOk = true;
  const note = streamCoverageNote();
  if (note) onHealth?.({ ok: true, degraded: true, reason: note });
  else onHealth?.({ ok: true });
}

/**
 * One minute of the rotation: at most one request, and only when it is owed.
 *
 * Between passes this returns without spending, which is the whole budget
 * mechanism — `rotationIntervalMs` decides how long a pass has to last, and
 * this is what waits it out. A pass with nothing in it (every watched symbol
 * arriving on the socket) still reports, because silence from the mark source
 * is the state this connector's health channel exists to end.
 */
export async function tick(): Promise<void> {
  if (pendingChunks.length === 0) {
    if (Date.now() - lastRotationStartAt < rotationIntervalMs(restSymbols().length)) return;
    pendingChunks = chunkSymbols(restSymbols());
    lastRotationStartAt = Date.now();
    if (pendingChunks.length === 0) { reportSuccess(); return; }
  }
  const chunk = pendingChunks.shift();
  if (!chunk || chunk.length === 0) return;

  if (!spend(chunk.length)) {
    // Stop the pass rather than let the next tick retry a request the budget
    // cannot pay for. Reported, not merely stopped: a mark source that has
    // gone quiet until midnight is precisely the silence this connector's
    // health channel exists to end.
    pendingChunks = [];
    reportFailure(
      `Daily credit budget spent — ${dailyCreditsUsed} of ${USABLE_DAILY_CREDITS} usable ` +
      `credits used. No further quotes until the local-midnight reset.`,
    );
    return;
  }
  await fetchQuotes(chunk);
}

/** The vendor's message from a 200-with-error body, scrubbed and clipped. */
function describeBody(data: any): string {
  return describeHttpError({ response: { status: 200, data } }).replace(/^HTTP 200 — /, '');
}

export async function startTwelveData(): Promise<void> {
  if (!API_KEY) { console.log('[twelvedata] No key — skipped'); return; }

  // The socket goes first so its ack can land before the rotation is scoped.
  // The rotation is correct either way — an unacked socket means REST covers
  // everything — but an ack arriving during the first request spares the two
  // symbols it carries from being bought as well.
  startWebSocket();
  scheduleDailyReset(() => { dailyCreditsUsed = 0; });
  await tick();
  setInterval(() => { void tick(); }, REST_TICK_MS).unref();
  console.log(
    '[twelvedata] Started — WebSocket streaming + REST rotation every ' +
    `${Math.round(rotationIntervalMs(restSymbols().length) / 60_000)} min`,
  );
}
