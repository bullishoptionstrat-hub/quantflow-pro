/**
 * Gamma exposure from a real option-chain snapshot.
 *
 * REPLACES nothing yet — this is the honest calculation that the synthetic
 * generator in `ingestion/index.ts` will be swapped for once a chain snapshot
 * source is reachable. It computes ONLY from supplied inputs and never invents
 * a strike, an open interest, or a gamma.
 *
 * ─── SIGN CONVENTION (stated explicitly, and unit-tested) ───────────────────
 *
 * The standard dealer-positioning convention, and the one used here:
 *
 *   callGEX = +callOI × gamma × 100 × S²  × 0.01
 *   putGEX  = -putOI  × gamma × 100 × S²  × 0.01
 *   netGEX  = callGEX + putGEX
 *
 * Why the signs: the convention ASSUMES dealers are net long calls and net
 * short puts (customers buy calls, buy puts for protection ⇒ dealers are short
 * those puts). Positive net GEX ⇒ dealers hedge AGAINST price moves (sell
 * rallies, buy dips) ⇒ suppressed volatility. Negative ⇒ they hedge WITH moves
 * ⇒ amplified volatility.
 *
 * THIS IS AN ASSUMPTION, NOT AN OBSERVATION. Actual dealer inventory is not
 * public. Every result therefore carries `model_assumptions` naming it, and is
 * marked inferred. Nothing here may be presented as measured dealer positioning.
 *
 * ─── UNITS ──────────────────────────────────────────────────────────────────
 *
 * × 100   — the contract multiplier (100 shares per option). The pre-existing
 *           `frontend/lib/blackScholes.ts:computeGEX` OMITS this, making its
 *           output 100× too small. Fixed there; correct here from the start.
 * × S²    — converts per-share gamma into dollar gamma per unit move.
 * × 0.01  — expresses the result per 1% move in the underlying.
 *
 * Result unit: dollars of dealer delta change per 1% move in the underlying.
 */

export interface ChainStrikeSnapshot {
  strike: number;
  /** Open interest. Required — never defaulted, because 0 and unknown differ. */
  callOI: number;
  putOI: number;
  /**
   * Per-share gamma. Under Black-Scholes a call and a put at the same strike
   * and expiry have IDENTICAL gamma, so one value is correct — but both are
   * accepted for providers that supply them separately.
   */
  callGamma: number;
  putGamma: number;
}

export interface GexInputs {
  symbol: string;
  spotPrice: number;
  strikes: readonly ChainStrikeSnapshot[];
  /** ISO timestamp of the chain snapshot these came from. */
  snapshotAt: string;
}

export interface GexStrikeResult {
  strike: number;
  callGex: number;
  putGex: number;
  netGex: number;
  levelType: 'SUPPORT' | 'RESISTANCE' | 'NEUTRAL';
}

export type GexQualityFlag =
  | 'ZERO_OPEN_INTEREST'
  | 'ZERO_GAMMA'
  | 'SPARSE_CHAIN'
  | 'ASYMMETRIC_GAMMA'
  | 'SPOT_OUTSIDE_STRIKE_RANGE';

export interface GexResult {
  symbol: string;
  spotPrice: number;
  snapshotAt: string;
  strikes: GexStrikeResult[];
  totalGex: number;
  /** Strike where cumulative net GEX crosses zero. null when it never does. */
  gammaFlip: number | null;
  callWall: number | null;
  putWall: number | null;

  /** What was actually measured. */
  observed_inputs: {
    strikeCount: number;
    totalCallOI: number;
    totalPutOI: number;
    spotPrice: number;
    snapshotAt: string;
  };
  /** What was assumed. Never hidden. */
  model_assumptions: readonly string[];
  /** 0–1. Degraded by sparse chains, zero OI, missing gamma. */
  confidence: number;
  quality_flags: GexQualityFlag[];
  calculation_version: string;
}

export const GEX_CALCULATION_VERSION = 'gex-v1';

/** The contract multiplier. Named, so it cannot be dropped silently again. */
export const CONTRACT_MULTIPLIER = 100;

/** Fewer strikes than this and the flip/wall estimates are not meaningful. */
export const MIN_STRIKES_FOR_CONFIDENCE = 10;

const ASSUMPTIONS: readonly string[] = [
  'Dealers are assumed net LONG calls and net SHORT puts. Actual dealer inventory is not public.',
  'Open interest is assumed to represent current dealer-facing exposure; it does not distinguish opening from closing trades.',
  'Gamma is taken from the provider chain snapshot and assumed to be per-share Black-Scholes gamma.',
  'Result is expressed per 1% move in the underlying, using the contract multiplier of 100.',
  'A gamma flip computed from a sparse or stale chain may not correspond to any real inflection.',
];

export function computeGex(inputs: GexInputs): GexResult {
  const { symbol, spotPrice, strikes, snapshotAt } = inputs;
  const flags: GexQualityFlag[] = [];

  if (strikes.length < MIN_STRIKES_FOR_CONFIDENCE) flags.push('SPARSE_CHAIN');

  const totalCallOI = strikes.reduce((s, k) => s + k.callOI, 0);
  const totalPutOI = strikes.reduce((s, k) => s + k.putOI, 0);
  if (totalCallOI === 0 && totalPutOI === 0) flags.push('ZERO_OPEN_INTEREST');
  if (strikes.every((k) => k.callGamma === 0 && k.putGamma === 0)) flags.push('ZERO_GAMMA');

  // Call and put gamma should match under Black-Scholes; a large divergence
  // means the provider is supplying something other than BS gamma.
  if (
    strikes.some(
      (k) =>
        k.callGamma > 0 &&
        k.putGamma > 0 &&
        Math.abs(k.callGamma - k.putGamma) / Math.max(k.callGamma, k.putGamma) > 0.1,
    )
  ) {
    flags.push('ASYMMETRIC_GAMMA');
  }

  const sorted = [...strikes].sort((a, b) => a.strike - b.strike);
  if (sorted.length > 0) {
    const lo = sorted[0]!.strike;
    const hi = sorted[sorted.length - 1]!.strike;
    if (spotPrice < lo || spotPrice > hi) flags.push('SPOT_OUTSIDE_STRIKE_RANGE');
  }

  const scale = CONTRACT_MULTIPLIER * spotPrice * spotPrice * 0.01;

  const results: GexStrikeResult[] = sorted.map((k) => {
    // Sign convention, stated above and asserted in tests:
    // `normalizeZero` exists because `-0 * x` is `-0`, which is not
    // strictly equal to 0 and would surprise any downstream Object.is or
    // strict comparison. A negative zero is never meaningful here.
    const callGex = normalizeZero(+k.callOI * k.callGamma * scale);
    const putGex = normalizeZero(-k.putOI * k.putGamma * scale);
    const netGex = normalizeZero(callGex + putGex);
    return {
      strike: k.strike,
      callGex,
      putGex,
      netGex,
      levelType: netGex > 0 ? 'SUPPORT' : netGex < 0 ? 'RESISTANCE' : 'NEUTRAL',
    };
  });

  const totalGex = normalizeZero(results.reduce((s, r) => s + r.netGex, 0));

  // Gamma flip: the strike where cumulative net GEX changes sign.
  let gammaFlip: number | null = null;
  let cumulative = 0;
  let previousCumulative = 0;
  for (const r of results) {
    previousCumulative = cumulative;
    cumulative += r.netGex;
    if (previousCumulative !== 0 && Math.sign(previousCumulative) !== Math.sign(cumulative)) {
      gammaFlip = r.strike;
      break;
    }
  }

  // Walls: the single largest positive call GEX and most negative put GEX.
  const callWall =
    results.length === 0
      ? null
      : results.reduce((best, r) => (r.callGex > best.callGex ? r : best), results[0]!).strike;
  const putWall =
    results.length === 0
      ? null
      : results.reduce((best, r) => (r.putGex < best.putGex ? r : best), results[0]!).strike;

  return {
    symbol,
    spotPrice,
    snapshotAt,
    strikes: results,
    totalGex,
    gammaFlip,
    callWall,
    putWall,
    observed_inputs: {
      strikeCount: strikes.length,
      totalCallOI,
      totalPutOI,
      spotPrice,
      snapshotAt,
    },
    model_assumptions: ASSUMPTIONS,
    confidence: confidenceFor(flags, strikes.length),
    quality_flags: flags,
    calculation_version: GEX_CALCULATION_VERSION,
  };
}

/** Collapses -0 to 0. See the call site for why this matters. */
function normalizeZero(n: number): number {
  return n === 0 ? 0 : n;
}

/** Pessimistic: any quality problem reduces confidence, and zero inputs floor it. */
export function confidenceFor(flags: readonly GexQualityFlag[], strikeCount: number): number {
  if (flags.includes('ZERO_OPEN_INTEREST') || flags.includes('ZERO_GAMMA')) return 0;
  let c = 1;
  if (flags.includes('SPARSE_CHAIN')) c -= 0.4;
  if (flags.includes('ASYMMETRIC_GAMMA')) c -= 0.2;
  if (flags.includes('SPOT_OUTSIDE_STRIKE_RANGE')) c -= 0.3;
  if (strikeCount < 5) c -= 0.2;
  return Math.max(0, Math.round(c * 100) / 100);
}
