/**
 * Once shutdown begins, no new vendor work starts: a poller cycle does not
 * run and a closed WebSocket does not reconnect. Work started during the
 * drain extends the drain it is racing, and a reconnect opens a vendor
 * connection the process is about to cut.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { singleFlight } from '../src/ingestion/singleFlight';
import { makeShutdown, resetLifecycleForTests } from '../src/lifecycle';

test('a poller cycle does not start after shutdown begins', async () => {
  resetLifecycleForTests();
  let runs = 0;
  const poll = singleFlight('shutdown-test', async () => { runs++; });
  await poll();
  assert.equal(runs, 1);
  const shutdown = makeShutdown({ closeServer: async () => {}, drain: async () => true, exit: () => {}, log: () => {} });
  await shutdown('SIGTERM');
  await poll();
  assert.equal(runs, 1, 'a cycle ran during shutdown');
  resetLifecycleForTests();
});

for (const [file, re] of [
  ['src/ingestion/index.ts', /setTimeout\(\(\) => \{ void connect\(\); \}/g],
  ['src/ingestion/connectors/twelveData.ts', /setTimeout\(startWebSocket/g],
  ['src/ingestion/connectors/tastytrade.ts', /setTimeout\(startWebSocket/g],
] as const) {
  test(`${file}: every reconnect checks isShuttingDown`, () => {
    const src = readFileSync(join(__dirname, '..', file), 'utf8');
    const sites = [...src.matchAll(re)];
    assert.ok(sites.length > 0, 'no reconnect site found; the pattern is stale');
    for (const m of sites) {
      const before = src.slice(Math.max(0, m.index! - 200), m.index!);
      assert.match(before, /isShuttingDown\(\)/, `reconnect at offset ${m.index} is unguarded`);
    }
  });
}

test('a Tradier universe build that finishes after shutdown does not subscribe', () => {
  const src = readFileSync(join(__dirname, '..', 'src/ingestion/index.ts'), 'utf8');
  const send = src.indexOf('ws.send(subscriptionFrame(');
  assert.ok(send > 0, 'subscription send not found; the pattern is stale');
  assert.match(src.slice(send - 200, send), /isShuttingDown\(\)/, 'subscribe after a late build is unguarded');
});
