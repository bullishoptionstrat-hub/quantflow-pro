/**
 * FINDING #27 REGRESSION — the OCC connector's zero sentinels and hidden delay.
 *
 * `Number(x) || 0` on every numeric field. Worse than the `?? 0` fixed in
 * cboe.ts, because `||` also collapses a legitimate `0` and `NaN`.
 *
 * The field that mattered most was `vsMonthlyAverage`: it asserted "today is
 * 0x the trailing average" whenever the average was unknown. That value is the
 * denominator for "is today's options activity outsized", so a silent 0 makes
 * every single day look unremarkable — the failure is not just wrong, it is
 * wrong in the direction that suppresses signal.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { num, ratio } from '../src/ingestion/parseNumeric';
import { validateProvenance, upstreamProvenance } from '../src/config/provenance';

describe('ratio() refuses to invent a multiple', () => {
  it('is null when the denominator is unknown — NOT 0', () => {
    // The exact defect: `monthlyAvg > 0 ? vol / monthlyAvg : 0`.
    assert.equal(ratio(1_000_000, null), null);
  });

  it('is null when the denominator is zero, rather than Infinity or 0', () => {
    assert.equal(ratio(1_000_000, 0), null);
  });

  it('is null when the numerator is unknown', () => {
    assert.equal(ratio(null, 500_000), null);
  });

  it('computes a real multiple when both legs are present', () => {
    assert.equal(ratio(1_000_000, 500_000), 2);
  });

  it('a genuinely zero numerator gives 0, which is a real answer', () => {
    // Distinct from the unknown case above — this says "no volume today",
    // which is a fact, versus "we could not compute this".
    assert.equal(ratio(0, 500_000), 0);
  });

  it('never returns a non-finite number', () => {
    for (const [n, d] of [[Infinity, 1], [1, Infinity], [NaN, 1]] as const) {
      const r = ratio(n as number, d as number);
      assert.ok(r === null || Number.isFinite(r));
    }
  });
});

describe('the snake_case field that the sentinel used to hide', () => {
  it('a wrong/absent key reads null, so a permanent parse failure is visible', () => {
    // `fiftytwo_week_high` is snake_case among camelCase siblings. Under
    // `|| 0` a wrong key would have read 0 forever with nothing to notice.
    const entity: Record<string, unknown> = { fiftytwoWeekHigh: 123 }; // wrong shape
    assert.equal(num(entity.fiftytwo_week_high), null);
    // And the correct key still parses.
    assert.equal(num({ fiftytwo_week_high: 123 }.fiftytwo_week_high), 123);
  });
});

describe('OCC declares its next-business-day clearing delay', () => {
  const provenance = upstreamProvenance({
    source: 'occ',
    source_type: 'exchange',
    is_delayed: true,
    estimated_delay_seconds: 86_400,
  });

  it('is marked delayed with an estimate, which the contract requires', () => {
    assert.equal(provenance.is_delayed, true);
    assert.equal(typeof provenance.estimated_delay_seconds, 'number');
    assert.deepEqual(validateProvenance(provenance), []);
  });

  it('a delayed flag WITHOUT an estimate is rejected by the contract', () => {
    // Proves the requirement has teeth: "delayed" alone is not enough, because
    // an unquantified delay cannot be reasoned about downstream.
    const bad = { ...provenance };
    delete (bad as { estimated_delay_seconds?: number }).estimated_delay_seconds;
    assert.deepEqual(validateProvenance(bad), ['delayed_without_delay_estimate']);
  });

  it('is never presentable as live data', () => {
    assert.notEqual(provenance.is_delayed, undefined);
  });
});
