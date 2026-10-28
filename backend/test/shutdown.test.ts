import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { trackWrite, drainWrites, pendingWrites, makeShutdown } from '../src/lifecycle';

function deferred<T = void>() {
  let resolve!: (v: T) => void; let reject!: (e: Error) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}

test('drain waits for an in-flight write, including one that fails', async () => {
  const ok = deferred(); const bad = deferred();
  trackWrite(ok.promise); trackWrite(bad.promise).catch(() => {});
  const drained = drainWrites(1_000);
  ok.resolve(); bad.reject(new Error('store refused'));
  assert.equal(await drained, true);
  assert.equal(pendingWrites(), 0);
});

test('drain gives up at the deadline instead of hanging on a store that never answers', async () => {
  const stuck = deferred();
  trackWrite(stuck.promise);
  assert.equal(await drainWrites(20), false);
  stuck.resolve(); await stuck.promise;
});

test('a write started during the drain is waited for too', async () => {
  const a = deferred(); const b = deferred();
  trackWrite(a.promise);
  const drained = drainWrites(1_000);
  a.resolve(); await a.promise;
  trackWrite(b.promise);
  setTimeout(() => b.resolve(), 5);
  assert.equal(await drained, true);
});

test('shutdown closes, drains, exits once; a second signal exits immediately', async () => {
  const calls: string[] = [];
  const gate = deferred<boolean>();
  const sd = makeShutdown({
    closeServer: async () => { calls.push('close'); },
    drain: async () => { calls.push('drain'); return gate.promise; },
    exit: (c) => calls.push(`exit:${c}`),
    log: () => {},
  });
  const first = sd('SIGTERM');
  await sd('SIGTERM');
  assert.ok(calls.includes('exit:1') && !calls.includes('exit:0'), 'second signal must not wait for the drain');
  gate.resolve(true); await first;
  assert.deepEqual(calls.filter((c) => c.startsWith('exit')), ['exit:1', 'exit:0']);
  assert.equal(calls.filter((c) => c === 'drain').length, 1, 'drained once');
});

test('a failing close still drains', async () => {
  const calls: string[] = [];
  await makeShutdown({
    closeServer: async () => { throw new Error('boom'); },
    drain: async () => { calls.push('drain'); return true; },
    exit: (c) => calls.push(`exit:${c}`), log: () => {},
  })('SIGINT');
  assert.deepEqual(calls, ['drain', 'exit:0']);
});

test('the server installs the handler and the recorder and grader writes are tracked', () => {
  const server = readFileSync(join(__dirname, '../src/server.ts'), 'utf8');
  assert.match(server, /process\.on\('SIGTERM'/);
  const idx = readFileSync(join(__dirname, '../src/ingestion/index.ts'), 'utf8');
  assert.match(idx, /trackWrite\(recorder\.record\(/);
  assert.match(idx, /trackWrite\(grader\.tick\(\)\)/);
});

import { InMemorySignalStore } from '../src/persistence/memoryStore';
import { SignalGrader } from '../src/persistence/grader';
import { resetLifecycleForTests, isShuttingDown } from '../src/lifecycle';
import type { SignalRecord } from '../src/persistence/types';

test('the entry-mark write started at registration is one shutdown waits for', async () => {
  resetLifecycleForTests();
  const T0 = Date.UTC(2026, 9, 28, 15, 0, 0);
  const store = new InMemorySignalStore();
  const gate = deferred();
  const real = store.writeEntryMark.bind(store);
  (store as any).writeEntryMark = async (m: any) => { await gate.promise; return real(m); };
  const rec = {
    signalKey: 'k'.padEnd(64, '0'), engineId: 'e', underlying: 'SPY', kind: 'BLOCK', side: 'BUY',
    score: 80, totalPremium: 1e6, totalSize: 1, firstEventAt: T0, lastEventAt: T0, receivedAt: T0,
    decisionAt: T0, decisionBasis: 'OBSERVED', source: 'tradier', datasetId: 'TRADIER_STREAM',
    rightsClass: 'PERMITTED', synthetic: false, printIds: ['p'],
    legs: [{ underlying: 'SPY', expiry: '2026-12-18', strike: 550, right: 'C', side: 'BUY', totalSize: 1, totalPremium: 1e6, prints: 1 }],
  } as unknown as SignalRecord;
  await store.writeSignal(rec);
  const g = new SignalGrader(store, () => ({ price: 100, source: 'twelvedata', rightsClass: 'UNVERIFIED', asOf: T0 }), {}, () => T0);
  g.register(rec);
  assert.equal(pendingWrites(), 1, 'the entry-mark write is not tracked');
  assert.equal(await drainWrites(20), false, 'drain finished while the mark was still being written');
  gate.resolve();
  assert.equal(await drainWrites(1_000), true);
  assert.ok(await store.getEntryMark(rec.signalKey), 'the mark was written');
});

test('once shutdown starts, recording and grading stop starting new work', async () => {
  resetLifecycleForTests();
  assert.equal(isShuttingDown(), false);
  await makeShutdown({ closeServer: async () => {}, drain: async () => true, exit: () => {}, log: () => {} })('SIGTERM');
  assert.equal(isShuttingDown(), true);
  const idx = readFileSync(join(__dirname, '../src/ingestion/index.ts'), 'utf8');
  assert.match(idx, /if \(isShuttingDown\(\)\) return;\s*\n\s*\/\/ Fire-and-forget/);
  assert.match(idx, /if \(grader && !isShuttingDown\(\)\) void trackWrite\(grader\.tick\(\)\)/);
  resetLifecycleForTests();
});
