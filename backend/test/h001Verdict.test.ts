/**
 * H-001-v2 §D/§E/§F/§K as code (`research/h001Verdict.ts`).
 *
 * Every verdict in the §F table is reached here from constructed data, and
 * each is reached the way it would be in a real study — by the interval, not
 * by a flag. The inputs are deterministic, so a change to the bootstrap, the
 * seed or the quantile rule that moves a bound shows up as a changed verdict
 * or a changed number, not as a flaky test.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  h001Verdict, quantile, seededRandom, weekOf,
  H001_BOOTSTRAP_REPLICATES, H001_BOOTSTRAP_SEED, H001_DELTA_BP, H001_MAX_HALF_WIDTH_BP,
  H001_EQUIVALENCE_MARGIN_BP, H001_MAX_UNMATCHED_SHARE,
} from '../src/research/h001Verdict';
import type { H001Inputs, Observation } from '../src/research/h001Verdict';

/** Weekdays from Monday 2026-01-05; holidays do not matter to the arithmetic. */
const DAYS: string[] = [];
for (let t = Date.parse('2026-01-05T00:00:00Z'); DAYS.length < 130; t += 86_400_000) {
  const d = new Date(t);
  if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) DAYS.push(d.toISOString().slice(0, 10));
}

/** `perDay` observations on each of `days` days, mean `mean`, spread `sd`, from a fixed stream. */
function sample(days: number, perDay: number, mean: number, sd: number, seed = 1): Observation[] {
  const rand = seededRandom(seed);
  const out: Observation[] = [];
  for (let d = 0; d < days; d++) {
    for (let k = 0; k < perDay; k++) {
      // Sum of uniforms: a deterministic, roughly normal draw.
      let z = 0;
      for (let j = 0; j < 12; j++) z += rand();
      out.push({ date: DAYS[d]!, valueBp: mean + sd * (z - 6) });
    }
  }
  return out;
}

const AB_POSITIVE = { groupA: sample(40, 4, 4, 5, 11), groupB: sample(40, 4, -4, 5, 12) };
const inputs = (primary: Observation[], over: Partial<H001Inputs> = {}): H001Inputs =>
  ({ primary, unmatchedA: 0, truthSetAvailable: true, ...AB_POSITIVE, ...over });

test('the frozen numbers are the hypothesis file\'s', () => {
  assert.equal(H001_BOOTSTRAP_REPLICATES, 10_000);
  assert.equal(H001_BOOTSTRAP_SEED, 20260927);
  assert.equal(H001_DELTA_BP, 3);
  assert.equal(H001_MAX_HALF_WIDTH_BP, 1.5);
  assert.equal(H001_EQUIVALENCE_MARGIN_BP, 1);
  assert.equal(H001_MAX_UNMATCHED_SHARE, 0.2);
});

test('mechanics: type-7 quantiles, Monday-start weeks, and a seed that fixes every replicate', () => {
  assert.equal(quantile([1, 2, 3, 4], 0.5), 2.5);
  assert.equal(quantile([1, 2, 3, 4], 0.25), 1.75);
  assert.equal(quantile([10], 0.975), 10);
  assert.throws(() => quantile([], 0.5), RangeError);
  assert.equal(weekOf('2026-01-07'), '2026-01-05', 'a Wednesday belongs to its Monday');
  assert.equal(weekOf('2026-01-05'), '2026-01-05');
  assert.equal(weekOf('2026-01-11'), '2026-01-05', 'Sunday closes the Monday-start week');
  const a = seededRandom(H001_BOOTSTRAP_SEED); const b = seededRandom(H001_BOOTSTRAP_SEED);
  for (let i = 0; i < 5; i++) assert.equal(a(), b());
  const x = inputs(sample(60, 10, 4, 5));
  assert.deepEqual(h001Verdict(x).ci95, h001Verdict(x).ci95, 'the same data gives the same interval');
});

test('SUPPORTED: excludes zero above, precise, Δ_AB > 0, not fragile — and a truth set exists', () => {
  const r = h001Verdict(inputs(sample(60, 10, 4, 5)));
  assert.equal(r.verdict, 'SUPPORTED', r.reasons.join(' | '));
  assert.ok(r.ci95!.lo > 0);
  assert.ok(r.halfWidthBp! <= H001_MAX_HALF_WIDTH_BP);
  assert.equal(r.halfWidthBp, (r.ci95!.hi - r.ci95!.lo) / 2, 'the half-width is half the 95% interval');
  assert.ok(r.deltaAB.ci95!.lo > 0);
  assert.equal(r.n.days, 60);
  assert.equal(r.n.metaEvents, 600);
});

test('without a truth set every claim is INCONCLUSIVE, and the verdict it would have been is kept', () => {
  for (const [primary, would] of [
    [sample(60, 10, 4, 5), 'SUPPORTED'],
    [sample(60, 10, -4, 5), 'CONTRARY'],
    [sample(60, 10, 0, 1), 'PRACTICALLY NEGLIGIBLE'],
  ] as const) {
    const r = h001Verdict(inputs([...primary], { truthSetAvailable: false }));
    assert.equal(r.verdict, 'INCONCLUSIVE');
    assert.equal(r.uncappedVerdict, would);
    assert.ok(r.reasons.some((x) => /truth set/.test(x)));
  }
  // DESCRIPTIVE makes no claim, so there is nothing to cap.
  const wide = h001Verdict(inputs(sample(60, 2, 4, 60), { truthSetAvailable: false }));
  assert.equal(wide.verdict, 'DESCRIPTIVE');
  assert.equal(wide.uncappedVerdict, 'DESCRIPTIVE');
});

test('CONTRARY: excludes zero below, reported and never support', () => {
  const r = h001Verdict(inputs(sample(60, 10, -4, 5)));
  assert.equal(r.verdict, 'CONTRARY');
  assert.ok(r.ci95!.hi < 0);
});

test('PRACTICALLY NEGLIGIBLE needs the 90% interval inside ±1 bp; otherwise NOT SUPPORTED, not "false"', () => {
  const negligible = h001Verdict(inputs(sample(60, 10, 0, 1)));
  assert.equal(negligible.verdict, 'PRACTICALLY NEGLIGIBLE');
  assert.ok(negligible.ci90!.lo > -1 && negligible.ci90!.hi < 1);
  // TOST is the 90% interval, not the 95%: here the 95% crosses -1 bp and the 90% does not.
  const tost = h001Verdict(inputs(sample(60, 10, 0.4, 12)));
  assert.ok(tost.ci95!.lo < -1 && tost.ci90!.lo > -1, JSON.stringify([tost.ci95, tost.ci90]));
  assert.equal(tost.verdict, 'PRACTICALLY NEGLIGIBLE');
  // Includes zero, precise enough to be confirmatory, but not shown to be inside the margin.
  const r = h001Verdict(inputs(sample(60, 10, 0, 12)));
  assert.ok(r.ci95!.lo <= 0 && r.ci95!.hi >= 0, JSON.stringify(r.ci95));
  assert.ok(r.halfWidthBp! <= H001_MAX_HALF_WIDTH_BP, `half-width ${r.halfWidthBp}`);
  assert.ok(!(r.ci90!.lo > -1 && r.ci90!.hi < 1));
  assert.equal(r.verdict, 'NOT SUPPORTED');
  assert.ok(r.reasons.some((x) => /not "proven false"/.test(x)));
});

test('DESCRIPTIVE: a wide interval, or more than 20% unmatched, makes no claim at all', () => {
  const wide = h001Verdict(inputs(sample(60, 2, 4, 60)));
  assert.equal(wide.verdict, 'DESCRIPTIVE');
  assert.ok(wide.halfWidthBp! > H001_MAX_HALF_WIDTH_BP);
  assert.ok(wide.estimateBp !== null && wide.ci95 !== null, 'the estimate and interval are still published');
  // A strong, precise effect is still DESCRIPTIVE if the matched set is a selected subset.
  const strong = sample(60, 10, 4, 5);
  assert.equal(h001Verdict(inputs(strong, { unmatchedA: 150 })).verdict, 'SUPPORTED', '150 / 750 = 20% is not above');
  const r = h001Verdict(inputs(strong, { unmatchedA: 151 }));
  assert.equal(r.verdict, 'DESCRIPTIVE');
  assert.ok(r.reasons.some((x) => /no exact control match/.test(x)));
  // Too few days to resample is DESCRIPTIVE too, not an error and not a verdict.
  assert.equal(h001Verdict(inputs(sample(1, 50, 4, 5))).verdict, 'DESCRIPTIVE');
  assert.equal(h001Verdict(inputs([])).verdict, 'DESCRIPTIVE');
});

test('§K: a primary effect whose Δ_AB does not exclude zero above is NOT SUPPORTED, with the reason', () => {
  const flatAB = { groupA: sample(40, 4, 0, 5, 21), groupB: sample(40, 4, 0, 5, 22) };
  const r = h001Verdict(inputs(sample(60, 10, 4, 5), flatAB));
  assert.equal(r.verdict, 'NOT SUPPORTED');
  assert.ok(r.reasons.some((x) => /Δ_AB/.test(x)));
  const noB = h001Verdict(inputs(sample(60, 10, 4, 5), { groupB: [] }));
  assert.equal(noB.verdict, 'NOT SUPPORTED');
  assert.equal(noB.deltaAB.ci95, null);
});

test('FRAGILE: the weekly bootstrap disagrees with the daily one', () => {
  // Days within a week share a regime: twelve weekly levels, five identical days each.
  const W = [3, -1, 2.5, -0.5, 4, 1, -2, 2, 0.5, 3.5, -1.5, 0.5];
  const obs = W.flatMap((w, k) => DAYS.slice(k * 5, k * 5 + 5).map((date) => ({ date, valueBp: w })));
  const r = h001Verdict(inputs(obs));
  assert.ok(r.ci95!.lo > 0, 'treating days as independent, zero is excluded');
  assert.ok(r.weeklyCi95!.lo <= 0, 'resampling weeks, it is not');
  assert.equal(r.verdict, 'FRAGILE');
  assert.equal(r.n.weeks, 12);
});

test('FRAGILE: dropping a single day brings zero back in — and the control, a little further from it, does not', () => {
  // Nine days at +1 bp, one day strongly negative. Dropping a +1 day raises the
  // negative day's share of every resample.
  const tenDays = (negative: number) =>
    DAYS.slice(0, 10).map((date, i) => ({ date, valueBp: i === 2 ? negative : 1 }));
  const fragile = h001Verdict(inputs(tenDays(-2.2)));
  assert.ok(fragile.ci95!.lo > 0);
  assert.equal(fragile.verdict, 'FRAGILE');
  assert.equal(fragile.leaveOneDayOutFailures.length, 9);
  assert.ok(!fragile.leaveOneDayOutFailures.includes(DAYS[2]!), 'dropping the negative day only helps');
  const control = h001Verdict(inputs(tenDays(-1.8)));
  assert.equal(control.verdict, 'SUPPORTED');
  assert.deepEqual(control.leaveOneDayOutFailures, []);
});

test('the trading day is the cluster: thirty meta-events on one day are not thirty independent draws', () => {
  // Twenty days, each with thirty identical meta-events (one regime per day),
  // on a four-day cycle so that weeks disagree in sign too and the weekly check
  // does not fire. Resampled as 600 independent values this excludes zero
  // easily; resampled by day — what §D freezes — it does not.
  const obs = DAYS.slice(0, 20).flatMap((date, i) =>
    Array.from({ length: 30 }, () => ({ date, valueBp: [3, -2, 2, -2][i % 4]! })));
  const r = h001Verdict(inputs(obs));
  assert.equal(r.n.metaEvents, 600);
  assert.equal(r.n.days, 20);
  assert.ok(r.ci95!.lo <= 0, `the day-clustered interval includes zero: ${JSON.stringify(r.ci95)}`);
  assert.equal(r.verdict, 'NOT SUPPORTED');
});

test('a non-finite observation is refused, not averaged', () => {
  assert.throws(() => h001Verdict(inputs([{ date: DAYS[0]!, valueBp: Number.NaN }, { date: DAYS[1]!, valueBp: 1 }])), RangeError);
});
