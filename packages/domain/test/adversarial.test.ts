/**
 * ADVERSARIAL PROBES — written to BREAK the kernel, not to confirm it.
 *
 * `kernel.test.ts` demonstrates the intended behavior. This file attacks the
 * edges that suite does not reach: DST discontinuities, boundary instants, and
 * ordering determinism. One of these found a real bug (see ORDERING below);
 * the rest pin behavior that is currently correct so it stays that way.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  asOf,
  assertKnowable,
  etOffsetMsAt,
  etTimeOnDate,
  latestAsOf,
  LookaheadError,
  FINRA_DAILY_LAG,
} from '../src/pointInTime.js';
import { etHour, etParts, previousTradingDay, recentTradingDays } from '../src/marketTime.js';
import { combineQuality } from '../src/quality.js';

describe('ORDERING — a point-in-time answer must not depend on input order', () => {
  /**
   * THE BUG THIS CAUGHT: `latestAsOf` reduced on `availableAt` alone, so two
   * records sharing a publication instant resolved to whichever came first in
   * the array. Reversing the input returned the other record. A backtest would
   * silently produce different features depending on the order rows came back
   * from the database.
   */
  const pub = '2026-06-19T22:00:00.000Z';

  it('returns the same record regardless of array order, on an availableAt tie', () => {
    const a = { effectiveAt: '2026-06-18', availableAt: pub, tag: 'older-session' };
    const b = { effectiveAt: '2026-06-19', availableAt: pub, tag: 'newer-session' };

    const forward = latestAsOf([a, b], pub);
    const reversed = latestAsOf([b, a], pub);

    assert.equal(forward?.tag, reversed?.tag, 'result must not depend on input order');
    // And the tie must resolve toward the later effective session — a
    // same-instant republication is a revision, and the revision is the answer.
    assert.equal(forward?.tag, 'newer-session');
  });

  it('is still deterministic when availableAt AND effectiveAt both tie', () => {
    const a = { effectiveAt: '2026-06-19', availableAt: pub, tag: 'x' };
    const b = { effectiveAt: '2026-06-19', availableAt: pub, tag: 'y' };
    assert.equal(latestAsOf([a, b], pub)?.tag, latestAsOf([b, a], pub)?.tag);
  });
});

describe('BOUNDARY — the exact publication instant', () => {
  const pub = FINRA_DAILY_LAG.availableAtFor('2026-06-19');

  it('a record IS knowable at exactly its publication instant', () => {
    assert.equal(asOf([{ effectiveAt: '2026-06-19', availableAt: pub }], pub).length, 1);
    assert.doesNotThrow(() => assertKnowable({ effectiveAt: '2026-06-19', availableAt: pub }, pub));
  });

  it('one millisecond earlier it is NOT', () => {
    const justBefore = new Date(Date.parse(pub) - 1);
    assert.equal(asOf([{ effectiveAt: '2026-06-19', availableAt: pub }], justBefore).length, 0);
    assert.throws(
      () => assertKnowable({ effectiveAt: '2026-06-19', availableAt: pub }, justBefore),
      LookaheadError,
    );
  });

  it('an empty-string availableAt is excluded, not treated as epoch zero', () => {
    assert.equal(asOf([{ effectiveAt: '2026-06-19', availableAt: '' }], pub).length, 0);
  });

  it('a garbage availableAt is excluded rather than parsed loosely', () => {
    assert.equal(asOf([{ effectiveAt: '2026-06-19', availableAt: 'yesterday' }], pub).length, 0);
  });
});

describe('DST — the discontinuities, not just the two stable seasons', () => {
  it('resolves the real UTC offset on both sides of spring-forward', () => {
    // 2026-03-08 is the US spring-forward date.
    assert.equal(etOffsetMsAt(new Date('2026-03-07T12:00:00Z')) / 3_600_000, 5); // EST
    assert.equal(etOffsetMsAt(new Date('2026-03-09T12:00:00Z')) / 3_600_000, 4); // EDT
  });

  it('publication times land on the correct instant in EST and EDT alike', () => {
    // The whole point: a hardcoded -04:00 gets the winter case wrong by an hour.
    assert.equal(FINRA_DAILY_LAG.availableAtFor('2026-06-19'), '2026-06-19T22:00:00.000Z');
    assert.equal(FINRA_DAILY_LAG.availableAtFor('2026-01-16'), '2026-01-16T23:00:00.000Z');
  });

  it('a wall time inside the spring-forward GAP resolves forward, not backward', () => {
    // 02:30 ET does not exist on 2026-03-08. It must not silently become
    // 01:30 (an hour EARLIER than asked), which would move a publication time
    // backwards and could admit a record before it existed.
    const t = etTimeOnDate('2026-03-08', 2, 30);
    assert.equal(etParts(new Date(t)).hour, 3, 'nonexistent wall time shifts forward');
  });

  it('midnight ET is reported as hour 0, not hour 24', () => {
    assert.equal(etHour(new Date('2026-06-15T04:00:00Z')), 0); // EDT midnight
    assert.equal(etHour(new Date('2026-01-15T05:00:00Z')), 0); // EST midnight
    // And the date must roll with it rather than staying on the previous day.
    assert.equal(etParts(new Date('2026-06-15T04:00:00Z')).isoDate, '2026-06-15');
    assert.equal(etParts(new Date('2026-06-15T03:59:59Z')).isoDate, '2026-06-14');
  });
});

describe('CALENDAR — holidays are not just weekends', () => {
  it('walks back over a holiday rather than returning it', () => {
    assert.equal(previousTradingDay('2026-12-25'), '2026-12-24');
    // 2026-07-03 is the observed Independence Day holiday.
    assert.deepEqual(recentTradingDays('2026-07-03', 3), ['2026-07-02', '2026-07-01', '2026-06-30']);
  });

  it('throws rather than looping forever when no trading day is reachable', () => {
    assert.throws(() => previousTradingDay('2026-12-25', 0), /no trading day found/);
  });
});

describe('QUALITY — combination takes the worst, never the average', () => {
  it('one UNAVAILABLE input poisons the combination', () => {
    const c = combineQuality([
      { state: 'GOOD', flags: [] },
      { state: 'UNAVAILABLE', flags: ['STALE_SOURCE'], note: 'source down' },
      { state: 'GOOD', flags: [] },
    ]);
    assert.equal(c.state, 'UNAVAILABLE');
    assert.ok(c.flags.includes('STALE_SOURCE'));
  });

  it('no inputs is UNAVAILABLE, not GOOD', () => {
    assert.equal(combineQuality([]).state, 'UNAVAILABLE');
  });
});
