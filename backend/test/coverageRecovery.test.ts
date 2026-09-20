/**
 * A process that sleeps cannot close its own coverage window, so the next one
 * claims it. (INV-011)
 *
 * `CoverageRecorder` extends an open gap in place each tick. Its docstring
 * claimed a dying process "will under-report the tail by at most one tick".
 * **The live database refutes that**, measured on 2026-09-20 over a
 * 4,160-minute span of recorded signals:
 *
 *   9 gap rows, 126 minutes total            =  3.03% of the span
 *   every row the SAME ~14-minute duration   -> freeze-at-sleep, not real
 *                                               outage lengths
 *   longest silence in signal_history with
 *   NO gap row covering it                   =  1,978 min (33 hours)
 *
 * The mechanism: the host sleeps after 15 minutes idle, the open gap freezes
 * at its last extent — so its `endedAt` becomes a positive claim that
 * collection resumed then — and on wake `lastTickAt` is null, so the first
 * tick writes nothing and the next window starts at the WAKE instant. The
 * sleep is attributed to nobody.
 *
 * That is the bias `collection_gaps` exists to prevent, reproduced by the
 * recorder itself: ~97% of non-collecting time read as observed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { recoverMissedWindow, CoverageRecorder } from '../src/persistence/coverage';

const T0 = Date.UTC(2026, 8, 16, 10, 4, 0);
const MIN = 60_000;

test('the window a slept process left behind is claimed by the next boot', () => {
  // The real shape: last evidence at 10:04, next boot 33 hours later.
  const wake = T0 + 1_978 * MIN;
  const gap = recoverMissedWindow(T0, wake, 'run2');

  assert.ok(gap, 'the hole is claimed, not left unattributed');
  assert.equal(gap.kind, 'NOT_OBSERVED');
  assert.equal(gap.startedAt, T0, 'from the last thing the deployment can show');
  assert.equal(gap.endedAt, wake, 'to the instant this process could first look');
  assert.equal(gap.endedAt - gap.startedAt, 1_978 * MIN,
    'the whole 33 hours, not one tick of it');
  assert.match(gap.reason, /sleeps when idle|without closing/i);
});

test('a first-ever boot invents nothing', () => {
  // The same rule `tick()`'s first call follows: there is no window before the
  // first one, and inventing it would date the gap to the epoch.
  assert.equal(recoverMissedWindow(null, T0, 'run1'), null);
  assert.equal(recoverMissedWindow(0, T0, 'run1'), null);
  assert.equal(recoverMissedWindow(Number.NaN, T0, 'run1'), null);
});

test('an ordinary redeploy is not an outage', () => {
  // A few seconds between processes is a deploy, not a window of missing
  // market data. Claiming one per restart would make the table unreadable,
  // which is the same argument that made contiguous windows one row.
  assert.equal(recoverMissedWindow(T0, T0 + 30_000, 'run2'), null);
  assert.equal(recoverMissedWindow(T0, T0 + 90_000, 'run2'), null);
  assert.ok(recoverMissedWindow(T0, T0 + 5 * MIN, 'run2'), 'five minutes is a gap');
});

test('the claimed window abuts the last evidence, leaving no unattributed hole', () => {
  // The defect was an interval belonging to nobody. Whatever the recovered gap
  // does, it must not reintroduce one: it starts exactly where the evidence
  // ended.
  const lastEvidence = T0;
  const wake = T0 + 200 * MIN;
  const gap = recoverMissedWindow(lastEvidence, wake, 'run2')!;
  assert.equal(gap.startedAt, lastEvidence);

  // And the live recorder then takes over from the wake instant, so the two
  // meet rather than overlap or leave a hole.
  const rec = new CoverageRecorder('run2');
  assert.equal(rec.tick({ recorded: 0, collecting: false, reason: 'no recordable source connected' }, wake), null,
    'the first tick still only establishes a baseline');
  const next = rec.tick({ recorded: 0, collecting: false, reason: 'no recordable source connected' }, wake + MIN);
  assert.ok(next);
  assert.equal(next.startedAt, wake, 'the live recorder resumes exactly where recovery stopped');
});

test('startup actually calls it, before the tick loop', () => {
  // The recurring failure in this repository is correct code nothing calls:
  // `recordGap` itself shipped with three CHECK constraints and no writer, and
  // `listUngraded` was implemented twice and invoked never. Every test above
  // would pass in exactly that state. This is the one that would not.
  const src = readFileSync(
    join(__dirname, '..', 'src', 'ingestion', 'index.ts'), 'utf8',
  );
  const start = src.indexOf('function startSignalHistory');
  assert.ok(start > 0);
  const body = src.slice(start);

  const recoverAt = body.indexOf('recoverMissedWindow(');
  assert.ok(recoverAt > 0,
    'startSignalHistory must claim the missed window — without it a sleep is ' +
    'attributed to nobody and reads as observed');

  const tickAt = body.indexOf('coverage?.tick(');
  assert.ok(tickAt > 0);
  assert.ok(recoverAt < tickAt, 'the missed window is claimed before the loop resumes');
  assert.match(body.slice(recoverAt - 400, recoverAt), /lastRecordedActivity/,
    'and it is given the deployment\'s own last evidence, not a guess');
});

test('the docstring no longer claims a one-tick tail', () => {
  // It said the under-report was "at most one tick". The live database
  // measured ~97%. A comment that is false is the defect this repository
  // treats most seriously, because everything downstream trusts it.
  const src = readFileSync(
    join(__dirname, '..', 'src', 'persistence', 'coverage.ts'), 'utf8',
  );
  assert.doesNotMatch(src, /under-report the tail by at most one tick, which is the\n \* honest failure/,
    'the refuted claim must not survive the fix that refutes it');
  assert.match(src, /1,978 min|33 h/, 'and the measurement that refuted it is recorded');
});
