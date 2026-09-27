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
  marketDateOf, closureThroughout, MARKET_TZ,
} from '../src/flow-engine/calendar';

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
    join(__dirname, '..', 'src', 'flow-engine', 'calendar.ts'), 'utf8',
  );
  assert.match(src, /AM-settled/, 'the settlement gap is named in the file');
  assert.ok(!/settlement[A-Za-z]*\s*[:(]/.test(
    src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, ''),
  ), 'and the code exports no settlement answer it cannot support');
});

// ─── Instants, and spans of them ────────────────────────────────────────────

test('an instant becomes the date it is in New York, not the date it is in UTC', () => {
  // The whole reason `marketDateOf` exists as its own function rather than
  // `sessionOn` accepting an epoch. Between 19:00 and midnight ET the UTC date
  // has already rolled over, so a caller deriving the date from UTC asks about
  // the wrong session — and gets a confident answer.
  //
  // 2026-09-26T03:00:00Z is 23:00 on Friday the 25th in New York.
  assert.equal(marketDateOf(Date.parse('2026-09-26T03:00:00Z')), '2026-09-25');
  assert.equal(sessionOn(marketDateOf(Date.parse('2026-09-26T03:00:00Z'))!).kind, 'REGULAR',
    'Friday night is still Friday, a regular session');

  // And the naive read is the Saturday, which is the error this prevents.
  assert.equal(new Date('2026-09-26T03:00:00Z').toISOString().slice(0, 10), '2026-09-26');
});

test('an unreadable instant is null, not today', () => {
  // The `?? 0` move with a clock instead of a price: a caller handed a broken
  // timestamp must not be told what day it is in New York, because the answer
  // would be about a different instant than the one it asked about.
  assert.equal(marketDateOf(Number.NaN), null);
  assert.equal(marketDateOf(Number.POSITIVE_INFINITY), null);
  assert.equal(marketDateOf(8.64e15 * 2), null, 'past the Date range');
});

test('a span is a closure only when every date in it is one', () => {
  const on = (iso: string) => Date.parse(iso);

  // A single Saturday.
  assert.equal(closureThroughout(
    on('2026-09-26T16:00:00Z'), on('2026-09-26T16:01:00Z')).closed, true);

  // The whole weekend.
  assert.equal(closureThroughout(
    on('2026-09-26T05:00:00Z'), on('2026-09-27T23:00:00Z')).closed, true);

  // Friday evening into the weekend: Friday was an open session.
  const spill = closureThroughout(on('2026-09-25T20:00:00Z'), on('2026-09-27T23:00:00Z'));
  assert.equal(spill.closed, false);
  assert.match(spill.basis, /regular session/);

  // Thanksgiving alone is closed; Thanksgiving into the half-day after is not,
  // because an early close is an open session.
  assert.equal(closureThroughout(
    on('2026-11-26T14:00:00Z'), on('2026-11-26T23:00:00Z')).closed, true);
  assert.equal(closureThroughout(
    on('2026-11-26T14:00:00Z'), on('2026-11-27T19:00:00Z')).closed, false);
});

test('a span crossing the DST change still checks every date in it', () => {
  // 2026-11-01 is the DST end, so that day is 25 hours long in New York. A
  // fixed-86,400,000ms step over a 25-hour day can walk past a date, and a
  // date not looked at is a date not checked — which in a rule that needs
  // EVERY date to be a closure fails in the permissive direction.
  //
  // Sat 2026-10-31 through Sun 2026-11-01: both weekend, so closed...
  assert.equal(closureThroughout(
    Date.parse('2026-10-31T05:00:00Z'), Date.parse('2026-11-02T04:00:00Z')).closed, true);
  // ...and one minute further is Monday the 2nd in New York, which is not.
  const intoMonday = closureThroughout(
    Date.parse('2026-10-31T05:00:00Z'), Date.parse('2026-11-02T05:01:00Z'));
  assert.equal(intoMonday.closed, false);
  assert.match(intoMonday.basis, /2026-11-02/);
});

test('an absurd span is refused rather than walked', () => {
  // A gap row whose `startedAt` is the epoch would otherwise walk twenty
  // thousand days. The walk already stops at the first date that is not a
  // closure — which outside COVERAGE is the first date it looks at — so this
  // bound is belt and braces, and it is stated because "no closure runs that
  // long" is the claim it rests on.
  const r = closureThroughout(0, Date.parse('2026-09-26T16:00:00Z'));
  assert.equal(r.closed, false);
  assert.match(r.basis, /longer than any run of closures/);

  // Reversed and unreadable bounds are refused, not swapped or defaulted.
  assert.equal(closureThroughout(
    Date.parse('2026-09-27T00:00:00Z'), Date.parse('2026-09-26T00:00:00Z')).closed, false);
  assert.equal(closureThroughout(Number.NaN, 0).closed, false);
});

test('the market timezone has exactly one declaration', () => {
  // `expiry.ts` used to carry its own `MARKET_TZ` because it could not import
  // across the vendored boundary. Moving the calendar INTO the engine removes
  // that excuse, so the coupling is collapsed rather than held in agreement —
  // which is the better version of the `outcomeDecision.test.ts` move: nothing
  // left to disagree.
  assert.equal(MARKET_TZ, 'America/New_York');
  const expiry = readFileSync(
    join(__dirname, '..', 'src', 'flow-engine', 'expiry.ts'), 'utf8');
  assert.ok(!/const\s+MARKET_TZ\s*=/.test(expiry),
    'expiry.ts must not redeclare the zone — it imports it from ./calendar');
  assert.match(expiry, /import\s*\{[^}]*MARKET_TZ[^}]*\}\s*from\s*["']\.\/calendar["']/,
    'and it must actually import it, or the constant is unused and the zone is ' +
    'wherever Intl happens to default');
});

test('the calendar and the expiry fallback agree about the regular close', () => {
  // `expiry.ts` keeps a `CLOSE_HOUR = 16` as the fallback for a date the
  // calendar will not answer for. If the table's REGULAR close ever moved, the
  // fallback would silently disagree with every answered date — two homes for
  // one number, which is the defect this repo keeps closing.
  const regular = sessionOn('2026-09-24');
  assert.equal(regular.kind, 'REGULAR');
  const expiry = readFileSync(
    join(__dirname, '..', 'src', 'flow-engine', 'expiry.ts'), 'utf8');
  const h = expiry.match(/const\s+CLOSE_HOUR\s*=\s*(\d+)/);
  const m = expiry.match(/const\s+CLOSE_MINUTE\s*=\s*(\d+)/);
  assert.ok(h && m, 'expiry.ts declares its fallback close');
  assert.equal(Number(h![1]), regular.closeHour);
  assert.equal(Number(m![1]), regular.closeMinute);
});
