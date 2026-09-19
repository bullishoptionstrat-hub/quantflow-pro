/**
 * An option's expiry date becomes an instant in ONE place, and that instant is
 * 16:00 in New York rather than a fixed UTC hour.
 *
 * Three call sites parsed `${isoDate}T20:00:00Z` under the comment
 * "~4pm ET close". Measured, that comment is false for about five months of
 * the year: 20:00Z is 16:00 ET only while daylight saving is in force, and
 * 15:00 ET under EST.
 *
 * The consequence is small and the commit says so rather than implying
 * otherwise — DTE buckets at 2/7/21/45 days flipped on 0.16% of sampled trade
 * instants, worth at most 3 points of 100. It is fixed because it is exactly
 * fixable without a calendar to maintain, and because a false comment is its
 * own defect in this repository.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expiryInstantMs, daysToExpiry } from '../src/flow-engine/expiry';

const nyHour = (ms: number) => Number(
  new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: '2-digit', hour12: false,
  }).format(new Date(ms)),
);

const nyDate = (ms: number) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(ms));

test('the expiry instant is 16:00 New York on both sides of a DST boundary', () => {
  // 2026 US DST: begins Mar 8, ends Nov 1. One date either side of each.
  for (const d of ['2026-01-16', '2026-03-06', '2026-03-20', '2026-06-19',
                   '2026-10-16', '2026-11-20', '2026-12-18']) {
    const t = expiryInstantMs(d);
    assert.ok(!Number.isNaN(t), `${d} resolved`);
    assert.equal(nyHour(t), 16, `${d} is 16:00 in New York`);
    assert.equal(nyDate(t), d, `${d} lands on its own date`);
  }
});

test('a winter expiry is an hour later than the old fixed-UTC assumption', () => {
  // The defect, stated as a number: under EST the old parse was an hour early.
  const winter = expiryInstantMs('2026-01-16');
  const oldWay = Date.parse('2026-01-16T20:00:00Z');
  assert.equal((winter - oldWay) / 3_600_000, 1);
  assert.equal(nyHour(oldWay), 15, 'which is 15:00 ET, not the "~4pm" claimed');

  // And a summer expiry is unchanged, which is why this survived: the code
  // was correct exactly when anyone was likely to look at it.
  const summer = expiryInstantMs('2026-06-19');
  assert.equal(summer, Date.parse('2026-06-19T20:00:00Z'));
});

test('an unreadable date is NaN, not a fabricated instant', () => {
  // The round-trip is what rejects these: a loose date that `Date.parse` does
  // read formats back canonically and stops matching what was passed. A
  // date-shape regex in front of it was deleted for failing no test.
  for (const bad of ['', 'not-a-date', '2026-6-19', ' 2026-06-19', '2026-06-19 ',
                     '20260619', '2026-13-99', '2026-06-19T10:00:00Z']) {
    const t = expiryInstantMs(bad);
    assert.ok(Number.isNaN(t), `${JSON.stringify(bad)} must not resolve`);
    assert.ok(Number.isNaN(daysToExpiry(Date.now(), bad)));
  }
});

test('daysToExpiry floors at zero and counts forward', () => {
  const t = expiryInstantMs('2026-06-19');
  assert.equal(daysToExpiry(t, '2026-06-19'), 0, 'at the close');
  assert.equal(daysToExpiry(t + 86_400_000, '2026-06-19'), 0, 'after it, floored');
  assert.equal(daysToExpiry(t - 86_400_000, '2026-06-19'), 1);
  assert.equal(daysToExpiry(t - 7 * 86_400_000, '2026-06-19'), 7);
});

test('no call site parses a fixed UTC hour for an expiry any more', () => {
  // The rule had three homes and two of them disagreed about rounding as well
  // as about the hour. This bans the shape rather than the one literal.
  const files = [
    'src/flow-engine/score.ts',
    'src/flow-engine/outcome/tracker.ts',
    'src/ingestion/flowEngineAdapter.ts',
  ];
  for (const f of files) {
    const src = readFileSync(join(__dirname, '..', f), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
    assert.doesNotMatch(code, /T\d{2}:\d{2}:\d{2}Z`/,
      `${f} still builds an expiry instant from a fixed UTC hour`);
  }
});

test('the module copy carries the same rule, with ESM extensions', () => {
  // `vendorMirror.test.ts` holds the two byte-identical modulo extensions, so
  // a new engine file that exists on only one side is a mirror failure. This
  // is the cheaper, more specific failure message.
  const mod = join(__dirname, '..', '..', 'quantflow-modules', 'flow-engine', 'src');
  const src = readFileSync(join(mod, 'expiry.ts'), 'utf8');
  assert.match(src, /export function expiryInstantMs/);
  assert.match(readFileSync(join(mod, 'score.ts'), 'utf8'), /from "\.\/expiry\.js"/,
    'the ESM copy imports with an extension');
});
