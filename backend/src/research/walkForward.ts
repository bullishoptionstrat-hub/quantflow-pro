/**
 * Walk-forward folds and a binomial confidence interval: the two pieces of
 * research arithmetic every later backtest in docs/MASTER_PLAN.md needs.
 *
 * Pure and clock-free. Nothing here reads data, ranks parameters or decides
 * anything; it only says which time ranges a study may fit on and which it
 * must test on, and how wide the uncertainty on a hit count is.
 *
 * Folds are chronological. Each test window starts after its training window
 * ends plus an embargo, so a label whose horizon reaches into the test window
 * cannot be fitted on (the leakage López de Prado's purging/embargo rule
 * exists for). Test windows never overlap one another. A span too short for
 * even one fold returns no folds rather than a shortened one: a study that
 * wanted 60 days of training does not silently get 40.
 */

export type WalkForwardMode = 'ANCHORED' | 'ROLLING';

export interface WalkForwardSpec {
  /** Inclusive start of the data, epoch ms. */
  startMs: number;
  /** Exclusive end of the data, epoch ms. */
  endMs: number;
  trainMs: number;
  testMs: number;
  /** Gap between a training window's end and its test window's start. */
  embargoMs: number;
  /** ANCHORED: every training window starts at startMs. ROLLING: fixed length. */
  mode: WalkForwardMode;
}

export interface Fold {
  index: number;
  trainStartMs: number;
  trainEndMs: number; // exclusive
  testStartMs: number;
  testEndMs: number; // exclusive
}

export function walkForwardRefusals(s: WalkForwardSpec): string[] {
  const out: string[] = [];
  const fin = (k: keyof WalkForwardSpec) => Number.isFinite(s[k] as number);
  for (const k of ['startMs', 'endMs', 'trainMs', 'testMs', 'embargoMs'] as const) {
    if (!fin(k)) out.push(`${k} is not a finite number`);
  }
  if (out.length) return out;
  if (s.endMs <= s.startMs) out.push('endMs must be after startMs');
  if (s.trainMs <= 0) out.push('trainMs must be positive');
  if (s.testMs <= 0) out.push('testMs must be positive');
  if (s.embargoMs < 0) out.push('embargoMs must not be negative');
  if (s.mode !== 'ANCHORED' && s.mode !== 'ROLLING') out.push('mode must be ANCHORED or ROLLING');
  return out;
}

export function walkForwardFolds(s: WalkForwardSpec): Fold[] {
  const refusals = walkForwardRefusals(s);
  if (refusals.length) throw new Error(`walk-forward spec refused: ${refusals.join('; ')}`);
  const folds: Fold[] = [];
  let trainEnd = s.startMs + s.trainMs;
  for (;;) {
    const testStart = trainEnd + s.embargoMs;
    const testEnd = testStart + s.testMs;
    if (testEnd > s.endMs) break;
    folds.push({
      index: folds.length,
      trainStartMs: s.mode === 'ANCHORED' ? s.startMs : trainEnd - s.trainMs,
      trainEndMs: trainEnd,
      testStartMs: testStart,
      testEndMs: testEnd,
    });
    trainEnd += s.testMs;
  }
  return folds;
}

/**
 * Wilson score interval for k successes in n trials. Returns null for n = 0:
 * no trials is no interval, never [0, 1] presented as a measurement.
 */
export function wilsonInterval(k: number, n: number, z = 1.959963984540054): { low: number; high: number } | null {
  if (!Number.isInteger(k) || !Number.isInteger(n) || n < 0 || k < 0 || k > n) {
    throw new Error(`wilsonInterval: need integers 0 <= k <= n, got k=${k} n=${n}`);
  }
  if (n === 0) return null;
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
}
