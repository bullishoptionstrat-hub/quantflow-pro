/**
 * ROADMAP 5.4 — implied-volatility term structure from the chain already
 * fetched, and an explicit refusal for IV rank and percentile.
 *
 * **Term structure is a reading of one chain**, so it can be built today: for
 * each expiry, the at-the-money implied volatility Cboe publishes on its own
 * contracts. Nothing is recomputed. These are Cboe's per-contract `iv` values
 * under Cboe's model and inputs, the same standing `assumptions.greeks` gives
 * gamma and delta on `/api/gex`.
 *
 * **IV rank and IV percentile are not a reading of one chain.** Both compare
 * today's IV with a trailing history, conventionally a year of daily
 * observations, and this deployment has none. A history would have to be
 * accumulated from this chain, and `CBOE_CDN_DELAYED_CHAIN` is `UNVERIFIED`
 * for PERSIST in both business modes, which the registry refuses (uncertainty
 * resolves to refusal). An in-memory series would not help either: it dies on
 * every restart, and Render's free tier restarts after 15 idle minutes, so it
 * would never reach a year. A rank computed over whatever happened to survive
 * since boot would be a percentile of an afternoon published under the name of
 * a year. Both are `null`, with that reason on the payload, the way the gamma
 * flip is.
 *
 * Decisions, each stated where a reader will meet it:
 *
 *   - **ATM is the strike nearest spot that carries BOTH a call and a put IV.**
 *     One side alone is skew, not level. Ties go to the lower strike, so the
 *     answer does not depend on row order.
 *   - **The call and put IVs are published separately, beside their mean.**
 *     A wide gap between them at one strike is information (or a stale quote),
 *     and averaging it away would hide it.
 *   - **How far the chosen strike is from spot is published, not policed.** A
 *     cutoff ("refuse beyond 5%") would be a picked constant with no basis
 *     here; `distancePct` lets a reader see when "ATM" is a long way from the
 *     money on a sparse expiry.
 *   - **An `iv` of zero or less is missing, not a reading.** No option trades
 *     at zero volatility; a zero is what an unquoted row looks like. Counted per
 *     expiry in `ivMissing`, for the reason `dexMissing` exists.
 *   - **Units are passed through as Cboe sends them, and the per-contract
 *     `iv` is a fraction.** This was `AS_PUBLISHED_UNVERIFIED` until a live
 *     chain was captured (`test/fixtures/vol.json`, SPY, trade date
 *     2026-10-21): the ATM IV at 30 DTE read 0.1443 while the same payload's
 *     own `iv30` read 14.023 — the same quantity, a factor of 100 apart. So the
 *     points are `ivUnits: 'FRACTION'` and `iv30` is `iv30Units: 'PERCENT'`,
 *     both stated on the payload, and `termStructure.test.ts` holds the
 *     factor of 100 to the fixture so the label cannot outlive the evidence.
 *     Nothing is converted here; the UI multiplies the fraction by 100 once,
 *     at render, and shows a `%` on both.
 *   - **Days to expiry count from the chain's own trade date**, not this
 *     server's clock, for the reason `tradeDate` exists. With no trade date,
 *     `dte` is `null`, and expiries are not filtered by it.
 */

/** One contract's contribution: only what term structure needs. */
export interface IvPoint {
  expiry: string;
  strike: number;
  right: 'C' | 'P';
  /** Cboe's published `iv`, or null where absent or not positive. */
  iv: number | null;
}

export interface TermPoint {
  expiry: string;
  /** Calendar days from the chain's trade date, or null without one. */
  dte: number | null;
  /** The strike nearest spot with both a call and a put IV, or null. */
  atmStrike: number | null;
  /** (atmStrike - spot) / spot, as a fraction. */
  distancePct: number | null;
  callIv: number | null;
  putIv: number | null;
  /** Mean of the two, only when both exist. */
  atmIv: number | null;
  /** Contracts at this expiry whose `iv` was absent or not positive. */
  ivMissing: number;
  contracts: number;
}

export interface TermStructure {
  points: TermPoint[];
  /** Per-contract Cboe `iv` is a fraction: 0.1443 is 14.43%. See the header. */
  ivUnits: 'FRACTION';
  /** Cboe's `iv30` on the same payload is already a percentage: 14.023. */
  iv30Units: 'PERCENT';
  basis: string;
}

export const IV_RANK_UNAVAILABLE =
  'Not reported. IV rank and IV percentile compare today\'s IV with a trailing ' +
  'history (conventionally a year of daily readings), and this deployment holds ' +
  'none. Accumulating one from this chain would mean persisting Cboe\'s data, ' +
  'which the rights registry refuses: CBOE_CDN_DELAYED_CHAIN is UNVERIFIED for ' +
  'PERSIST. An in-memory history would not survive the restarts this host makes ' +
  'every idle quarter-hour, so any rank computed from it would describe an ' +
  'afternoon under the name of a year.';

const TERM_BASIS =
  'Per expiry, the strike nearest spot that carries both a call and a put IV; ' +
  'the IVs are Cboe\'s published per-contract values under Cboe\'s model, not ' +
  'recomputed here. The per-contract IVs are fractions (0.1443 is 14.43%) and ' +
  'iv30 is a percentage, as Cboe publishes both; the factor of 100 between them ' +
  'was read off a captured SPY chain (trade date 2026-10-21), not assumed.';

const DAY_MS = 86_400_000;

/** Whole calendar days between two YYYY-MM-DD dates, or null if either is unreadable. */
export function calendarDays(from: string, to: string): number | null {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / DAY_MS);
}

/** A positive IV, or null. Zero and negatives are an unquoted row, not a reading. */
export function ivOrNull(v: number | null | undefined): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
}

/** The term structure of one chain. Pure, so every rule above is drivable. */
export function termStructureOf(
  points: IvPoint[],
  spot: number,
  tradeDate: string | null,
): TermStructure {
  const byExpiry = new Map<string, IvPoint[]>();
  for (const p of points) {
    const list = byExpiry.get(p.expiry);
    if (list) list.push(p); else byExpiry.set(p.expiry, [p]);
  }

  const out: TermPoint[] = [];
  for (const [expiry, list] of byExpiry) {
    const dte = tradeDate === null ? null : calendarDays(tradeDate, expiry);
    // An expiry before the chain's own date is not on the curve.
    if (dte !== null && dte < 0) continue;

    const calls = new Map<number, number>();
    const puts = new Map<number, number>();
    let ivMissing = 0;
    for (const p of list) {
      const iv = ivOrNull(p.iv);
      if (iv === null) { ivMissing++; continue; }
      (p.right === 'C' ? calls : puts).set(p.strike, iv);
    }

    let atm: number | null = null;
    for (const k of calls.keys()) {
      if (!puts.has(k)) continue;
      if (atm === null) { atm = k; continue; }
      const d = Math.abs(k - spot);
      const best = Math.abs(atm - spot);
      if (d < best || (d === best && k < atm)) atm = k;
    }

    const callIv = atm === null ? null : calls.get(atm) ?? null;
    const putIv = atm === null ? null : puts.get(atm) ?? null;
    out.push({
      expiry,
      dte,
      atmStrike: atm,
      distancePct: atm === null || !(spot > 0) ? null : (atm - spot) / spot,
      callIv,
      putIv,
      atmIv: callIv !== null && putIv !== null ? (callIv + putIv) / 2 : null,
      ivMissing,
      contracts: list.length,
    });
  }

  out.sort((a, b) => (a.expiry < b.expiry ? -1 : a.expiry > b.expiry ? 1 : 0));
  return { points: out, ivUnits: 'FRACTION', iv30Units: 'PERCENT', basis: TERM_BASIS };
}
