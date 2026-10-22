/**
 * ROADMAP 5.5 — implied-volatility skew per expiry, from the chain already
 * fetched: the 25-delta risk reversal.
 *
 * **Skew is a reading of one chain**, the same kind of claim as the term
 * structure in `termStructure.ts`. Cboe publishes a per-contract `delta` and
 * a per-contract `iv`, so "the 25-delta put" is a *selection* among rows the
 * vendor sent, not a computation this codebase performs. Nothing is inverted,
 * fitted or interpolated; the pricing model behind both numbers is Cboe's, the
 * same standing `assumptions.greeks` gives `/api/gex`.
 *
 * Decisions, each stated where a reader will meet it:
 *
 *   - **The 25-delta contract is the one whose |delta| is nearest 0.25 and
 *     carries an IV.** Interpolating between the two neighbours would be a
 *     model (linear in delta? in strike? in log-moneyness?) with no basis
 *     chosen here, so the nearest row is taken and **the delta actually
 *     chosen is published beside it**. On a sparse expiry "25Δ" can be 0.31;
 *     the payload says so instead of hiding it behind the label. The same
 *     rule as `distancePct` on the term structure.
 *   - **Ties go to the lower strike**, so the answer cannot depend on row
 *     order. Same rule as ATM.
 *   - **A delta with the wrong sign is missing, not a reading.** A call's
 *     delta is in (0, 1] and a put's in [-1, 0); a call with a negative delta,
 *     or either with |delta| > 1, is a row the vendor did not quote
 *     sensibly, and is counted in `deltaMissing` rather than selected. Zero is
 *     missing for both rights, for the reason `ivOrNull` treats zero IV as
 *     missing: no live option has exactly no directional exposure.
 *   - **The risk reversal is put IV minus call IV**, at those two contracts,
 *     and is `null` unless both exist. One side alone is a point, not a skew.
 *     Sign convention stated so nobody has to guess: positive means puts are
 *     bid over calls — the ordinary equity-index state. `riskReversalPct` is
 *     the same number ×100 for a reader who thinks in vol points; both are
 *     published so a renderer converts nothing.
 *   - **Units are the term structure's.** `ivUnits: 'FRACTION'`, settled on a
 *     captured chain (see `termStructure.ts`). Delta is dimensionless.
 *   - **Days to expiry count from the chain's own trade date**, and an expiry
 *     before it is not on the curve. Same rule as `termStructureOf`.
 */
import { calendarDays, ivOrNull } from './termStructure';

/** One contract's contribution: only what skew needs. */
export interface SkewInput {
  expiry: string;
  strike: number;
  right: 'C' | 'P';
  /** Cboe's published `iv`, or null where absent or not positive. */
  iv: number | null;
  /** Cboe's published `delta`, or null where absent. Sign is the vendor's. */
  delta: number | null;
}

/** One side of the risk reversal: the contract chosen and what it carried. */
export interface SkewLeg {
  strike: number;
  /** The delta the vendor published on the chosen row — not 0.25 by fiat. */
  delta: number;
  iv: number;
}

export interface SkewPoint {
  expiry: string;
  /** Calendar days from the chain's trade date, or null without one. */
  dte: number | null;
  put: SkewLeg | null;
  call: SkewLeg | null;
  /** put.iv - call.iv, as a fraction, only when both legs exist. */
  riskReversal: number | null;
  /** The same, in vol points (×100). */
  riskReversalPct: number | null;
  /** Rows at this expiry with no IV (zero or absent). */
  ivMissing: number;
  /** Rows at this expiry with no usable delta (absent, zero, wrong sign, |δ|>1). */
  deltaMissing: number;
  contracts: number;
}

export interface Skew {
  /** The target |delta|, stated so the label and the selection agree. */
  targetDelta: 0.25;
  points: SkewPoint[];
  ivUnits: 'FRACTION';
  basis: string;
}

export const SKEW_BASIS =
  'Per expiry, the put and the call whose published |delta| is nearest 0.25 ' +
  'and that carry an IV; the delta actually chosen is published beside each. ' +
  'Nothing is interpolated. Risk reversal is put IV minus call IV at those two ' +
  'contracts: positive means puts are bid over calls. IVs and deltas are ' +
  'Cboe\'s per-contract values under Cboe\'s model, not recomputed here.';

export const TARGET_DELTA = 0.25;

/** A usable delta for the right, or null. Sign and magnitude are both checked. */
export function deltaOrNull(right: 'C' | 'P', v: number | null | undefined): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v) || v === 0 || Math.abs(v) > 1) return null;
  if (right === 'C' && v < 0) return null;
  if (right === 'P' && v > 0) return null;
  return v;
}

/** The skew of one chain. Pure, so every rule above is drivable. */
export function skewOf(inputs: SkewInput[], tradeDate: string | null): Skew {
  const byExpiry = new Map<string, SkewInput[]>();
  for (const p of inputs) {
    const list = byExpiry.get(p.expiry);
    if (list) list.push(p); else byExpiry.set(p.expiry, [p]);
  }

  const out: SkewPoint[] = [];
  for (const [expiry, list] of byExpiry) {
    const dte = tradeDate === null ? null : calendarDays(tradeDate, expiry);
    if (dte !== null && dte < 0) continue;

    let ivMissing = 0;
    let deltaMissing = 0;
    let put: SkewLeg | null = null;
    let call: SkewLeg | null = null;

    for (const p of list) {
      const iv = ivOrNull(p.iv);
      if (iv === null) ivMissing++;
      const delta = deltaOrNull(p.right, p.delta);
      if (delta === null) deltaMissing++;
      if (iv === null || delta === null) continue;

      const leg: SkewLeg = { strike: p.strike, delta, iv };
      const current = p.right === 'C' ? call : put;
      if (current === null || closer(leg, current)) {
        if (p.right === 'C') call = leg; else put = leg;
      }
    }

    const rr = put !== null && call !== null ? put.iv - call.iv : null;
    out.push({
      expiry, dte, put, call,
      riskReversal: rr,
      riskReversalPct: rr === null ? null : rr * 100,
      ivMissing, deltaMissing, contracts: list.length,
    });
  }

  out.sort((a, b) => (a.expiry < b.expiry ? -1 : a.expiry > b.expiry ? 1 : 0));
  return { targetDelta: TARGET_DELTA, points: out, ivUnits: 'FRACTION', basis: SKEW_BASIS };
}

/** Nearer to the target |delta|; on a tie, the lower strike. */
function closer(a: SkewLeg, b: SkewLeg): boolean {
  const da = Math.abs(Math.abs(a.delta) - TARGET_DELTA);
  const db = Math.abs(Math.abs(b.delta) - TARGET_DELTA);
  if (da !== db) return da < db;
  return a.strike < b.strike;
}
