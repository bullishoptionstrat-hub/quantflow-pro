/**
 * A store request that never answers must fail, not stall grading forever.
 *
 * supabase-js uses plain `fetch`, which has no timeout, and the grader awaits
 * each write inside a tick that runs one at a time. One swallowed request
 * therefore stopped every later checkpoint. `boundedFetch` turns it into an
 * ordinary failed write, which the grader retries or reconciles.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { boundedFetch } from '../src/persistence/boundedFetch';
import { SupabaseSignalStore } from '../src/persistence/supabaseStore';
import { SignalGrader, HORIZON_OFFSETS_MS, type Mark } from '../src/persistence/grader';
import type { SignalRecord } from '../src/persistence/types';

// The timeout timer is unref'd, as every timer here is, and the fake request
// below holds no socket, so nothing would keep the event loop alive while a
// test waits. A real request holds its socket; this stands in for it.
const keepAlive = setInterval(() => {}, 1_000);
after(() => clearInterval(keepAlive));

/** A fetch that never answers, and rejects the way real fetch does on abort. */
const hung: typeof fetch = (_input, init) =>
  new Promise((_resolve, reject) => {
    const s = init?.signal;
    if (s?.aborted) return reject(s.reason);
    s?.addEventListener('abort', () => reject(s.reason), { once: true });
  });

test('a request that never answers is abandoned after the timeout', { timeout: 5_000 }, async () => {
  const t0 = Date.now();
  await assert.rejects(boundedFetch(50, hung)('http://store.invalid/x'), /exceeded 50ms/);
  assert.ok(Date.now() - t0 < 2_000, 'it gave up promptly');
});

test('a caller abort still reaches the request', async () => {
  const ctl = new AbortController();
  const p = boundedFetch(60_000, hung)('http://store.invalid/x', { signal: ctl.signal });
  ctl.abort(new Error('caller gave up'));
  await assert.rejects(p, /caller gave up/);
});

test('an answer inside the limit passes through untouched', async () => {
  const ok: typeof fetch = async () => new Response('{"a":1}', { status: 200 });
  const res = await boundedFetch(1_000, ok)('http://store.invalid/x');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { a: 1 });
});

test('a non-positive timeout is refused rather than meaning "never"', () => {
  assert.throws(() => boundedFetch(0, hung), /must be positive/);
  assert.throws(() => boundedFetch(Number.NaN, hung), /must be positive/);
});

test('a hung store write fails, and the grader keeps the checkpoint pending', { timeout: 30_000 }, async () => {
  const T0 = Date.UTC(2026, 8, 18, 14, 30, 0);
  const store = new SupabaseSignalStore(createClient('http://store.invalid', 'k', {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: boundedFetch(50, hung) },
  }));
  const sig = {
    signalKey: 'h'.repeat(64), underlying: 'SPY', side: 'BUY', synthetic: false,
    decisionAt: T0, spreadGuess: 'UNKNOWN',
    legs: [{ underlying: 'SPY', expiry: '2026-12-18', strike: 550, right: 'C', side: 'BUY', totalSize: 1, totalPremium: 1, prints: 1 }],
  } as unknown as SignalRecord;
  let now = T0;
  const g = new SignalGrader(
    store,
    (): Mark => ({ price: 101, source: 'twelvedata', rightsClass: 'UNVERIFIED', asOf: now }),
    {},
    () => now,
  );
  g.register(sig);
  await g.settle(); // the entry-mark write times out too, and is counted
  now = T0 + HORIZON_OFFSETS_MS.M15 + 1_000;
  await g.tick();
  const s = g.getStats();
  assert.equal(s.tickInFlightSince, undefined, 'the tick finished instead of hanging');
  assert.equal(s.writeFailures, 1, 'the timed-out write is a counted failure');
  assert.equal(s.writeRetrying, 1, 'and the checkpoint is still owed a row');
  assert.equal(s.entryMarkWriteFailures, 1);
});

test('the persistence client is built with the bounded fetch', () => {
  const src = readFileSync(join(__dirname, '..', 'src', 'persistence', 'index.ts'), 'utf8');
  const call = /new SupabaseSignalStore\(createClient\([\s\S]*?\}\)\)/.exec(src);
  assert.ok(call, 'the store is still built from createClient in index.ts');
  assert.match(call[0], /global:\s*\{\s*fetch:\s*boundedFetch\(/);
});
