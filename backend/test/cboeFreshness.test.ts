/**
 * FINDING #26 REGRESSION — a snapshot must not stamp itself "now".
 *
 * `asOf: d.last_trade_time ?? new Date().toISOString()`.
 *
 * A chain payload carrying no timestamp was stamped with the current time, so a
 * feed that had stopped updating read as perfectly fresh. This is the same
 * class of defect as the zero sentinels, one level up: instead of inventing a
 * VALUE it invented the value's AGE, which is worse, because age is what a
 * reader uses to decide whether to trust the value at all.
 *
 * `packages/domain/src/freshness.ts` exists for exactly this — its
 * `TRADE_DATE_INFERRED` flag is this case — and its module docstring records
 * the real-world instance: a Cboe CSV that returned HTTP 200 and parsed cleanly
 * with data frozen since 2019. Every naive health check called it healthy.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ageMinutesFrom } from '../src/ingestion/connectors/cboeOptions';

const NOW = new Date('2026-08-29T18:00:00.000Z');

describe('age is derived from the source timestamp, never assumed', () => {
  it('computes real age from a real timestamp', () => {
    assert.equal(ageMinutesFrom('2026-08-29T17:45:00.000Z', NOW), 15);
    assert.equal(ageMinutesFrom('2026-08-29T14:00:00.000Z', NOW), 240);
  });

  it('a same-instant timestamp is age 0, which is a measurement', () => {
    assert.equal(ageMinutesFrom('2026-08-29T18:00:00.000Z', NOW), 0);
  });

  it('returns null when there is no timestamp — the whole point', () => {
    // The old code turned this case into `now()`, i.e. age 0, i.e. "fresh".
    assert.equal(ageMinutesFrom(null, NOW), null);
  });

  it('returns null for an unparseable timestamp rather than guessing', () => {
    assert.equal(ageMinutesFrom('not a date', NOW), null);
    assert.equal(ageMinutesFrom('', NOW), null);
  });

  it('rejects a FUTURE timestamp instead of reporting negative age', () => {
    // A future date is clock skew or a parse error. Treating it as "very
    // fresh" is precisely how staleness detection gets defeated — the most
    // suspicious payload would become the most trusted one.
    assert.equal(ageMinutesFrom('2026-08-29T19:00:00.000Z', NOW), null);
  });

  it('detects genuinely ancient data', () => {
    // The Cboe-2019 case, at day scale.
    const age = ageMinutesFrom('2019-10-04T20:00:00.000Z', NOW);
    assert.ok(age !== null && age > 60 * 24 * 365 * 6, 'a 2019 file must read as years old');
  });
});

describe('the honesty contract the snapshot carries', () => {
  /** Mirrors how fetchCboeChain assembles these two fields. */
  function fieldsFor(lastTradeTime: unknown, now = NOW) {
    const asOf = typeof lastTradeTime === 'string' && lastTradeTime.trim().length > 0
      ? lastTradeTime
      : null;
    return {
      asOf,
      tradeDateInferred: asOf === null,
      delayedMinutes: ageMinutesFrom(asOf, now) ?? 15,
    };
  }

  it('a dated payload reports measured age and is not flagged inferred', () => {
    const f = fieldsFor('2026-08-29T17:30:00.000Z');
    assert.equal(f.tradeDateInferred, false);
    assert.equal(f.delayedMinutes, 30);
    assert.equal(f.asOf, '2026-08-29T17:30:00.000Z');
  });

  it('an undated payload is flagged, and asOf is null rather than now()', () => {
    const f = fieldsFor(undefined);
    assert.equal(f.asOf, null, 'must not substitute the current time');
    assert.equal(f.tradeDateInferred, true);
    // Falls back to the publisher's declared lag as a FLOOR, and says so.
    assert.equal(f.delayedMinutes, 15);
  });

  it('a blank-string timestamp counts as undated, not as a value', () => {
    assert.equal(fieldsFor('   ').tradeDateInferred, true);
  });

  it('stale data cannot masquerade as fresh through the fallback', () => {
    // Regression on the exact old expression: `?? new Date().toISOString()`
    // would have produced delayedMinutes 0 here. It must not.
    const undated = fieldsFor(null);
    assert.notEqual(undated.delayedMinutes, 0);
    assert.equal(undated.tradeDateInferred, true);
  });
});
