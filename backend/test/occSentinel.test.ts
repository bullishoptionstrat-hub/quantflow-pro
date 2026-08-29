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
import { occClearingWindow } from '../src/ingestion/connectors/occ';

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

describe('the clearing delay is derived from the trading calendar, not asserted', () => {
  /**
   * The flat `86_400` this replaced was not merely imprecise — it was wrong in
   * a specific, predictable way. Cleared volume read on a Monday describes
   * FRIDAY's session, so the real lag is ~72h. Understating it by two thirds
   * matters because that number is what a reader uses to decide whether the
   * data is current enough to act on.
   */
  const HOURS = 3600;

  it('a mid-week read reports roughly one day', () => {
    // Wed 2026-08-26 10:00 ET (14:00Z) -> previous session is Tue 2026-08-25.
    const w = occClearingWindow(new Date('2026-08-26T14:00:00Z'));
    assert.equal(w.effectiveDate, '2026-08-25');
    assert.ok(w.delaySeconds > 17 * HOURS && w.delaySeconds < 24 * HOURS,
      `expected ~18h since Tuesday's close, got ${w.delaySeconds / HOURS}h`);
  });

  it('MONDAY correctly reports ~3 days — the case the flat constant got wrong', () => {
    // Mon 2026-08-31 10:00 ET -> previous session is Fri 2026-08-28.
    const w = occClearingWindow(new Date('2026-08-31T14:00:00Z'));
    assert.equal(w.effectiveDate, '2026-08-28', 'must skip the weekend');
    assert.ok(w.delaySeconds > 60 * HOURS,
      `expected >60h since Friday's close, got ${w.delaySeconds / HOURS}h`);
    // The old flat value would have claimed 24h here.
    assert.ok(w.delaySeconds > 86_400 * 2,
      'the flat 86400 understated this by more than half');
  });

  it('skips a market holiday, not just weekends', () => {
    // Fri 2026-07-03 is the observed Independence Day holiday; the session
    // before it is Thu 2026-07-02.
    const w = occClearingWindow(new Date('2026-07-06T14:00:00Z')); // Monday
    assert.equal(w.effectiveDate, '2026-07-02',
      'must skip both the holiday and the weekend');
  });

  it('availableAt is the OCC publication instant, not the fetch time', () => {
    const w = occClearingWindow(new Date('2026-08-26T14:00:00Z'));
    // 09:00 ET the business day after the 2026-08-25 session. August is EDT
    // (UTC-4), so 09:00 ET is 13:00Z.
    assert.equal(w.availableAt, '2026-08-26T13:00:00.000Z');
  });

  it('handles the EST/EDT boundary through the IANA zone, not a fixed offset', () => {
    // January is EST (UTC-5), so 09:00 ET is 14:00Z rather than 13:00Z.
    const w = occClearingWindow(new Date('2026-01-16T14:00:00Z')); // Fri
    assert.ok(w.availableAt.endsWith('T14:00:00.000Z'),
      `winter publication must be 14:00Z, got ${w.availableAt}`);
  });

  it('never reports a negative delay', () => {
    for (const iso of ['2026-08-26T14:00:00Z', '2026-01-02T14:00:00Z', '2026-12-28T14:00:00Z']) {
      assert.ok(occClearingWindow(new Date(iso)).delaySeconds >= 0);
    }
  });
});
