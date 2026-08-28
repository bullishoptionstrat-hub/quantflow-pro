/**
 * Volatility metrics from stored history.
 *
 * Every function here refuses to answer rather than extrapolate. IV rank over
 * 3 days of history is not an IV rank, so a minimum sample is enforced and the
 * result says how much history it actually had.
 */

export interface IvObservation {
  /** ISO date. */
  date: string;
  iv: number;
}

export type IvMetricStatus = 'ok' | 'insufficient_history';

export interface IvRankResult {
  status: IvMetricStatus;
  /** 0–100. null when status !== 'ok' — never a filled-in guess. */
  ivRank: number | null;
  ivPercentile: number | null;
  current: number;
  low: number | null;
  high: number | null;
  /** How many observations actually backed this, and over what span. */
  observationCount: number;
  spanDays: number;
  requiredObservations: number;
}

/**
 * A 52-week metric needs enough of the 52 weeks to mean anything. 60 trading
 * observations ≈ 3 months, the minimum at which a rank is arguably informative.
 */
export const MIN_IV_OBSERVATIONS = 60;

/**
 * IV Rank  = (current − low) / (high − low)      — where in the range we sit
 * IV Pctl  = fraction of observations below current — how often it was lower
 * They are different numbers and are reported separately, never conflated.
 */
export function computeIvRank(
  observations: readonly IvObservation[],
  current: number,
  minObservations: number = MIN_IV_OBSERVATIONS,
): IvRankResult {
  const count = observations.length;
  const spanDays = spanInDays(observations);

  if (count < minObservations) {
    return {
      status: 'insufficient_history',
      ivRank: null,
      ivPercentile: null,
      current,
      low: null,
      high: null,
      observationCount: count,
      spanDays,
      requiredObservations: minObservations,
    };
  }

  const ivs = observations.map((o) => o.iv);
  const low = Math.min(...ivs);
  const high = Math.max(...ivs);

  // A flat range would divide by zero. Report rank 0 with the range shown
  // rather than NaN or a fabricated midpoint.
  const range = high - low;
  const ivRank = range === 0 ? 0 : ((current - low) / range) * 100;
  const below = ivs.filter((v) => v < current).length;
  const ivPercentile = (below / count) * 100;

  return {
    status: 'ok',
    ivRank: clamp(round2(ivRank), 0, 100),
    ivPercentile: clamp(round2(ivPercentile), 0, 100),
    current,
    low,
    high,
    observationCount: count,
    spanDays,
    requiredObservations: minObservations,
  };
}

export interface TermPoint {
  /** Days to expiry. */
  dte: number;
  iv: number;
}

export type TermStructureShape = 'contango' | 'backwardation' | 'flat' | 'mixed' | 'unknown';

export interface TermStructureResult {
  shape: TermStructureShape;
  points: readonly TermPoint[];
  /** Slope between the nearest and furthest point, IV per day. */
  slope: number | null;
  confidence: number;
}

/**
 * Term-structure shape, COMPUTED.
 *
 * The existing `/api/macro/vix` route hardcodes `termStructure: 'contango'`
 * regardless of the actual values (audit). This computes it, and returns
 * 'unknown' rather than guessing when there are too few points.
 */
export function computeTermStructure(
  points: readonly TermPoint[],
  flatThreshold = 0.005,
): TermStructureResult {
  if (points.length < 2) {
    return { shape: 'unknown', points, slope: null, confidence: 0 };
  }

  const sorted = [...points].sort((a, b) => a.dte - b.dte);
  const first = sorted[0]!;
  const last = sorted[sorted.length - 1]!;
  const dteSpan = last.dte - first.dte;
  if (dteSpan <= 0) return { shape: 'unknown', points, slope: null, confidence: 0 };

  const slope = (last.iv - first.iv) / dteSpan;

  // Monotonic in one direction, or genuinely mixed?
  let rising = 0;
  let falling = 0;
  for (let i = 1; i < sorted.length; i++) {
    const d = sorted[i]!.iv - sorted[i - 1]!.iv;
    if (d > flatThreshold) rising++;
    else if (d < -flatThreshold) falling++;
  }

  let shape: TermStructureShape;
  if (Math.abs(last.iv - first.iv) <= flatThreshold) shape = 'flat';
  else if (rising > 0 && falling > 0) shape = 'mixed';
  else if (last.iv > first.iv) shape = 'contango';
  else shape = 'backwardation';

  return {
    shape,
    points: sorted,
    slope,
    // More points ⇒ more confidence, capped.
    confidence: Math.min(1, sorted.length / 5),
  };
}

export interface SkewResult {
  /** Put IV minus call IV at equivalent moneyness. */
  skew: number | null;
  putIv: number | null;
  callIv: number | null;
  status: 'ok' | 'missing_leg';
}

/** 25-delta style skew. Returns `missing_leg` rather than assuming symmetry. */
export function computeSkew(putIv: number | null, callIv: number | null): SkewResult {
  if (putIv === null || callIv === null) {
    return { skew: null, putIv, callIv, status: 'missing_leg' };
  }
  return { skew: round2(putIv - callIv), putIv, callIv, status: 'ok' };
}

function spanInDays(observations: readonly IvObservation[]): number {
  if (observations.length < 2) return 0;
  const times = observations.map((o) => new Date(o.date).getTime()).sort((a, b) => a - b);
  return Math.round((times[times.length - 1]! - times[0]!) / 86_400_000);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
