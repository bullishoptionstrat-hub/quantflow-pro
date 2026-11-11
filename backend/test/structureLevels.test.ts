/**
 * Prior-session levels: the definition in `src/structure/levels.ts`.
 *
 * The load-bearing cases are the ones an assumed 09:30–16:00 gets wrong: a half
 * day (13:00 close), a holiday, and a date past the calendar's coverage. This
 * repository has already shipped a `MARKET OPEN` dot that was green through a
 * half-day afternoon; a PDH computed from a 16:00 close on 2026-11-27 would be
 * the same mistake, written into a level something else trades against.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Bar } from '../src/market/bar';
import { LevelEvent, NOT_COMPUTED_LEVELS, SessionLevelEvent, detectSessionLevels } from '../src/structure/levels';
import { assertPrefixStable, bar, closedBy, et } from './structureFixtures';

const Q = 15 * 60_000;

/** `n` 15-minute bars from `t0`, the k-th shaped by `shape(k)` → [h, l]. */
function bars15(t0: number, n: number, shape: (k: number) => [number, number]): Bar[] {
  return Array.from({ length: n }, (_, k) => {
    const [h, l] = shape(k);
    const m = (h + l) / 2;
    return bar('SPY', '15m', t0 + k * Q, m, h, l, m);
  });
}

const level = (events: LevelEvent[], name: 'PDH' | 'PDL', date: string): SessionLevelEvent | undefined =>
  events.find((e): e is SessionLevelEvent => e.kind === 'SESSION_LEVEL' && e.name === name && e.sessionDate === date);

// 2026-11-24: a full regular session, plus one premarket bar with a higher high.
const PRE = bar('SPY', '15m', et('2026-11-24', 9, 15), 100, 110, 99, 100);
const FULL = bars15(et('2026-11-24', 9, 30), 26, (k) => [k === 10 ? 105 : 101, k === 20 ? 95 : 99]);
const NEXT = bars15(et('2026-11-25', 9, 30), 1, () => [101, 99]);

test('a full session: PDH/PDL from RTH bars only, COMPLETE, known at the published close', () => {
  const events = detectSessionLevels([PRE, ...FULL, ...NEXT]);
  const pdh = level(events, 'PDH', '2026-11-24');
  const pdl = level(events, 'PDL', '2026-11-24');
  assert.ok(pdh && pdl);
  assert.equal(pdh.price, 105, 'the premarket 110 is not a regular-session high');
  assert.equal(pdl.price, 95);
  assert.equal(pdh.status, 'COMPLETE');
  assert.deepEqual(pdh.coverage, { present: 26, expected: 26, openAt: et('2026-11-24', 9, 30), closeAt: et('2026-11-24', 16, 0) });
  assert.equal(pdh.excludedOutsideRth, 1);
  assert.equal(pdh.knownAt, et('2026-11-24', 16, 0), 'known when the last RTH bar closes');
  assert.equal(pdh.sessionKind, 'REGULAR');
  assert.deepEqual(pdh.evidence.map((r) => r.tOpen), [FULL[10].tOpen, FULL[25].tOpen], 'cites the high bar and the bar that ends the session');
});

test('a session missing its last bar is INCOMPLETE and known only when a later bar shows it ended', () => {
  const holed = FULL.slice(0, 25);
  assert.equal(level(detectSessionLevels([...holed]), 'PDH', '2026-11-24'), undefined,
    'with nothing after 15:30, nothing shows the session is over');
  const events = detectSessionLevels([...holed, ...NEXT]);
  const pdh = level(events, 'PDH', '2026-11-24');
  assert.ok(pdh);
  assert.equal(pdh.status, 'INCOMPLETE');
  assert.equal(pdh.coverage.present, 25);
  assert.equal(pdh.coverage.expected, 26);
  assert.equal(pdh.knownAt, NEXT[0].closedAt, 'known at the close of the first bar after the session');
});

test('a half day closes at 13:00: later bars are excluded and the level is known at 13:00', () => {
  const rth = bars15(et('2026-11-27', 9, 30), 14, (k) => [k === 5 ? 103 : 101, 99]);
  const after = bars15(et('2026-11-27', 13, 0), 12, () => [108, 90]);
  const events = detectSessionLevels([...rth, ...after]);
  const pdh = level(events, 'PDH', '2026-11-27');
  const pdl = level(events, 'PDL', '2026-11-27');
  assert.ok(pdh && pdl);
  assert.equal(pdh.sessionKind, 'EARLY_CLOSE');
  assert.equal(pdh.price, 103, 'the 108 printed after the 13:00 close is not part of the session');
  assert.equal(pdl.price, 99, 'nor is the 90');
  assert.equal(pdh.coverage.expected, 14, '09:30–13:00 is fourteen 15-minute bars, not twenty-six');
  assert.equal(pdh.coverage.present, 14);
  assert.equal(pdh.status, 'COMPLETE');
  // Zero, not twelve: the post-close bars had not closed when the level became
  // known at 13:00, so a count published at 13:00 cannot include them. The
  // first version counted them, and the prefix guard below caught it.
  assert.equal(pdh.excludedOutsideRth, 0);
  assert.equal(pdh.knownAt, et('2026-11-27', 13, 0));
  assert.equal(pdh.coverage.closeAt, et('2026-11-27', 13, 0));
});

test('a holiday has no session: no level is measured from it, and bars on it count for nothing', () => {
  const wed = bars15(et('2026-11-25', 9, 30), 26, (k) => [k === 3 ? 104 : 101, 99]);
  const stray = bars15(et('2026-11-26', 10, 0), 2, () => [120, 80]); // Thanksgiving
  const fri = bars15(et('2026-11-27', 9, 30), 14, () => [102, 98]);
  const events = detectSessionLevels([...wed, ...stray, ...fri]);
  assert.deepEqual([...new Set(events.map((e) => e.sessionDate))], ['2026-11-25', '2026-11-27']);
  assert.ok(!events.some((e) => e.kind === 'LEVEL_UNMEASURABLE'), 'a holiday is a known closure, not an unknown');
  assert.equal(level(events, 'PDH', '2026-11-25')?.price, 104);
  assert.equal(level(events, 'PDH', '2026-11-27')?.price, 102, 'the 120 printed on the holiday reaches no level');
});

test('a date past the calendar coverage is UNMEASURABLE with the calendar\'s reason, never 09:30–16:00', () => {
  const fri = bars15(et('2027-12-31', 9, 30), 26, () => [101, 99]);
  const mon = bars15(et('2028-01-03', 9, 30), 3, () => [130, 70]);
  const events = detectSessionLevels([...fri, ...mon]);
  assert.equal(level(events, 'PDH', '2027-12-31')?.status, 'COMPLETE', 'the last covered date still measures');
  const unknown = events.filter((e) => e.sessionDate === '2028-01-03');
  assert.equal(unknown.length, 1);
  const u = unknown[0];
  assert.equal(u.kind, 'LEVEL_UNMEASURABLE');
  if (u.kind !== 'LEVEL_UNMEASURABLE') return;
  assert.deepEqual(u.names, ['PDH', 'PDL']);
  assert.match(u.reason, /outside the calendar's coverage/);
  assert.equal(u.knownAt, mon[0].closedAt, 'said as soon as the first bar on that date closes');
});

test('a session with no RTH bars is UNMEASURABLE, not a level', () => {
  const pre = bars15(et('2026-11-24', 8, 0), 4, () => [101, 99]);
  const events = detectSessionLevels([...pre, ...NEXT]);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'LEVEL_UNMEASURABLE');
  if (events[0].kind === 'LEVEL_UNMEASURABLE') assert.match(events[0].reason, /no bar dated 2026-11-24 lies inside/);
});

test('summer time: bounds come from the civil clock, not from a fixed UTC offset', () => {
  const july = bars15(et('2026-07-02', 9, 30), 26, () => [101, 99]);
  const pdh = level(detectSessionLevels(july), 'PDH', '2026-07-02');
  assert.equal(pdh?.coverage.openAt, Date.parse('2026-07-02T13:30:00Z'));
  assert.equal(pdh?.coverage.closeAt, Date.parse('2026-07-02T20:00:00Z'));
});

test('extended-hours levels are stated as UNMEASURABLE rather than left out', () => {
  assert.deepEqual(NOT_COMPUTED_LEVELS.map((l) => l.name), ['PREMARKET_HIGH', 'PREMARKET_LOW', 'OVERNIGHT_HIGH', 'OVERNIGHT_LOW']);
  for (const l of NOT_COMPUTED_LEVELS) {
    assert.equal(l.status, 'UNMEASURABLE');
    assert.match(l.reason, /No extended-hours bar source is known to exist/);
  }
});

test('look-ahead guard on every fixture above', () => {
  const half = [...bars15(et('2026-11-27', 9, 30), 14, () => [101, 99]), ...bars15(et('2026-11-27', 13, 0), 3, () => [108, 90])];
  const fixtures: [string, Bar[]][] = [
    ['full', [PRE, ...FULL, ...NEXT]],
    ['holed', [...FULL.slice(0, 25), ...NEXT]],
    ['half-day', half],
    ['coverage-edge', [...bars15(et('2027-12-31', 15, 0), 4, () => [101, 99]), ...bars15(et('2028-01-03', 9, 30), 2, () => [101, 99])]],
  ];
  for (const [name, bars] of fixtures) {
    assertPrefixStable(`levels/${name}`, bars.map((b) => b.closedAt), (asOf) => detectSessionLevels(closedBy(bars, asOf)));
  }
});
