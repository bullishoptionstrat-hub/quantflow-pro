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
