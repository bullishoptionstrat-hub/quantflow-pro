/**
 * H-001-v2 §D, §E, §F and §K as code: from measured differences to a verdict.
 *
 * This is the part of a study most often written after the result is known —
 * which interval, which bootstrap, which tie-break turns "almost" into
 * "supported". Writing it before any data exists is the protection. Every
 * number below is the hypothesis file's; every place the file left a reading
 * open is stated here and in `research/README.md`, so a reader can disagree
 * with a named choice instead of discovering an unnamed one.
 *
 * The computation, in order:
 *
 *   1. Δ_AC = mean of d_i = r_A − r̄_C over A meta-events (§C), in bp.
 *   2. 95% and 90% intervals from a day-clustered bootstrap: resample trading
 *      days with replacement, 10,000 replicates, seed 20260927, percentile
 *      intervals (§D).
 *   3. DESCRIPTIVE if more than 20% of A meta-events had no exact control
 *      match (§G) or the 95% half-width exceeds δ/2 = 1.5 bp (§E). No support
 *      or equivalence claim is made from a DESCRIPTIVE study, so nothing below
 *      runs on one except the reporting.
 *   4. FRAGILE if the weekly block bootstrap disagrees with the daily one
 *      about whether zero is excluded, or — when the daily interval excludes
 *      zero — if dropping any single day brings zero back in (§D).
 *   5. The §F table: excludes zero above → SUPPORTED, subject to every §K
 *      condition; excludes zero below → CONTRARY; includes zero with the 90%
 *      interval inside (−1, +1) bp → PRACTICALLY NEGLIGIBLE; otherwise
 *      NOT SUPPORTED, which is not "proven false".
 *   6. §K: no truth set for aggressor classification → the strongest verdict
 *      available is INCONCLUSIVE.
 *
 * Readings this module had to make (each also in research/README.md):
 *
 *   R1  Percentile = type-7 linear interpolation between order statistics.
 *       The file says "percentile interval" without naming a quantile rule;
 *       type 7 is the common default, and the choice moves a bound by at most
 *       one replicate's spacing.
 *   R2  §K requires Δ_AB's interval to exclude zero above. When the primary
 *       interval does but Δ_AB's does not, the verdict is NOT SUPPORTED — the
 *       §F row "otherwise" — with the unmet condition named.
 *   R3  Without a truth set, EVERY claim-bearing verdict (SUPPORTED, CONTRARY,
 *       PRACTICALLY NEGLIGIBLE, NOT SUPPORTED, FRAGILE) becomes INCONCLUSIVE,
 *       and the verdict it would have been is kept beside it as
 *       `uncappedVerdict`. "The strongest verdict available is INCONCLUSIVE,
 *       whatever the interval says" is read as covering a negative claim too:
 *       a classifier of unknown accuracy can hide an effect as easily as fake
 *       one. DESCRIPTIVE is not capped; it makes no claim to cap.
 *   R4  Leave-one-day-out re-runs the same bootstrap (same seed) without the
 *       day; the weekly bootstrap clusters by Monday-start calendar week of
 *       the market date.
 *   R5  §D's CR2 cross-check "decides nothing" and is not implemented here; a
 *       report built on this module must add it or say it is absent.
 */

/** §D. */
export const H001_BOOTSTRAP_REPLICATES = 10_000;
export const H001_BOOTSTRAP_SEED = 20260927;
/** §E: δ, the smallest economically meaningful effect, and the precision target δ/2. */
export const H001_DELTA_BP = 3;
export const H001_MAX_HALF_WIDTH_BP = H001_DELTA_BP / 2;
/** §F: the equivalence margin, ±1 bp, a third of δ. */
export const H001_EQUIVALENCE_MARGIN_BP = 1;
/** §G: more than this share of A meta-events unmatched makes the study DESCRIPTIVE. */
export const H001_MAX_UNMATCHED_SHARE = 0.2;

export type H001Verdict =
  | 'SUPPORTED'
  | 'CONTRARY'
  | 'PRACTICALLY NEGLIGIBLE'
  | 'NOT SUPPORTED'
  | 'DESCRIPTIVE'
  | 'FRAGILE'
  | 'INCONCLUSIVE';

/** One A meta-event's matched difference, in bp, and the market date it belongs to. */
export interface Observation {
  date: string;
  valueBp: number;
}

export interface H001Inputs {
  /** d_i = r_A − r̄_C, one per MATCHED A meta-event. */
  primary: readonly Observation[];
  /** A meta-events that had no exact C match (§G) — counted, not measured. */
  unmatchedA: number;
  /** Group A and group B returns r, for Δ_AB = mean r_A − mean r_B (§G, §K). */
  groupA: readonly Observation[];
  groupB: readonly Observation[];
  /** Whether classification error has been measured against a truth set (§K). */
  truthSetAvailable: boolean;
}

export interface Interval {
  lo: number;
  hi: number;
}

export interface H001Result {
  verdict: H001Verdict;
  /** What the verdict would be with a truth set; equal to `verdict` when one exists. */
  uncappedVerdict: H001Verdict;
  estimateBp: number | null;
  medianBp: number | null;
  ci95: Interval | null;
  ci90: Interval | null;
  halfWidthBp: number | null;
  weeklyCi95: Interval | null;
  /** Days whose removal brought zero back into the primary interval. */
  leaveOneDayOutFailures: string[];
  deltaAB: { estimateBp: number | null; ci95: Interval | null; discardedReplicates: number };
  n: { metaEvents: number; days: number; weeks: number; unmatched: number; unmatchedShare: number | null };
  reasons: string[];
}

// ─── Mechanics ───────────────────────────────────────────────────────────────

/** mulberry32: a small, well-known 32-bit PRNG, so the seed fully determines every replicate. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** R1: type-7 quantile of an ascending array. */
export function quantile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) throw new RangeError('quantile of an empty sample');
  const h = (sorted.length - 1) * p;
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  return sorted[lo]! + (h - lo) * (sorted[hi]! - sorted[lo]!);
}

interface Cluster { sum: number; count: number }

function clustersOf(obs: readonly Observation[], keyOf: (date: string) => string): Map<string, Cluster> {
  const m = new Map<string, Cluster>();
  for (const o of obs) {
    if (!Number.isFinite(o.valueBp)) throw new RangeError(`a non-finite observation on ${o.date}`);
    const k = keyOf(o.date);
    const c = m.get(k) ?? { sum: 0, count: 0 };
    c.sum += o.valueBp;
    c.count += 1;
    m.set(k, c);
  }
  return m;
}

/** Means of `replicates` cluster-resampled draws, ascending. */
function bootstrapMeans(clusters: readonly Cluster[], replicates: number, seed: number): number[] {
  const rand = seededRandom(seed);
  const k = clusters.length;
  const out = new Array<number>(replicates);
  for (let r = 0; r < replicates; r++) {
    let sum = 0;
    let count = 0;
    for (let i = 0; i < k; i++) {
      const c = clusters[Math.floor(rand() * k)]!;
      sum += c.sum;
      count += c.count;
    }
    out[r] = sum / count;
  }
  return out.sort((x, y) => x - y);
}

function intervalOf(sortedMeans: readonly number[], level: number): Interval {
  const tail = (1 - level) / 2;
  return { lo: quantile(sortedMeans, tail), hi: quantile(sortedMeans, 1 - tail) };
}

const excludesZero = (i: Interval) => i.lo > 0 || i.hi < 0;

/** R4: the Monday that starts the calendar week of an ISO market date. */
export function weekOf(date: string): string {
  const t = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(t)) throw new RangeError(`not a date: ${date}`);
  const dow = new Date(t).getUTCDay(); // 0 = Sunday
  const back = (dow + 6) % 7;
  return new Date(t - back * 86_400_000).toISOString().slice(0, 10);
}

/** A day-clustered bootstrap of mean(A) − mean(B), drawing days with whatever of each they hold. */
function deltaAB(
  a: readonly Observation[], b: readonly Observation[], replicates: number, seed: number,
): H001Result['deltaAB'] {
  if (a.length === 0 || b.length === 0) return { estimateBp: null, ci95: null, discardedReplicates: 0 };
  const ca = clustersOf(a, (d) => d);
  const cb = clustersOf(b, (d) => d);
  const days = [...new Set([...ca.keys(), ...cb.keys()])].sort();
  const rand = seededRandom(seed);
  const diffs: number[] = [];
  let discarded = 0;
  for (let r = 0; r < replicates; r++) {
    let sa = 0; let na = 0; let sb = 0; let nb = 0;
    for (let i = 0; i < days.length; i++) {
      const d = days[Math.floor(rand() * days.length)]!;
      const x = ca.get(d); const y = cb.get(d);
      if (x) { sa += x.sum; na += x.count; }
      if (y) { sb += y.sum; nb += y.count; }
    }
    // A replicate that drew no A or no B has no difference to report. It is
    // dropped and counted rather than filled with a value it did not have.
    if (na === 0 || nb === 0) { discarded++; continue; }
    diffs.push(sa / na - sb / nb);
  }
  const mean = (xs: readonly Observation[]) => xs.reduce((s, o) => s + o.valueBp, 0) / xs.length;
  diffs.sort((x, y) => x - y);
  return {
    estimateBp: mean(a) - mean(b),
    ci95: diffs.length > 0 ? intervalOf(diffs, 0.95) : null,
    discardedReplicates: discarded,
  };
}

// ─── The decision ────────────────────────────────────────────────────────────

export interface H001Options {
  /** Overridable for tests only; a study runs the frozen 10,000. */
  replicates?: number;
}

export function h001Verdict(input: H001Inputs, opts: H001Options = {}): H001Result {
  const R = opts.replicates ?? H001_BOOTSTRAP_REPLICATES;
  const seed = H001_BOOTSTRAP_SEED;
  const reasons: string[] = [];
  const obs = input.primary;
  const days = clustersOf(obs, (d) => d);
  const weeks = clustersOf(obs, weekOf);
  const totalA = obs.length + input.unmatchedA;
  const unmatchedShare = totalA === 0 ? null : input.unmatchedA / totalA;
  const n = { metaEvents: obs.length, days: days.size, weeks: weeks.size, unmatched: input.unmatchedA, unmatchedShare };
  const ab = deltaAB(input.groupA, input.groupB, R, seed);

  const finish = (uncapped: H001Verdict, rest: Omit<H001Result, 'verdict' | 'uncappedVerdict' | 'n' | 'deltaAB' | 'reasons'>): H001Result => {
    const capped = !input.truthSetAvailable && uncapped !== 'DESCRIPTIVE';
    if (capped) reasons.push(`no truth set for aggressor classification: ${uncapped} is capped at INCONCLUSIVE (§K)`);
    return { verdict: capped ? 'INCONCLUSIVE' : uncapped, uncappedVerdict: uncapped, n, deltaAB: ab, reasons, ...rest };
  };
  const empty = { estimateBp: null, medianBp: null, ci95: null, ci90: null, halfWidthBp: null, weeklyCi95: null, leaveOneDayOutFailures: [] };

  if (obs.length === 0 || days.size < 2) {
    reasons.push(`${obs.length} matched meta-events over ${days.size} day(s): too few days to resample`);
    return finish('DESCRIPTIVE', empty);
  }

  const estimateBp = obs.reduce((s, o) => s + o.valueBp, 0) / obs.length;
  const sortedValues = obs.map((o) => o.valueBp).sort((x, y) => x - y);
  const medianBp = quantile(sortedValues, 0.5);
  const dayClusters = [...days.keys()].sort().map((k) => days.get(k)!);
  const daily = bootstrapMeans(dayClusters, R, seed);
  const ci95 = intervalOf(daily, 0.95);
  const ci90 = intervalOf(daily, 0.9);
  const halfWidthBp = (ci95.hi - ci95.lo) / 2;
  const weekClusters = [...weeks.keys()].sort().map((k) => weeks.get(k)!);
  const weeklyCi95 = weeks.size >= 2 ? intervalOf(bootstrapMeans(weekClusters, R, seed), 0.95) : null;
  const shared = { estimateBp, medianBp, ci95, ci90, halfWidthBp, weeklyCi95 };

  // §G and §E: DESCRIPTIVE before anything that would make a claim.
  if (unmatchedShare !== null && unmatchedShare > H001_MAX_UNMATCHED_SHARE) {
    reasons.push(`${(unmatchedShare * 100).toFixed(1)}% of A meta-events had no exact control match; above 20% the matched set is a selected subset (§G)`);
    return finish('DESCRIPTIVE', { ...shared, leaveOneDayOutFailures: [] });
  }
  if (halfWidthBp > H001_MAX_HALF_WIDTH_BP) {
    reasons.push(`95% half-width ${halfWidthBp.toFixed(2)} bp exceeds the ${H001_MAX_HALF_WIDTH_BP} bp precision target (§E)`);
    return finish('DESCRIPTIVE', { ...shared, leaveOneDayOutFailures: [] });
  }

  // §D: fragility.
  const looFailures: string[] = [];
  if (excludesZero(ci95)) {
    const keys = [...days.keys()].sort();
    for (const drop of keys) {
      const rest = keys.filter((k) => k !== drop).map((k) => days.get(k)!);
      if (rest.length < 2) continue;
      if (!excludesZero(intervalOf(bootstrapMeans(rest, R, seed), 0.95))) looFailures.push(drop);
    }
  }
  const weeklyDisagrees = weeklyCi95 !== null && excludesZero(weeklyCi95) !== excludesZero(ci95);
  if (weeklyDisagrees) reasons.push('the weekly block bootstrap disagrees with the daily one about whether zero is excluded (§D)');
  if (looFailures.length > 0) reasons.push(`removing ${looFailures.length} single day(s) brings zero back into the interval: ${looFailures.join(', ')} (§D)`);
  if (weeklyDisagrees || looFailures.length > 0) {
    return finish('FRAGILE', { ...shared, leaveOneDayOutFailures: looFailures });
  }

  // §F and §K.
  const done = (v: H001Verdict) => finish(v, { ...shared, leaveOneDayOutFailures: looFailures });
  if (excludesZero(ci95) && ci95.hi < 0) {
    reasons.push('the interval excludes zero below: the effect runs against the hypothesis (§F)');
    return done('CONTRARY');
  }
  if (excludesZero(ci95)) {
    if (ab.ci95 === null || !(ab.ci95.lo > 0)) {
      reasons.push(ab.ci95 === null
        ? 'Δ_AB could not be estimated, so the classifier\'s direction is not shown to carry information (§K)'
        : `Δ_AB's interval [${ab.ci95.lo.toFixed(2)}, ${ab.ci95.hi.toFixed(2)}] bp does not exclude zero above (§K)`);
      return done('NOT SUPPORTED');
    }
    reasons.push('the interval excludes zero above, the precision target is met, Δ_AB > 0, and nothing is fragile (§F, §K)');
    return done('SUPPORTED');
  }
  if (ci90.lo > -H001_EQUIVALENCE_MARGIN_BP && ci90.hi < H001_EQUIVALENCE_MARGIN_BP) {
    reasons.push(`the 90% interval lies inside ±${H001_EQUIVALENCE_MARGIN_BP} bp (TOST, §F)`);
    return done('PRACTICALLY NEGLIGIBLE');
  }
  reasons.push('the interval includes zero and equivalence is not shown; this is not "proven false" (§F)');
  return done('NOT SUPPORTED');
}
