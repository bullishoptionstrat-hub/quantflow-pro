/**
 * A daily budget that resets once is a budget that runs out.
 *
 * Four connectors meter themselves against a free tier's daily quota
 * (`marketData` 90 credits, `newsApi` 95 requests, `fmp` 240, `flashAlpha` 5),
 * and all four armed the reset with a one-shot `setTimeout` to the next
 * midnight. The counter was zeroed once, at the first midnight after start,
 * and never again — while the counter itself only climbs.
 *
 * So the connector reaches its limit on day two or three and stops fetching
 * for the rest of the process's life. Three of the four also latch the counter
 * to its limit on a 429/402 to stop for the day, which under a one-shot reset
 * means one rate-limited response ends the connector permanently.
 *
 * None of it is visible: `startConnector` records what `start()` returned once
 * and never looks again, so a connector that stopped fetching on day three is
 * still reported as `connected` — the finding that gave Stooq `onStooqHealth`,
 * arrived at from the other direction.
 *
 * `flashAlpha` carried a second half of the same defect. Its staggered batch
 * ran once from `startFlashAlpha` and it has no recurring poller at all, so
 * its GEX was fetched once per process and then aged forever. A daily counter
 * reset only means something if the budget is spent again, so the reset now
 * drives the batch.
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { msUntilNextMidnight, scheduleDailyReset } from '../src/ingestion/dailyReset';

const CONNECTORS = join(__dirname, '..', 'src', 'ingestion', 'connectors');
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');

/** The connectors that meter themselves against a daily quota. */
const METERED = ['marketData.ts', 'newsApi.ts', 'fmp.ts', 'flashAlpha.ts'];

test('the reset fires on every midnight, not just the first', () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    let resets = 0;
    const handle = scheduleDailyReset(() => { resets++; });

    // Three days. The old one-shot timer scored 1 here.
    for (let day = 0; day < 3; day++) mock.timers.tick(24 * 60 * 60 * 1000);

    assert.equal(resets, 3, 'a daily budget must reset every day');
    handle.cancel();
  } finally {
    mock.timers.reset();
  }
});

test('cancelling stops it re-arming', () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    let resets = 0;
    const handle = scheduleDailyReset(() => { resets++; });
    mock.timers.tick(24 * 60 * 60 * 1000);
    handle.cancel();
    mock.timers.tick(3 * 24 * 60 * 60 * 1000);
    assert.equal(resets, 1);
  } finally {
    mock.timers.reset();
  }
});

test('a throwing reset still re-arms, rather than ending the schedule', () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    let calls = 0;
    const handle = scheduleDailyReset(() => {
      calls++;
      if (calls === 1) throw new Error('first reset failed');
    });
    assert.throws(() => mock.timers.tick(24 * 60 * 60 * 1000));
    mock.timers.tick(24 * 60 * 60 * 1000);
    assert.ok(calls >= 2, `one bad reset must not end the daily cycle (fired ${calls}x)`);
    handle.cancel();
  } finally {
    mock.timers.reset();
  }
});

test('the delay to midnight is always positive', () => {
  // A DST fall-back can put the computed local midnight behind `now`. A
  // negative delay fires immediately, and a self-re-arming timer that fires
  // immediately is a spin.
  for (const iso of [
    '2026-01-01T00:00:00', '2026-06-15T23:59:59',
    '2026-03-08T02:30:00', '2026-11-01T01:30:00',
  ]) {
    const ms = msUntilNextMidnight(new Date(iso).getTime());
    assert.ok(ms >= 1000, `${iso} -> ${ms}ms`);
    assert.ok(ms <= 25 * 60 * 60 * 1000, `${iso} -> ${ms}ms`);
  }
});

test('no metered connector arms its daily reset with a one-shot timer', () => {
  const offenders: string[] = [];
  for (const f of METERED) {
    const src = stripComments(readFileSync(join(CONNECTORS, f), 'utf8'));
    if (/msUntilMidnight/.test(src)) offenders.push(`${f} (hand-rolled midnight timer)`);
    if (!/scheduleDailyReset\(/.test(src)) offenders.push(`${f} (no recurring reset)`);
  }
  assert.deepEqual(offenders, [], offenders.join(', '));
});

test('the metered list is every connector that keeps a daily counter', () => {
  // The rule must not stop at a hand-written list the way the zero-fill guard
  // did. Any connector comparing a counter against a daily limit belongs here.
  const metered = readdirSync(CONNECTORS)
    .filter((f) => f.endsWith('.ts'))
    .filter((f) => /DAILY|dailyCallCount|dailyRequests|creditsUsed/
      .test(stripComments(readFileSync(join(CONNECTORS, f), 'utf8'))));
  assert.deepEqual(metered.sort(), [...METERED].sort());
});

test('every connector timer releases the event loop, setTimeout included', () => {
  // `missingIsNotZero.test.ts` closed this for `setInterval`. Its scan looked
  // for that name only, so four module-level `setTimeout`s — one per metered
  // connector, up to 24 hours long — walked straight past it and held the Node
  // event loop open exactly as the intervals had.
  const offenders: string[] = [];

  for (const f of readdirSync(CONNECTORS).filter((n) => n.endsWith('.ts'))) {
    const src = readFileSync(join(CONNECTORS, f), 'utf8');
    for (const fn of ['setInterval(', 'setTimeout(']) {
      let i = src.indexOf(fn);
      while (i !== -1) {
        // A `setTimeout` awaited as a promise (`new Promise(r => setTimeout(r,
        // n))`) is a sleep the caller is already blocked on, not a timer
        // holding the loop open past the work.
        const line = src.slice(src.lastIndexOf('\n', i) + 1, src.indexOf('\n', i));
        if (/new Promise|=>\s*setTimeout\(r/.test(line)) { i = src.indexOf(fn, i + 1); continue; }

        // Walk to the matching close paren rather than the next `;`.
        let depth = 0;
        let j = src.indexOf('(', i);
        for (; j < src.length; j++) {
          if (src[j] === '(') depth++;
          else if (src[j] === ')' && --depth === 0) break;
        }
        if (!src.slice(j, j + 20).startsWith(').unref()')) {
          offenders.push(`${f}:${src.slice(0, i).split('\n').length}`);
        }
        i = src.indexOf(fn, i + 1);
      }
    }
  }

  assert.deepEqual(offenders, [], `timers holding the event loop open: ${offenders.join(', ')}`);
});
