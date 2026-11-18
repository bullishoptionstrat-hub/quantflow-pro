/**
 * CBOE delayed options chains — real strikes, volume, open interest and greeks.
 * No API key required; the same public CDN the cboe.com quote pages use.
 *
 * Docs: https://www.cboe.com/delayed_quotes/
 *
 * Two things this feeds:
 *
 *   1. Gamma exposure. CBOE publishes a per-contract `gamma` and
 *      `open_interest`, so GEX is a direct computation rather than an
 *      inference. This replaces `generateSyntheticGEX`, which invented it.
 *
 *   2. Unusual activity. `volume` is a cumulative daily total per contract, so
 *      volume-vs-open-interest is a real institutional-participation signal.
 *
 * IMPORTANT — this data is delayed (CBOE publishes it on a ~15 minute lag) and
 * `volume` is a daily aggregate, not a trade tape. It is deliberately NOT routed
 * through `ingestPrint()`: attaching a whole day's volume to `last_trade_price`
 * would fabricate a premium figure that no single trade ever paid. Everything
 * here carries `asOf` / `delayedMinutes` so the UI can label it honestly.
 */
import axios from 'axios';
import { numeric } from '../optionalNumber';
import { instantEt } from '../../market/civil';

export interface CboeGexLevel {
  strike: number;
  gex: number;
  /**
   * Open-interest-weighted dollar delta at this strike, in dollars of
   * underlying per contract-set.
   *
   *   delta x OI x 100 x spot
   *
   * **The sign is the contract's own, and that is the whole difference from
   * `gex` above.** Gamma is positive for calls and puts alike, so the
   * call-positive / put-negative split in `gex` is a convention *imposed* to
   * express an assumed dealer book. Delta already carries its sign — calls
   * positive, puts negative — so imposing a second one would flip the puts
   * twice and report a book that is the mirror of the one on the tape.
   *
   * Consequently this is **not** "dealer delta exposure": no dealer-side
   * assumption is applied here. It is what the open interest itself is long or
   * short, which is the quantity the vendor's own numbers support.
   */
  dex: number;
  /**
   * Contracts at this strike that had open interest and gamma but no delta,
   * and so contributed nothing to `dex`.
   *
   * Published rather than swallowed: `dex` is a sum, and a sum missing terms
   * is not the same quantity as a complete one. Zero-filling the absent deltas
   * would have hidden this entirely, since zero is the additive identity —
   * which is exactly why `defaultedReadings.test.ts` refuses `?? 0` on a
   * market reading.
   */
  dexMissing: number;
  callOI: number;
  putOI: number;
  callGamma: number;
  putGamma: number;
  callDelta: number;
  putDelta: number;
}

export interface CboeUnusualContract {
  option: string;
  symbol: string;
  expiry: string;
  strike: number;
  right: 'C' | 'P';
  /** Both gated above: a row reaches this list only with a volume and a last. */
  volume: number;
  last: number;
  /**
   * `null` where the chain row did not carry one.
   *
   * `Number(r.open_interest) || 0` published a **0** into the Open Int column
   * for a row Cboe answered without the field, and the table renders it with
   * `.toLocaleString()` — so an unknown open interest read as the definite
   * claim "0". Unlike the GEX path above, which skips a contract on `oi > 0`,
   * this list is gated on volume alone, so the zero survived to the wire.
   */
  openInterest: number | null;
  /**
   * Volume as a multiple of open interest — `null` when there is no open
   * interest to divide by, which is what "the whole day's volume opened new
   * positions" looks like.
   *
   * This was `Infinity`, and `JSON.stringify(Infinity)` is `null`, so the wire
   * already carried a null the type called a `number`. The frontend's
   * `Number.isFinite(...)` check happened to render that as `new`, which is
   * right — by way of a path neither side declared. It is a real null now.
   */
  volumeToOI: number | null;
  bid: number | null;
  ask: number | null;
  iv: number | null;
  delta: number | null;
  /** volume x last x 100. A day's notional, not one trade's premium. */
  notional: number;
  lastTradeTime: string | null;
}

/**
 * Same-day expiry, when the chain has one.
 *
 * `null` is the common case and it is the honest one. Measured on 2026-09-15:
 * SPY carried 310 same-day contracts and SPX 484, while AAPL's nearest expiry
 * was the *next* day — it had no 0DTE at all. Only the index products and a
 * handful of names run daily expiries, so a "0DTE" panel that quietly showed
 * the nearest expiry instead would relabel tomorrow's contracts as today's for
 * most of the market, which is the fabrication this whole file avoids
 * elsewhere.
 */
export interface CboeZeroDte {
  /** The chain's own trading date, which is also the expiry being shown. */
  expiry: string;
  levels: CboeGexLevel[];
  contractCount: number;
}

export interface CboeSnapshot {
  symbol: string;
  /**
   * The underlying price the chain carried, which is the price every GEX and
   * DEX figure in this snapshot is scaled by. Always positive: a chain without
   * one is refused, not published.
   */
  spot: number;
  /** Which of the chain's own fields supplied `spot`. */
  spotField: 'current_price' | 'close';
  /** 30-day implied volatility, or `null` where the chain did not carry it. */
  iv30: number | null;
  gex: CboeGexLevel[];
  /**
   * The same aggregation restricted to contracts expiring on the chain's own
   * date. `null` when the chain carries none — see `CboeZeroDte`.
   */
  zeroDte: CboeZeroDte | null;
  /** The chain's own trading date, from the vendor's clock rather than ours. */
  tradeDate: string | null;
  unusual: CboeUnusualContract[];
  contractCount: number;
  /**
   * The instant the chain's underlying last traded, as an ISO string in UTC,
   * read from the chain's own `data.last_trade_time` by `cboeTimeToIso`.
   * `null` when Cboe sent none or sent one that cannot be read.
   *
   * This was `d.last_trade_time ?? new Date().toISOString()`: a chain that
   * arrived without a clock was stamped with this server's receipt time, in
   * the same field as the vendor's own, so nothing downstream could tell a
   * measured as-of from the moment the poll happened to land. It also passed
   * the vendor's string through unconverted, and that string has no zone, so
   * every browser read it in its own local time.
   */
  asOf: string | null;
  /** `data.last_trade_time` exactly as Cboe sent it, or `null`. */
  asOfVendor: string | null;
  delayedMinutes: number;
  source: 'cboe';
}

const DELAYED_MINUTES = 15;

/** CBOE prefixes cash indices with an underscore. */
const CBOE_SYMBOL: Record<string, string> = {
  SPX: '_SPX', VIX: '_VIX', NDX: '_NDX', RUT: '_RUT',
};

const snapshots = new Map<string, CboeSnapshot>();
let onUpdate: ((s: CboeSnapshot) => void) | null = null;

export function onCboeOptions(handler: (s: CboeSnapshot) => void): void {
  onUpdate = handler;
}
export function getCboeSnapshot(symbol: string): CboeSnapshot | null {
  return snapshots.get(symbol.toUpperCase()) ?? null;
}
export function getCboeSymbols(): string[] {
  return [...snapshots.keys()];
}

/**
 * Split an OSI contract symbol: root, YYMMDD, C|P, strike x1000.
 * Parsed from the right because the root is variable length.
 */
function parseOsi(osi: string): { symbol: string; expiry: string; right: 'C' | 'P'; strike: number } | null {
  if (osi.length < 16) return null;
  const strikeRaw = osi.slice(-8);
  const right = osi.slice(-9, -8) as 'C' | 'P';
  const date = osi.slice(-15, -9);
  const symbol = osi.slice(0, -15);
  if (right !== 'C' && right !== 'P') return null;
  const strike = parseInt(strikeRaw, 10) / 1000;
  if (!(strike > 0)) return null;
  return {
    symbol,
    expiry: `20${date.slice(0, 2)}-${date.slice(2, 4)}-${date.slice(4, 6)}`,
    right,
    strike,
  };
}

/**
 * Dealer gamma exposure per strike, in dollars of delta per 1% move in spot.
 *
 *   gamma x OI x 100 (contract multiplier) x spot^2 x 0.01
 *
 * spot appears squared, not linearly: gamma is dDelta/dSpot per $1, so one
 * factor of spot converts share-gamma to dollar-gamma and the second scales
 * a $1 move into a 1% move. Convention here is call gamma positive, put gamma
 * negative, which is what puts the gamma flip where desks expect it.
 */
function gexFor(gamma: number, oi: number, spot: number): number {
  return gamma * oi * 100 * spot * spot * 0.01;
}

/**
 * Dollar delta: `delta x OI x 100 x spot`.
 *
 * One factor of spot, not two — unlike `gexFor`. Delta is already a share
 * count per contract, so a single spot converts it to dollars; gamma needs a
 * second factor because it is a *rate of change* of delta and the extra spot
 * is what scales a $1 move into a 1% one.
 */
function dexFor(delta: number, oi: number, spot: number): number {
  return delta * oi * 100 * spot;
}

/**
 * A Cboe chain timestamp as an ISO instant in UTC, or `null`.
 *
 * Cboe sends `data.last_trade_time` with **no zone**, e.g.
 * `"2026-11-11T14:46:01"`. It is read as a New York wall clock, and that is a
 * measurement, not a guess. Fetched on 2026-11-11 at 20:01:55 UTC, the `_VIX`
 * chain carried a top-level generation stamp `"2026-11-11 20:01:15"` (UTC —
 * forty seconds before the fetch) and `data.last_trade_time`
 * `"2026-11-11T14:46:01"`. Read as New York time that is 19:46:01 UTC, 15m14s
 * before the file was generated, which is the delay Cboe publishes. Read as
 * UTC it would be five hours old; read as Chicago time it would postdate the
 * file that contains it. The per-contract trade times in the same file ran
 * 09:33 to 14:46, the New York session. One sample, so a future change of
 * format shows up as a `null` here or an implausible age on the ticket, never
 * as a confident wrong clock: a string that does not match this shape is
 * refused rather than handed to `Date.parse`, which would read it in this
 * server's own timezone.
 *
 * Why not `quoteTimestamp` in `twelveData.ts`: it reads epoch seconds or
 * milliseconds, and falls back to `Date.now()` for anything else — which for
 * this string is every value. That fallback is receipt time in the vendor's
 * field, the exact thing this function exists to refuse.
 *
 * A string carrying an explicit `Z` or offset is read as given. A New York
 * wall-clock time that does not exist (the spring-forward gap) is `null`.
 */
export function cboeTimeToIso(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/.test(s)) {
    const ms = Date.parse(s);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
  }
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2}):(\d{2})(\.\d{1,3})?$/.exec(s);
  if (!m) return null;
  const hour = Number(m[2]);
  const minute = Number(m[3]);
  const second = Number(m[4]);
  if (hour > 23 || minute > 59 || second > 59) return null;
  const base = instantEt(m[1]!, hour, minute);
  if (base === null) return null;
  const millis = m[5] ? Math.round(Number(m[5]) * 1000) : 0;
  return new Date(base + second * 1000 + millis).toISOString();
}

export async function fetchCboeChain(symbol: string): Promise<CboeSnapshot | null> {
  const upper = symbol.toUpperCase();
  const cboeSym = CBOE_SYMBOL[upper] ?? upper;

  const { data } = await axios.get(
    `https://cdn.cboe.com/api/global/delayed_quotes/options/${cboeSym}.json`,
    { timeout: 20_000, maxContentLength: 40 * 1024 * 1024 }
  );

  const d = data?.data;
  const rows = d?.options;
  if (!Array.isArray(rows) || rows.length === 0) return null;

  // Gated on `spot > 0`: no spot means no snapshot, since every GEX figure
  // below is scaled by it. `current_price` first and `close` only when the
  // chain sent no current price at all, as before — and the field that
  // answered is kept, because the ticket shows distances from this number.
  const currentPrice = numeric(d.current_price);
  const spotField: CboeSnapshot['spotField'] = currentPrice !== null ? 'current_price' : 'close';
  const spot = currentPrice ?? numeric(d.close);
  if (spot === null || !(spot > 0)) return null;

  // The chain's own date, not `new Date()`. The server's clock can be in any
  // timezone and the question — "does this contract expire today?" — is asked
  // in the market's, so the vendor's own timestamp is the only one that
  // answers it without an assumption.
  const tradeDate = typeof d.last_trade_time === 'string' && d.last_trade_time.length >= 10
    ? d.last_trade_time.slice(0, 10)
    : null;

  const byStrike = new Map<number, CboeGexLevel>();
  const zeroDteByStrike = new Map<number, CboeGexLevel>();
  let zeroDteContracts = 0;
  const unusual: CboeUnusualContract[] = [];

  /** Accumulate one contract into one strike bucket. */
  const accumulate = (
    into: Map<number, CboeGexLevel>,
    strike: number, right: 'C' | 'P', oi: number, gamma: number,
    delta: number | null,
  ): void => {
    let lvl = into.get(strike);
    if (!lvl) {
      lvl = {
        strike, gex: 0, dex: 0, dexMissing: 0, callOI: 0, putOI: 0,
        callGamma: 0, putGamma: 0, callDelta: 0, putDelta: 0,
      };
      into.set(strike, lvl);
    }
    if (right === 'C') {
      lvl.callOI += oi;
      lvl.callGamma += gamma;
      if (delta !== null) lvl.callDelta += delta;
      lvl.gex += gexFor(gamma, oi, spot);
    } else {
      lvl.putOI += oi;
      lvl.putGamma += gamma;
      if (delta !== null) lvl.putDelta += delta;
      lvl.gex -= gexFor(gamma, oi, spot);
    }
    // No sign flip, for either right. See `CboeGexLevel.dex`.
    if (delta === null) lvl.dexMissing++;
    else lvl.dex += dexFor(delta, oi, spot);
  };

  for (const r of rows) {
    const parsed = parseOsi(String(r.option ?? ''));
    if (!parsed) continue;

    // Read once, honestly, then narrowed per path. The GEX aggregation below
    // needs a number it can multiply and gates on `oi > 0 && gamma !== 0`, so
    // a missing field there is correctly a skip — but the unusual list is
    // gated on volume alone and *publishes* open interest, so it needs the
    // null. One zero-fill was serving two paths with different requirements.
    const rawOi = numeric(r.open_interest);
    const oi = rawOi ?? 0;
    const gamma = numeric(r.gamma) ?? 0;
    // Null, not zero, and the zero-fill guard is what forced the distinction.
    //
    // `?? 0` was the first version and it is wrong in the way this repo keeps
    // finding: an option's delta is never actually zero, so a contract the
    // vendor sent no delta for would have been recorded as one with no
    // directional exposure and silently folded into the sum. Zero being the
    // additive identity makes it *invisible* rather than harmless.
    //
    // So a deltaless contract is skipped for DEX and counted in `dexMissing`,
    // and it still joins the gamma aggregation it legitimately belongs to.
    const delta = numeric(r.delta);
    const volume = numeric(r.volume) ?? 0;

    if (oi > 0 && gamma !== 0) {
      accumulate(byStrike, parsed.strike, parsed.right, oi, gamma, delta);
      if (tradeDate !== null && parsed.expiry === tradeDate) {
        accumulate(zeroDteByStrike, parsed.strike, parsed.right, oi, gamma, delta);
        zeroDteContracts++;
      }
    }

    // Volume exceeding open interest means most of today's activity opened new
    // positions rather than closing existing ones — the classic institutional
    // participation tell.
    // Gated on `last > 0` two lines down, so an absent price skips the row.
    const last = numeric(r.last_trade_price) ?? 0;
    if (volume > 0 && last > 0 && volume > Math.max(oi, 250)) {
      unusual.push({
        option: String(r.option),
        symbol: parsed.symbol,
        expiry: parsed.expiry,
        strike: parsed.strike,
        right: parsed.right,
        volume,
        openInterest: rawOi,
        volumeToOI: rawOi !== null && rawOi > 0 ? volume / rawOi : null,
        bid: numeric(r.bid),
        ask: numeric(r.ask),
        last,
        iv: numeric(r.iv),
        delta: numeric(r.delta),
        notional: volume * last * 100,
        lastTradeTime: r.last_trade_time ?? null,
      });
    }
  }

  unusual.sort((a, b) => b.notional - a.notional);

  const snap: CboeSnapshot = {
    symbol: upper,
    spot,
    spotField,
    iv30: numeric(d.iv30),
    gex: [...byStrike.values()].sort((a, b) => a.strike - b.strike),
    // Gated on there being some: an empty level list under a real expiry would
    // render as "0DTE gamma is flat today", which is a claim. Nothing is not.
    zeroDte: tradeDate !== null && zeroDteByStrike.size > 0
      ? {
        expiry: tradeDate,
        levels: [...zeroDteByStrike.values()].sort((a, b) => a.strike - b.strike),
        contractCount: zeroDteContracts,
      }
      : null,
    tradeDate,
    unusual: unusual.slice(0, 40),
    contractCount: rows.length,
    asOf: cboeTimeToIso(d.last_trade_time),
    asOfVendor: typeof d.last_trade_time === 'string' ? d.last_trade_time : null,
    delayedMinutes: DELAYED_MINUTES,
    source: 'cboe',
  };

  // The raw chain (up to ~13MB parsed for SPX) goes out of scope here; only the
  // aggregate is retained. Render's free tier has 512MB.
  snapshots.set(upper, snap);
  onUpdate?.(snap);
  return snap;
}
