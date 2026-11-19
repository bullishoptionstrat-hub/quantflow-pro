/**
 * OVERFITTING STATISTICS — the Probability of Backtest Overfitting by
 * combinatorially symmetric cross-validation (CSCV), and the Probabilistic and
 * Deflated Sharpe Ratios. Pure and clock-free; nothing here reads data.
 *
 * **PBO / CSCV.** Bailey, Borwein, López de Prado & Zhu, "The Probability of
 * Backtest Overfitting", J. Computational Finance 20(4), 2017 (SSRN 2326253),
 * §2. Input M is T rows (time) × N columns (configurations). Rows are split
 * into S contiguous, equal blocks (S even; T divisible by S — a remainder is
 * refused, never dropped). For each of the C(S, S/2) choices of S/2 blocks as
 * the in-sample set J (the rest J̄ out of sample):
 *   n*  = argmax over columns of metric(J)     (ties: the lowest column index)
 *   ω̄  = rank of n* in metric(J̄) / (N + 1)    (rank 1 = worst; ties averaged)
 *   λ   = ln(ω̄ / (1 − ω̄))
 *   PBO = share of combinations with λ ≤ 0.
 * λ = 0 (the chosen configuration lands exactly at the out-of-sample median)
 * counts as overfit: the conservative reading of "not better than median".
 * The metric is supplied by the caller (mean by default) and recorded.
 *
 * Acceptance in docs/MASTER_PLAN.md asks for agreement with the CRAN `pbo`
 * package vignette. CRAN is refused by this environment's network policy and
 * no R is installed, so that comparison has NOT been made; the tests check
 * hand-worked matrices and an independent brute-force implementation.
 *
 * **PSR / DSR.** Bailey & López de Prado, "The Sharpe Ratio Efficient
 * Frontier", J. Risk 15(2), 2012 (PSR), and "The Deflated Sharpe Ratio",
 * J. Portfolio Management 40(5), 2014 (DSR), eqs. as follows, with SR, T,
 * skew γ3 and (non-excess) kurtosis γ4 all per-period, never annualized:
 *   PSR(SR*) = Φ( (SR − SR*) √(T − 1) / √(1 − γ3·SR + (γ4 − 1)/4 · SR²) )
 *   SR*_0    = √V · ( (1 − γ)·Φ⁻¹(1 − 1/N) + γ·Φ⁻¹(1 − 1/(N·e)) )
 *   DSR      = PSR(SR*_0)
 * where N is the number of independent trials, V the variance of the trials'
 * Sharpe ratios and γ the Euler–Mascheroni constant. N must be at least 2.
 * Φ uses a rational erfc with fractional error below 1.2e-7 (Numerical
 * Recipes `erfcc`); Φ⁻¹ uses Acklam's algorithm with one Halley step.
 */

export const OVERFITTING_VERSION = 'overfitting/1';
const EULER_GAMMA = 0.5772156649015329;

function erfc(x: number): number {
  const z = Math.abs(x);
  const t = 1 / (1 + 0.5 * z);
  const r = t * Math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 +
    t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
  return x >= 0 ? r : 2 - r;
}

export function normalCdf(x: number): number {
  return 0.5 * erfc(-x / Math.SQRT2);
}

export function normalInv(p: number): number {
  if (!(p > 0 && p < 1)) throw new Error(`normalInv: p must be in (0, 1), got ${p}`);
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const lo = 0.02425;
  let x: number;
  if (p < lo) {
    const q = Math.sqrt(-2 * Math.log(p));
    x = (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  } else if (p > 1 - lo) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    x = -(((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  } else {
    const q = p - 0.5;
    const r = q * q;
    x = (((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q /
      (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1);
  }
  const e = normalCdf(x) - p;
  const u = e * Math.sqrt(2 * Math.PI) * Math.exp((x * x) / 2);
  return x - u / (1 + (x * u) / 2);
}

export type Metric = (column: readonly number[]) => number;
export const meanMetric: Metric = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

export type PboResult =
  | { status: 'OK'; version: string; pbo: number; combinations: number; lambdas: number[]; S: number; T: number; N: number }
  | { status: 'REFUSED'; reasons: string[] };

function combinations(n: number, k: number): number[][] {
  const out: number[][] = [];
  const rec = (start: number, acc: number[]) => {
    if (acc.length === k) { out.push([...acc]); return; }
    for (let i = start; i < n; i++) { acc.push(i); rec(i + 1, acc); acc.pop(); }
  };
  rec(0, []);
  return out;
}

/** Rank (1 = smallest) of values[idx], ties given their average rank. */
function averageRank(values: readonly number[], idx: number): number {
  const v = values[idx]!;
  let below = 0;
  let equal = 0;
  for (const x of values) { if (x < v) below++; else if (x === v) equal++; }
  return below + (equal + 1) / 2;
}

export function pboCscv(matrix: readonly (readonly number[])[], S: number, metric: Metric = meanMetric): PboResult {
  const reasons: string[] = [];
  const T = matrix.length;
  const N = T > 0 ? matrix[0]!.length : 0;
  if (!Number.isInteger(S) || S < 2 || S % 2 !== 0) reasons.push(`S must be an even integer >= 2, got ${S}`);
  if (S > 16) reasons.push(`S must be at most 16 (C(S, S/2) combinations), got ${S}`);
  if (T === 0) reasons.push('matrix has no rows');
  if (N < 2) reasons.push('matrix needs at least two configurations (columns)');
  if (T > 0 && Number.isInteger(S) && S > 0 && T % S !== 0) reasons.push(`T=${T} rows is not divisible by S=${S}; rows are refused, never dropped`);
  for (let r = 0; r < T; r++) {
    const row = matrix[r]!;
    if (row.length !== N) { reasons.push(`row ${r} has ${row.length} columns, expected ${N}`); continue; }
    if (!row.every((x) => typeof x === 'number' && Number.isFinite(x))) reasons.push(`row ${r} holds a non-finite value`);
  }
  if (reasons.length > 0) return { status: 'REFUSED', reasons };
  const blockLen = T / S;
  const cols = (rows: number[]) => Array.from({ length: N }, (_, j) => metric(rows.map((r) => matrix[r]![j]!)));
  const rowsOf = (blocks: number[]) => blocks.flatMap((b) => Array.from({ length: blockLen }, (_, i) => b * blockLen + i));
  const lambdas: number[] = [];
  for (const J of combinations(S, S / 2)) {
    const Jbar = Array.from({ length: S }, (_, i) => i).filter((i) => !J.includes(i));
    const ins = cols(rowsOf(J));
    const oos = cols(rowsOf(Jbar));
    if (!ins.every(Number.isFinite) || !oos.every(Number.isFinite)) return { status: 'REFUSED', reasons: ['metric returned a non-finite value'] };
    let best = 0;
    for (let j = 1; j < N; j++) if (ins[j]! > ins[best]!) best = j;
    const w = averageRank(oos, best) / (N + 1);
    lambdas.push(Math.log(w / (1 - w)));
  }
  const overfit = lambdas.filter((l) => l <= 0).length;
  return { status: 'OK', version: OVERFITTING_VERSION, pbo: overfit / lambdas.length, combinations: lambdas.length, lambdas, S, T, N };
}

export interface SharpeInput {
  /** Observed per-period Sharpe ratio (not annualized). */
  sr: number;
  /** Number of return observations. */
  T: number;
  /** Skewness of returns. */
  skew: number;
  /** Kurtosis of returns, NOT excess (normal = 3). */
  kurtosis: number;
}

export type StatResult = { status: 'OK'; value: number } | { status: 'REFUSED'; reasons: string[] };

function sharpeRefusals(i: SharpeInput): string[] {
  const out: string[] = [];
  for (const k of ['sr', 'T', 'skew', 'kurtosis'] as const) if (!Number.isFinite(i[k])) out.push(`${k} is not finite`);
  if (out.length) return out;
  if (!Number.isInteger(i.T) || i.T < 2) out.push('T must be an integer >= 2');
  if (i.kurtosis < 1) out.push('kurtosis must be >= 1 (non-excess)');
  const v = 1 - i.skew * i.sr + ((i.kurtosis - 1) / 4) * i.sr * i.sr;
  if (!(v > 0)) out.push('the variance term 1 − γ3·SR + (γ4 − 1)/4·SR² is not positive');
  return out;
}

export function probabilisticSharpe(i: SharpeInput, srBenchmark: number): StatResult {
  const reasons = sharpeRefusals(i);
  if (!Number.isFinite(srBenchmark)) reasons.push('benchmark SR is not finite');
  if (reasons.length) return { status: 'REFUSED', reasons };
  const den = Math.sqrt(1 - i.skew * i.sr + ((i.kurtosis - 1) / 4) * i.sr * i.sr);
  return { status: 'OK', value: normalCdf(((i.sr - srBenchmark) * Math.sqrt(i.T - 1)) / den) };
}

/** Expected maximum Sharpe ratio of N independent trials with SR variance V, under the null. */
export function expectedMaxSharpe(trials: number, srVariance: number): StatResult {
  const reasons: string[] = [];
  if (!Number.isInteger(trials) || trials < 2) reasons.push('trials must be an integer >= 2');
  if (!(Number.isFinite(srVariance) && srVariance >= 0)) reasons.push('srVariance must be finite and non-negative');
  if (reasons.length) return { status: 'REFUSED', reasons };
  const v = Math.sqrt(srVariance) * ((1 - EULER_GAMMA) * normalInv(1 - 1 / trials) + EULER_GAMMA * normalInv(1 - 1 / (trials * Math.E)));
  return { status: 'OK', value: v };
}

export function deflatedSharpe(i: SharpeInput, trials: number, srVariance: number): StatResult & { srStar?: number } {
  const star = expectedMaxSharpe(trials, srVariance);
  if (star.status !== 'OK') return star;
  const p = probabilisticSharpe(i, star.value);
  return p.status === 'OK' ? { ...p, srStar: star.value } : p;
}
