/**
 * The calendar must fail loud at its own edge, and that is most of what these
 * check.
 *
 * This repository declined a holiday calendar twice, and the stated reason was
 * never that calendars are wrong — it was that an *assumed* one keeps
 * answering confidently after the year it was written for has passed, and that
 * a session wrongly called closed turns missing data into data nobody
 * expected. That failure is silent and it flatters every rate computed over
 * the window.
 *
 * So the load-bearing property is not "Thanksgiving is a holiday". It is
 * "2027-11-25 is UNKNOWN".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  sessionOn, isEstablishedClosure, COVERAGE, SOURCE, READ_AT,
} from '../src/market/calendar';

test('a date past the coverage window is UNKNOWN, never extrapolated', () => {
  for (const d of ['2027-11-25', '2027-01-01', '2025-12-31', '2030-07-04']) {
    const s = sessionOn(d);
    assert.equal(s.kind, 'UNKNOWN', `${d} is outside ${COVERAGE.from}..${COVERAGE.to}`);
    assert.equal(s.closeHour, null, 'and carries no close time to be misread');
    assert.match(s.basis, /outside the calendar's coverage/);
    assert.match(s.basis, new RegExp(COVERAGE.to), 'the bound is named in the reason');
  }
});

test('UNKNOWN is not a synonym for closed', () => {
  // The dangerous conflation. A caller that reads "not open" out of "cannot
  // say" writes MARKET_CLOSED over an outage, which is the flattering
  // direction `coverage.ts` refuses by name.
  assert.equal(sessionOn('2027-11-25').kind, 'UNKNOWN');
  assert.equal(isEstablishedClosure('2027-11-25'), false,
    'an unknown date is not an established closure');
  // And a real closure still reads as one.
  assert.equal(isEstablishedClosure('2026-11-26'), true, 'Thanksgiving 2026');
  assert.equal(isEstablishedClosure('2026-01-03'), true, 'a Saturday');
});

test('the holidays the old weekday-and-clock check got wrong', () => {
  // CLAUDE.md records the failure this replaces: "a MARKET OPEN indicator
  // green on Thanksgiving and through a half-day's afternoon".
  assert.equal(sessionOn('2026-11-26').kind, 'HOLIDAY', 'Thanksgiving');
  assert.equal(sessionOn('2026-12-25').kind, 'HOLIDAY', 'Christmas');
  assert.equal(sessionOn('2026-04-03').kind, 'HOLIDAY', 'Good Friday');

  // The half-day afternoon, which a weekday check calls open.
  const bf = sessionOn('2026-11-27');
  assert.equal(bf.kind, 'EARLY_CLOSE', 'the day after Thanksgiving');
  assert.equal(bf.closeHour, 13);
  assert.equal(bf.closeMinute, 0);
});

test('an observed holiday is recorded on the date the market actually shut', () => {
  // July 4 2026 is a Saturday, so the exchange observes it on Friday the 3rd.
  // Encoding the statutory date instead would call an open Friday closed and
  // a closed... nothing, since Saturday is already a weekend — silently
  // losing the closure entirely.
  assert.equal(sessionOn('2026-07-03').kind, 'HOLIDAY', 'observed Friday');
  assert.equal(sessionOn('2026-07-04').kind, 'WEEKEND', 'the statutory Saturday');
});

test('a regular session is plainly regular', () => {
  // A marker that is always on is a marker nobody reads.
  const s = sessionOn('2026-03-17');
  assert.equal(s.kind, 'REGULAR');
  assert.equal(s.closeHour, 16);
});

test('a malformed date is UNKNOWN rather than parsed loosely', () => {
  for (const d of ['2026-13-45', 'tomorrow', '', '2026/11/26', '2026-11-26T12:00:00Z']) {
    assert.equal(sessionOn(d).kind, 'UNKNOWN', `${d} must not be guessed at`);
  }
});

test('the table declares its provenance, because a market fact is versioned data', () => {
  // §15: never bury a changeable market fact in a comment.
  assert.ok(SOURCE.length > 10, 'the source is named');
  assert.match(READ_AT, /^\d{4}-\d{2}-\d{2}$/, 'and carries a read date');
  assert.ok(new Date(READ_AT).getTime() <= Date.now(),
    'a reading that has not happened is not provenance');

  // The window must be a real, ordered range.
  assert.ok(COVERAGE.from < COVERAGE.to);
});

test('the calendar does not claim to answer settlement questions', () => {
  // F-10's other half. An AM-settled SPX monthly stops trading the preceding
  // Thursday, which is a product fact this table knows nothing about — and
  // saying so in the file is what stops the next reader wiring it into
  // `expiryInstant` and believing the problem is closed.
  const src = readFileSync(
    join(__dirname, '..', 'src', 'market', 'calendar.ts'), 'utf8',
  );
  assert.match(src, /AM-settled/, 'the settlement gap is named in the file');
  assert.ok(!/settlement[A-Za-z]*\s*[:(]/.test(
    src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, ''),
  ), 'and the code exports no settlement answer it cannot support');
});
