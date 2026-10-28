/**
 * A universe build that finishes after its socket closed must not touch the
 * live connection. The build is several REST calls; a reconnect can open a new
 * socket meanwhile, and the stale result would replace the new universe and
 * send the dead session's id on the new socket.
 *
 * `connect()` is not separable from the vendor today, so this is a source
 * guard on the three lines that make the rule hold.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = readFileSync(join(__dirname, '../src/ingestion/index.ts'), 'utf8');
const body = src.slice(src.indexOf('const subscribe = async () => {'), src.indexOf("tradierWs.on('open'"));

test('each connection captures its own socket', () => {
  assert.match(src, /const ws = new WebSocket\(url,/);
  assert.match(src, /tradierWs = ws;/);
});

test('a stale build returns before writing the universe', () => {
  const guard = body.indexOf('if (tradierWs !== ws) return;');
  const write = body.indexOf('tradierUniverse = built.contracts;');
  assert.ok(guard > 0 && write > guard, 'universe written before the staleness check');
});

test('the subscription frame goes to the captured socket, never the global', () => {
  assert.match(body, /ws\.send\(subscriptionFrame/);
  assert.doesNotMatch(body, /tradierWs\?*\.send/);
});
