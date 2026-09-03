/**
 * The rate limiter counted the caller's own header, so it never fired.
 *
 * `getKey` read `req.headers['x-forwarded-for'].split(',')[0]` — the
 * **leftmost** entry. `X-Forwarded-For` grows left to right, each proxy
 * appending the address it received the request from, so the leftmost entry is
 * whatever the *caller* sent and everything to the right was written by a
 * proxy. Naming a new value per request minted a new bucket per request:
 *
 *     honest, same client x5 : 200 200 200 429 429
 *     forged XFF, same client: 200 200 200 200 200
 *
 * That defeated the global 200/min limiter and — more expensively — the 40/min
 * `demo` bucket, which is what bounds how much an unauthenticated caller can
 * cost this deployment.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response } from 'express';

import { rateLimiter } from '../src/middleware/rateLimiter';

/** Drive one request through a limiter and return the status it produced. */
function hit(
  limit: ReturnType<typeof rateLimiter>,
  opts: { xff?: string | string[]; socket?: string } = {},
): number {
  let status = 200;
  const req = {
    headers: opts.xff === undefined ? {} : { 'x-forwarded-for': opts.xff },
    socket: { remoteAddress: opts.socket ?? '10.0.0.1' },
  } as unknown as Request;
  const res = {
    setHeader() {},
    status(code: number) { status = code; return res; },
    json() { return res; },
  } as unknown as Response;
  limit(req, res, () => {});
  return status;
}

const runs = (n: number, f: (i: number) => number) =>
  Array.from({ length: n }, (_, i) => f(i));

test('an honest caller behind one proxy is throttled', () => {
  const limit = rateLimiter(3, 60_000, `honest-${Math.random()}`);
  assert.deepEqual(runs(5, () => hit(limit, { xff: '203.0.113.9' })), [200, 200, 200, 429, 429]);
});

test('forging the left of the chain does not mint a new bucket', () => {
  // The bypass. Each request names a different leftmost address while the
  // proxy appends the same real client.
  const limit = rateLimiter(3, 60_000, `forged-${Math.random()}`);
  const got = runs(5, (i) => hit(limit, { xff: `1.2.3.${i}, 203.0.113.9` }));
  assert.deepEqual(got, [200, 200, 200, 429, 429],
    'a caller must not escape its bucket by writing its own X-Forwarded-For');
});

test('two genuinely different clients keep separate buckets', () => {
  // The limiter still has to work: fixing the bypass by keying everything to
  // the proxy would throttle every caller together.
  const limit = rateLimiter(2, 60_000, `distinct-${Math.random()}`);
  assert.equal(hit(limit, { xff: '203.0.113.9' }), 200);
  assert.equal(hit(limit, { xff: '203.0.113.9' }), 200);
  assert.equal(hit(limit, { xff: '203.0.113.9' }), 429);
  assert.equal(hit(limit, { xff: '198.51.100.4' }), 200, 'a second client starts fresh');
});

test('a repeated header array is joined, not stringified', () => {
  // Node hands back an array when the header appears more than once. The old
  // code cast it to `string` and `.split(',')` on an array is a TypeError.
  const limit = rateLimiter(2, 60_000, `array-${Math.random()}`);
  assert.equal(hit(limit, { xff: ['1.2.3.4', '203.0.113.9'] }), 200);
  assert.equal(hit(limit, { xff: '1.2.3.4, 203.0.113.9' }), 200);
  assert.equal(hit(limit, { xff: '203.0.113.9' }), 429, 'all three are the same client');
});

test('no header at all falls back to the socket, and fails closed', () => {
  // Behind a proxy the socket address is the proxy, so every caller shares one
  // bucket. Everyone throttled is the right way round for a misconfiguration;
  // nobody throttled is what the old code did.
  const limit = rateLimiter(2, 60_000, `nohdr-${Math.random()}`);
  assert.equal(hit(limit, { socket: '172.16.0.5' }), 200);
  assert.equal(hit(limit, { socket: '172.16.0.5' }), 200);
  assert.equal(hit(limit, { socket: '172.16.0.5' }), 429);
});

test('a chain shorter than the trusted hop count is not trusted', () => {
  // One hop configured, no proxy entry present: the single value is the
  // caller's own, and must not be believed.
  const limit = rateLimiter(2, 60_000, `short-${Math.random()}`);
  assert.equal(hit(limit, { xff: '', socket: '172.16.0.9' }), 200);
  assert.equal(hit(limit, { xff: '   ', socket: '172.16.0.9' }), 200);
  assert.equal(hit(limit, { socket: '172.16.0.9' }), 429, 'all three keyed to the socket');
});

test('the cleanup timer releases the event loop', () => {
  // It fires at module load, so importing the limiter — which `server.ts`
  // does, transitively from anything that imports it — held the loop open and
  // a CLI or a test that touched it never exited. Same defect the connectors'
  // pollers had.
  const { readFileSync } = require('node:fs') as typeof import('node:fs');
  const { join } = require('node:path') as typeof import('node:path');
  const src = readFileSync(join(__dirname, '..', 'src', 'middleware', 'rateLimiter.ts'), 'utf8');
  assert.match(src, /\}, 300_000\)\.unref\(\)/, 'the cleanup interval must not hold the loop open');
});
