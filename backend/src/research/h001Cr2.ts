/**
 * H-001-v2 §D's cross-check, as code: a CR2 cluster-robust interval for Δ_AC
 * with trading days as clusters. §D: "It decides nothing." Nothing in
 * `h001Verdict.ts` reads it, and a test holds that — a cross-check that could
 * move the verdict would be a second primary analysis nobody preregistered.
 *
 * Δ_AC is a pooled mean, so the model is intercept-only: d_i = β + e_i, with β̂
 * the mean of the matched differences — the same sum-over-count the bootstrap
 * resamples. For that model the CR2 (Bell–McCaffrey) adjustment has a closed
 * form, derived here so it can be checked rather than trusted:
 *
 *   X_g = 1 (n_g × 1),  (X'X)⁻¹ = 1/N,  H_gg = J_{n_g} / N.
 *   I − H_gg has eigenvalue 1 − n_g/N on the vector 1 and 1 on its orthogonal
 *   complement, so A_g = (I − H_gg)^(-1/2) maps 1 to 1/√(1 − n_g/N) · 1, and
 *   X_g' A_g e_g = S_g / √(1 − n_g/N), where S_g is the day's residual sum.
 *
 *   V_CR2 = (1/N²) · Σ_g S_g² / (1 − n_g/N)
 *
 * Two identities the tests hold it to, both independent of the derivation:
 * with one observation per day it is s²/N, the textbook variance of a mean;
 * with equal-sized days it is G/(G−1) times the unadjusted CR0.
 *
 * Readings, each also in research/README.md:
 *
 *   R6  The critical value is Student t with Bell–McCaffrey (Satterthwaite)
 *       degrees of freedom under a homoskedastic working model — the pairing
 *       Imbens & Kolesár (2016) recommend for CR2. §D names the variance
 *       estimator and no reference distribution. For equal-sized days the
 *       degrees of freedom are exactly G − 1, the common alternative; they
 *       fall below it as days become unequal, which widens the interval. The
 *       value used is reported, so a reader preferring G − 1 can see the gap.
 *   R7  Fewer than two days gives no interval: one cluster has no
 *       between-cluster variation to estimate (the adjustment divides by
 *       zero), the same floor the bootstrap applies.
 */
import type { Interval, Observation } from './h001Verdict';

export interface H001Cr2Result {
  estimateBp: number | null;
  seBp: number | null;
  /** R6: Bell–McCaffrey degrees of freedom. */
  df: number | null;
  ci95: Interval | null;
  n: { observations: number; days: number };
  /** Says, on the payload, that this number moves nothing. */
  decides: false;
}

// ─── Student t, from the regularized incomplete beta ────────────────────────

function logGamma(x: number): number {
  // Lanczos, g = 7, n = 9: ~15 significant digits for x > 0.
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
    1.5056327351493116e-7,
  ];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  x -= 1;
  let a = c[0]!;
  const t = x + 7.5;
  for (let i = 1; i < 9; i++) a += c[i]! / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

/** Continued fraction for the incomplete beta (modified Lentz). */
function betaContinuedFraction(a: number, b: number, x: number): number {
  const TINY = 1e-300;
  let c = 1;
  let d = 1 - ((a + b) * x) / (a + 1);
  if (Math.abs(d) < TINY) d = TINY;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 300; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((a + m2 - 1) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c; if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d; h *= d * c;
    aa = (-(a + m) * (a + b + m) * x) / ((a + m2) * (a + m2 + 1));
    d = 1 + aa * d; if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c; if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-15) return h;
  }
  throw new RangeError('incomplete beta did not converge');
}

/** I_x(a, b). */
export function regularizedBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2)
    ? (front * betaContinuedFraction(a, b, x)) / a
    : 1 - (front * betaContinuedFraction(b, a, 1 - x)) / b;
}

/** P(T ≤ t) for Student t with `df` degrees of freedom (df > 0, not necessarily whole). */
export function studentTCdf(t: number, df: number): number {
  if (!(df > 0)) throw new RangeError(`degrees of freedom must be positive, got ${df}`);
  const tail = 0.5 * regularizedBeta(df / (df + t * t), df / 2, 0.5);
  return t >= 0 ? 1 - tail : tail;
}

/** The p-quantile of Student t, by bisection on the CDF. */
export function studentTQuantile(p: number, df: number): number {
  if (!(p > 0 && p < 1)) throw new RangeError(`p must be in (0, 1), got ${p}`);
  if (p === 0.5) return 0;
  if (p < 0.5) return -studentTQuantile(1 - p, df);
  let lo = 0;
  let hi = 1;
  while (studentTCdf(hi, df) < p) hi *= 2;
  for (let i = 0; i < 200 && hi - lo > 1e-12 * Math.max(1, hi); i++) {
    const mid = (lo + hi) / 2;
    if (studentTCdf(mid, df) < p) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

// ─── CR2 ─────────────────────────────────────────────────────────────────────

/**
 * Bell–McCaffrey degrees of freedom for the intercept-only CR2 variance, under
 * a homoskedastic working model: (tr Q)² / tr(Q²), where Q is the G × G Gram
 * matrix of the variance's quadratic form. Scaled by N it has p_g = n_g/N on
 * the diagonal and −p_g·p_h / √((1 − p_g)(1 − p_h)) off it, and tr = 1.
 */
function bellMcCaffreyDf(shares: readonly number[]): number {
  let sumSq = 0;
  for (let g = 0; g < shares.length; g++) {
    const pg = shares[g]!;
    sumSq += pg * pg;
    for (let h = 0; h < shares.length; h++) {
      if (h === g) continue;
      const ph = shares[h]!;
      const q = (pg * ph) / Math.sqrt((1 - pg) * (1 - ph));
      sumSq += q * q;
    }
  }
  return 1 / sumSq;
}

export function h001Cr2Interval(obs: readonly Observation[]): H001Cr2Result {
  const days = new Map<string, number[]>();
  for (const o of obs) {
    if (!Number.isFinite(o.valueBp)) throw new RangeError(`a non-finite observation on ${o.date}`);
    const xs = days.get(o.date) ?? [];
    xs.push(o.valueBp);
    days.set(o.date, xs);
  }
  const N = obs.length;
  const n = { observations: N, days: days.size };
  const none = { seBp: null, df: null, ci95: null, n, decides: false as const };
  if (N === 0) return { estimateBp: null, ...none };
  // Days in date order and values sorted within each, so floating-point
  // rounding — and with it the reported bytes — does not depend on input order.
  const clusters = [...days.keys()].sort().map((k) => days.get(k)!.sort((x, y) => x - y));
  let total = 0;
  for (const xs of clusters) for (const x of xs) total += x;
  const estimateBp = total / N;
  if (days.size < 2) return { estimateBp, ...none };

  let v = 0;
  const shares: number[] = [];
  for (const xs of clusters) {
    const p = xs.length / N;
    const s = xs.reduce((acc, x) => acc + (x - estimateBp), 0);
    v += (s * s) / (1 - p);
    shares.push(p);
  }
  v /= N * N;
  const seBp = Math.sqrt(v);
  const df = bellMcCaffreyDf(shares);
  const t = studentTQuantile(0.975, df);
  return { estimateBp, seBp, df, ci95: { lo: estimateBp - t * seBp, hi: estimateBp + t * seBp }, n, decides: false };
}
