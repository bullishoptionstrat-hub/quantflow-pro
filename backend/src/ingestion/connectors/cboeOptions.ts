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
import { num } from '../parseNumeric';

export interface CboeGexLevel {
  strike: number;
  gex: number;
  callOI: number;
  putOI: number;
  callGamma: number;
  putGamma: number;
}

export interface CboeUnusualContract {
  option: string;
  symbol: string;
  expiry: string;
  strike: number;
  right: 'C' | 'P';
  volume: number;
  openInterest: number;
  volumeToOI: number;
  bid: number;
  ask: number;
  last: number;
  iv: number;
  delta: number;
  /** volume x last x 100. A day's notional, not one trade's premium. */
  notional: number;
  lastTradeTime: string | null;
}

export interface CboeSnapshot {
  symbol: string;
  spot: number;
  iv30: number;
  gex: CboeGexLevel[];
  unusual: CboeUnusualContract[];
  contractCount: number;
  /**
   * When the source says this chain was last traded. `null` when the payload
   * carries no timestamp — see `tradeDateInferred`.
   *
   * Previously this fell back to `new Date().toISOString()`, so a chain that
   * had stopped updating was stamped with the current time and read as fresh.
   * A snapshot that cannot say when it is from must say THAT, not pick now.
   */
  asOf: string | null;
  /**
   * True when `asOf` could not be established from the payload. The UI must
   * not present such a snapshot as current. (`packages/domain/src/freshness.ts`
   * models this as the `TRADE_DATE_INFERRED` quality flag.)
   */
  tradeDateInferred: boolean;
  /**
   * Age in minutes derived from `asOf` where possible. Falls back to the
   * publisher's declared lag when `asOf` is unknown — in which case this is a
   * FLOOR, not a measurement, and `tradeDateInferred` says so.
   */
  delayedMinutes: number;
  source: 'cboe';
}

/**
 * CBOE's published lag for this feed. Used as a floor when the payload carries
 * no timestamp of its own; when it does, real age is computed instead.
 */
const DECLARED_DELAY_MINUTES = 15;

/**
 * Minutes between a source timestamp and now, or null if unusable.
 * A future timestamp yields null rather than a negative age — that is clock
 * skew or a parse error, and pretending it means "very fresh" is how stale
 * detection gets defeated.
 */
export function ageMinutesFrom(asOf: string | null, now: Date = new Date()): number | null {
  if (!asOf) return null;
  const t = Date.parse(asOf);
  if (Number.isNaN(t)) return null;
  const minutes = (now.getTime() - t) / 60_000;
  if (minutes < 0) return null;
  return Math.round(minutes);
}

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
 * spot appears squared, not linearly: gamma is dTheta/dSpot per $1, so one
 * factor of spot converts share-gamma to dollar-gamma and the second scales
 * a $1 move into a 1% move. Convention here is call gamma positive, put gamma
 * negative, which is what puts the gamma flip where desks expect it.
 */
function gexFor(gamma: number, oi: number, spot: number): number {
  return gamma * oi * 100 * spot * spot * 0.01;
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

  const spot = Number(d.current_price ?? d.close ?? 0);
  if (!(spot > 0)) return null;

  const byStrike = new Map<number, CboeGexLevel>();
  const unusual: CboeUnusualContract[] = [];

  for (const r of rows) {
    const parsed = parseOsi(String(r.option ?? ''));
    if (!parsed) continue;

    const oi = Number(r.open_interest) || 0;
    const gamma = Number(r.gamma) || 0;
    const volume = Number(r.volume) || 0;

    if (oi > 0 && gamma !== 0) {
      let lvl = byStrike.get(parsed.strike);
      if (!lvl) {
        lvl = { strike: parsed.strike, gex: 0, callOI: 0, putOI: 0, callGamma: 0, putGamma: 0 };
        byStrike.set(parsed.strike, lvl);
      }
      if (parsed.right === 'C') {
        lvl.callOI += oi;
        lvl.callGamma += gamma;
        lvl.gex += gexFor(gamma, oi, spot);
      } else {
        lvl.putOI += oi;
        lvl.putGamma += gamma;
        lvl.gex -= gexFor(gamma, oi, spot);
      }
    }

    // Volume exceeding open interest means most of today's activity opened new
    // positions rather than closing existing ones — the classic institutional
    // participation tell.
    const last = Number(r.last_trade_price) || 0;
    if (volume > 0 && last > 0 && volume > Math.max(oi, 250)) {
      unusual.push({
        option: String(r.option),
        symbol: parsed.symbol,
        expiry: parsed.expiry,
        strike: parsed.strike,
        right: parsed.right,
        volume,
        openInterest: oi,
        volumeToOI: oi > 0 ? volume / oi : Infinity,
        bid: Number(r.bid) || 0,
        ask: Number(r.ask) || 0,
        last,
        iv: Number(r.iv) || 0,
        delta: Number(r.delta) || 0,
        notional: volume * last * 100,
        lastTradeTime: r.last_trade_time ?? null,
      });
    }
  }

  unusual.sort((a, b) => b.notional - a.notional);

  // No fallback to now(). If the payload does not date itself, that is a fact
  // about the payload, and the snapshot carries it rather than concealing it.
  const asOf = typeof d.last_trade_time === 'string' && d.last_trade_time.trim().length > 0
    ? d.last_trade_time
    : null;

  const snap: CboeSnapshot = {
    symbol: upper,
    spot,
    // Another sentinel: `Number(d.iv30) || 0`. An implied volatility of exactly
    // 0 is not a market state, it is a parse failure wearing a number.
    iv30: num(d.iv30) ?? 0,
    gex: [...byStrike.values()].sort((a, b) => a.strike - b.strike),
    unusual: unusual.slice(0, 40),
    contractCount: rows.length,
    asOf,
    tradeDateInferred: asOf === null,
    // Real age when the source dated itself; otherwise the publisher's declared
    // lag as a floor, flagged above as inferred.
    delayedMinutes: ageMinutesFrom(asOf) ?? DECLARED_DELAY_MINUTES,
    source: 'cboe',
  };

  // The raw chain (up to ~13MB parsed for SPX) goes out of scope here; only the
  // aggregate is retained. Render's free tier has 512MB.
  snapshots.set(upper, snap);
  onUpdate?.(snap);
  return snap;
}
