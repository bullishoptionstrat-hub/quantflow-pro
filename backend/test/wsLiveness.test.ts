/**
 * A WebSocket that goes silent without closing is terminated, so the
 * reconnect path that runs on `close` actually runs.
 *
 * The Tradier stream reconnected on `close` and nothing else. A connection
 * whose network path dies without a FIN raises no `close`, so it stayed open
 * forever with the source reading `connected` while nothing arrived.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { Liveness, watchLiveness } from '../src/ingestion/wsLiveness';

test('Liveness: pings while heard, declares death once after the bound', () => {
  const live = new Liveness({ pingEveryMs: 30_000, deadAfterMs: 75_000 }, 0);
  assert.equal(live.tick(30_000), 'ping');
  live.heard(40_000);
  assert.equal(live.tick(110_000), 'ping', '70 s since last heard is inside the bound');
  assert.equal(live.tick(120_000), 'dead', '80 s is past it');
  assert.equal(live.tick(150_000), 'done', 'and death is reported once');
});

test('a bound shorter than the ping interval is refused', () => {
  assert.throws(() => new Liveness({ pingEveryMs: 30_000, deadAfterMs: 30_000 }, 0), /must exceed/);
});

class SilentSocket extends EventEmitter {
  pings = 0;
  terminated = false;
  ping() { this.pings++; }
  terminate() { this.terminated = true; this.emit('close'); }
}

test('a socket that never answers is terminated, and the reason is reported first', async () => {
  const ws = new SilentSocket();
  let silentFor = -1;
  watchLiveness(ws, (ms) => { silentFor = ms; }, { pingEveryMs: 20, deadAfterMs: 50 });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(ws.terminated, true, 'terminate() raised close, which runs the reconnect');
  assert.ok(ws.pings >= 1, 'it was pinged before being declared dead');
  assert.ok(silentFor > 50, `the silence is reported (${silentFor} ms)`);
});

test('a socket that keeps sending messages is not terminated', async () => {
  const ws = new SilentSocket();
  watchLiveness(ws, () => {}, { pingEveryMs: 20, deadAfterMs: 50 });
  const feed = setInterval(() => ws.emit('message', '{}'), 10);
  await new Promise((r) => setTimeout(r, 200));
  clearInterval(feed);
  ws.emit('close');
  assert.equal(ws.terminated, false);
});

test('a real server that answers pings keeps a quiet connection alive', { timeout: 5_000 }, async () => {
  // `ws` answers pings itself, as RFC 6455 requires of every server. The
  // connection carries no messages at all, which is a closed market.
  const wss = new WebSocketServer({ port: 0 });
  await new Promise((r) => wss.once('listening', r));
  const port = (wss.address() as { port: number }).port;
  const client = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise((r) => client.once('open', r));
  let died = false;
  try {
    watchLiveness(client, () => { died = true; }, { pingEveryMs: 20, deadAfterMs: 60 });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(died, false, 'pongs alone count as life');
  } finally {
    // Both ends torn down whatever happened, so a failure fails rather than
    // hanging the process on an open server.
    client.terminate();
    for (const c of wss.clients) c.terminate();
    await new Promise((r) => wss.close(r));
  }
});

test('the Tradier stream is watched, and a close records why', () => {
  const src = readFileSync(join(__dirname, '..', 'src', 'ingestion', 'index.ts'), 'utf8');
  const start = src.indexOf('const ws = new WebSocket(url,');
  assert.ok(start > 0);
  const body = src.slice(start, start + 6_000);
  assert.match(body, /watchLiveness\(tradierWs,/, 'the socket is handed to the liveness watcher');
  assert.match(body, /sourceErrors\['tradier'\] \?\?= /, 'and a bare close leaves a reason');
});
