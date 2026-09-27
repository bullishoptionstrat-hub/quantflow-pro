/**
 * "Is the market open" was answered in the browser, by a clock.
 *
 * `frontend/lib/utils.ts` held `isRegularHours()` — a weekday test and a
 * hardcoded 09:30–16:00 window — and the sidebar painted its result green. Its
 * own docstring named the cost: "Thanksgiving, Good Friday and every other full
 * closure read as open, and half-days read as open past the 13:00 close."
 * CLAUDE.md records the function being *renamed* rather than fixed, because "a
 * calendar is a thing to maintain".
 *
 * A calendar is now maintained. This is the same shape as the rights-lineage
 * finding: the backend knows, and the browser was guessing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { marketSessionAt, minutesEt } from '../src/market/session';

/** An instant, given in market-local terms. EDT is UTC-4, EST is UTC-5. */
const edt = (date: string, hhmm: string) =>
  Date.parse(`${date}T${String(Number(hhmm.slice(0, 2)) + 4).padStart(2, '0')}:${hhmm.slice(3)}:00Z`);
const est = (date: string, hhmm: string) =>
  Date.parse(`${date}T${String(Number(hhmm.slice(0, 2)) + 5).padStart(2, '0')}:${hhmm.slice(3)}:00Z`);

test('a regular session is open between its published bounds', () => {
  // Thu 2026-09-24.
  assert.equal(marketSessionAt(edt('2026-09-24', '09:29')).state, 'CLOSED_OUTSIDE_HOURS');
  assert.equal(marketSessionAt(edt('2026-09-24', '09:30')).state, 'OPEN');
  assert.equal(marketSessionAt(edt('2026-09-24', '15:59')).state, 'OPEN');
  // The close is exclusive: at 16:00 the session is over.
  assert.equal(marketSessionAt(edt('2026-09-24', '16:00')).state, 'CLOSED_OUTSIDE_HOURS');

  const s = marketSessionAt(edt('2026-09-24', '12:00'));
  assert.equal(s.openMinutesEt, 9 * 60 + 30);
  assert.equal(s.closeMinutesEt, 16 * 60);
  assert.equal(s.date, '2026-09-24');
});

test('a half-day closes at 13:00, and the old check was wrong all afternoon', () => {
  // THE case. 2026-11-27 is the published early close. The deleted
  // `isRegularHours()` returned true until 16:00 on this date.
  const half = '2026-11-27';
  assert.equal(marketSessionAt(est(half, '12:59')).state, 'OPEN');
  assert.equal(marketSessionAt(est(half, '13:00')).state, 'CLOSED_OUTSIDE_HOURS');
  assert.equal(marketSessionAt(est(half, '15:00')).state, 'CLOSED_OUTSIDE_HOURS',
    'three hours the browser used to paint green');
  assert.equal(marketSessionAt(est(half, '12:00')).closeMinutesEt, 13 * 60);
  // And the open is unchanged — a half-day is a short afternoon, not a late
  // start, which is why the table carries the open rather than assuming it.
  assert.equal(marketSessionAt(est(half, '12:00')).openMinutesEt, 9 * 60 + 30);
});

test('a published holiday is closed all day, not open at noon', () => {
  // Thanksgiving 2026 is Thursday the 26th — a weekday, at midday, which is
  // exactly when the weekday-and-clock check said REGULAR HOURS in green.
  const s = marketSessionAt(est('2026-11-26', '12:00'));
  assert.equal(s.state, 'CLOSED_HOLIDAY');
  assert.match(s.basis, /published exchange holiday/);
  assert.equal(s.openMinutesEt, null, 'a closure has no session bounds to report');
  assert.equal(s.closeMinutesEt, null);
});

test('a weekend is closed, and named as a weekend rather than as a holiday', () => {
  // Two facts, two states. Collapsing them would tell a reader to check a
  // holiday schedule to find out it is Saturday.
  assert.equal(marketSessionAt(edt('2026-09-26', '12:00')).state, 'CLOSED_WEEKEND');
  assert.equal(marketSessionAt(edt('2026-09-27', '12:00')).state, 'CLOSED_WEEKEND');
});

test('a date the calendar will not answer for is UNKNOWN, never closed', () => {
  // The load-bearing assertion, and the same rule `coverage.ts` follows: a
  // reader who converts "cannot say" into "closed" has been told something
  // nobody established. 2027-11-25 would be Thanksgiving if the table were
  // extrapolated, and 2027-11-27 is a Saturday — arithmetic anyone could do.
  for (const d of ['2027-01-15', '2027-11-25', '2027-11-27', '2025-12-19']) {
    const s = marketSessionAt(est(d, '12:00'));
    assert.equal(s.state, 'UNKNOWN', `${d} is outside coverage`);
    assert.match(s.basis, /outside the calendar's coverage/);
  }
  const unreadable = marketSessionAt(Number.NaN);
  assert.equal(unreadable.state, 'UNKNOWN');
  assert.equal(unreadable.date, null);
});

test('the verdict carries its provenance, because it is an external fact', () => {
  const s = marketSessionAt(edt('2026-09-24', '12:00'));
  assert.match(s.source, /NYSE|Cboe/);
  assert.match(s.readAt, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(s.coverage.from, '2026-01-01');
  assert.equal(s.coverage.to, '2026-12-31');
  assert.match(s.basis, /regular session/);
});

test('the ET clock is read from the zone, not from the host offset', () => {
  // 2026-09-27T03:00:00Z is 23:00 on the 26th in New York. A host in UTC
  // reading local hours would answer 03:00 and put the verdict a day out.
  assert.equal(minutesEt(Date.parse('2026-09-27T03:00:00Z')), 23 * 60);
  assert.equal(minutesEt(Date.parse('2026-09-27T04:00:00Z')), 0, 'midnight is 0, not 1440');
  assert.equal(minutesEt(Number.NaN), null);
  assert.equal(minutesEt(8.64e15 * 2), null);
});

test('/api/health publishes it, and the calendar stays clock-free', () => {
  // The recurring failure here is correct code nothing calls — `recordGap` had
  // no writer, `listUngraded` no caller, `summariseCoverage` no reader. Every
  // test above would pass with the route never wired.
  const route = readFileSync(join(__dirname, '..', 'src', 'routes', 'health.ts'), 'utf8');
  assert.match(route, /marketSessionAt\(Date\.now\(\)\)/, '/api/health computes the verdict');
  assert.match(route, /session:/, 'and publishes it under `session`');

  // And the table itself must not acquire a clock: `sessionOn` takes a date
  // string precisely so no timezone rule hides in a lookup, and this module is
  // separate for that reason.
  const cal = readFileSync(
    join(__dirname, '..', 'src', 'flow-engine', 'calendar.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\/|^[ \t]*\/\/.*$/gm, '');
  assert.ok(!/Date\.now\(\)/.test(cal),
    'calendar.ts must not read the clock — that is this module\'s job');
});

test('the bounds are read from the table, not written here', () => {
  // Found by a mutation that PASSED: hardcoding the open to 09:30 changes
  // nothing observable, because every session in this table opens at 09:30, so
  // the literal is *equivalent* to the lookup. That does not make it harmless —
  // the whole argument for carrying `openHour` as data is that an assumed open
  // is what let a green dot survive past a 13:00 close, and an argument nothing
  // can check is a comment that drifts.
  //
  // So the coupling is asserted in source, the way `coverage.ts` requires every
  // MARKET_CLOSED to sit downstream of `closureThroughout`. A behavioural test
  // cannot reach this while the table is uniform; the day it stops being
  // uniform is the day a hardcode becomes wrong, and by then nobody is looking.
  const code = readFileSync(join(__dirname, '..', 'src', 'market', 'session.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\/|^[ \t]*\/\/.*$/gm, '');

  assert.match(code, /s\.openHour \* 60 \+ s\.openMinute/,
    'the open comes from the session, not from a literal');
  assert.match(code, /s\.closeHour \* 60 \+ s\.closeMinute/,
    'and so does the close');
  // No clock window may be written in this file at all — 570 and 960 are the
  // minutes the deleted `isRegularHours()` hardcoded.
  assert.ok(!/\b(570|960)\b/.test(code),
    'no hardcoded session window: those were isRegularHours() own literals');
  assert.ok(!/\b9\s*\*\s*60\s*\+\s*30\b/.test(code),
    'nor a rebuilt 09:30');
  assert.ok(!/\b16\s*\*\s*60\b/.test(code), 'nor a rebuilt 16:00');
});
