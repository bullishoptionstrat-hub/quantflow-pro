/**
 * `/api/chain` answered every failure with a fabricated chain.
 *
 * `buildMockChain` produced twenty strikes of `Math.random()` — bids, asks,
 * volume, open interest, gamma, theta, vega and **implied volatility** —
 * around a hardcoded 2024 spot map (SPY 580, NVDA 140, TSLA 250, SPX 5800),
 * and it was returned in three cases: no `TRADIER_TOKEN`, a Tradier error of
 * any kind, and — for `/expirations` — with no marker at all, because that
 * response carries no `source` field. A revoked token, a rate limit or a
 * timeout produced a complete chain of invented prices behind `requireAuth`,
 * the tier this repo reserves for entitled vendor data.
 *
 * Same finding as `deadSources.test.ts`, on a route rather than a connector:
 * a source that is down must never present itself as data.
 *
 * These tests drive the router's handlers directly with a stubbed axios, and
 * scan the module for the fabricators being gone rather than unreachable.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CHAIN = join(__dirname, '..', 'src', 'routes', 'chain.ts');

/** A minimal Express response that records what a handler sent. */
function recorder() {
  const out: { status: number; body: any } = { status: 200, body: undefined };
  const res: any = {
    status(code: number) { out.status = code; return res; },
    json(body: any) { out.body = body; return res; },
  };
  return { res, out };
}

/** Load the router with axios stubbed and a chosen token. */
async function loadChain(opts: { token?: string; get?: () => Promise<any> }) {
  const path = require.resolve('../src/routes/chain');
  const axiosPath = require.resolve('axios');
  delete require.cache[path];
  delete require.cache[axiosPath];

  const axios = require('axios');
  const realGet = axios.default?.get ?? axios.get;
  const stub = opts.get ?? (async () => ({ data: {} }));
  if (axios.default) axios.default.get = stub; else axios.get = stub;

  const prev = process.env.TRADIER_TOKEN;
  if (opts.token === undefined) delete process.env.TRADIER_TOKEN;
  else process.env.TRADIER_TOKEN = opts.token;

  const router = require('../src/routes/chain').default;

  return {
    router,
    restore() {
      if (axios.default) axios.default.get = realGet; else axios.get = realGet;
      if (prev === undefined) delete process.env.TRADIER_TOKEN;
      else process.env.TRADIER_TOKEN = prev;
      delete require.cache[path];
    },
  };
}

/** Find a route handler on an Express router by path and invoke it. */
async function call(router: any, path: string, query: Record<string, string> = {}) {
  const layer = router.stack.find((l: any) => l.route?.path === path);
  assert.ok(layer, `no handler registered for ${path}`);
  const { res, out } = recorder();
  await layer.route.stack[0].handle({ query } as any, res, () => {});
  return out;
}

test('the fabricators are gone, not merely unreachable', () => {
  const src = readFileSync(CHAIN, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
  assert.ok(!/Math\.random/.test(src), 'a chain of random greeks survives');
  assert.ok(!/buildMockChain/.test(src), 'the mock chain builder survives');
  assert.ok(!/generateExpirations/.test(src), 'the invented expirations survive');
  // The 2024 spot map. NVDA at 140 here and 942 in the frontend's deleted copy
  // — the same ticker either side of a ten-for-one split.
  for (const level of ['580', '480', '140', '250', '410', '5800']) {
    assert.ok(!new RegExp(`:\\s*${level}\\b`).test(src), `the spot map still holds ${level}`);
  }
});

test('no credential is a configuration answer that names the variable', async () => {
  const { router, restore } = await loadChain({ token: undefined });
  try {
    for (const path of ['/', '/expirations']) {
      const out = await call(router, path, { symbol: 'SPY' });
      assert.equal(out.status, 503, `${path} should refuse rather than invent`);
      assert.equal(out.body.error, 'chain_unavailable');
      assert.equal(out.body.credential, 'TRADIER_TOKEN',
        'a connector that is off names what turns it on');
      assert.ok(!('calls' in out.body), `${path} must not return a chain`);
    }
  } finally { restore(); }
});

test('a vendor failure is an error carrying the vendor\'s own words', async () => {
  const err: any = new Error('Request failed');
  err.response = { status: 401, data: { fault: 'Invalid access token' } };
  const { router, restore } = await loadChain({
    token: 'tok', get: async () => { throw err; },
  });
  try {
    const out = await call(router, '/', { symbol: 'SPY' });
    assert.equal(out.status, 502, 'a 401 from Tradier used to return a full chain');
    assert.match(out.body.reason, /401/);
    assert.match(out.body.reason, /Invalid access token/);
    assert.ok(!('calls' in out.body));

    const exp = await call(router, '/expirations', { symbol: 'SPY' });
    assert.equal(exp.status, 502);
    // This path was the worse one: its fallback carried no `source`, so it was
    // indistinguishable from Tradier's own answer.
    assert.ok(!Array.isArray(exp.body.expirations));
  } finally { restore(); }
});

test('a real answer is passed through and labelled', async () => {
  const { router, restore } = await loadChain({
    token: 'tok',
    get: async () => ({ data: { options: { option: [
      { option_type: 'call', strike: 610 },
      { option_type: 'put', strike: 610 },
      { option_type: 'call', strike: 615 },
    ] } } }),
  });
  try {
    const out = await call(router, '/', { symbol: 'SPY' });
    assert.equal(out.status, 200);
    assert.equal(out.body.source, 'tradier');
    assert.deepEqual(out.body.strikes, [610, 615]);
    assert.equal(out.body.calls.length, 2);
    assert.equal(out.body.puts.length, 1);
  } finally { restore(); }
});

test('the expirations response says where it came from', async () => {
  // It never did, which is why its fallback was invisible.
  const { router, restore } = await loadChain({
    token: 'tok',
    get: async () => ({ data: { expirations: { date: ['2026-10-16', '2026-10-23'] } } }),
  });
  try {
    const out = await call(router, '/expirations', { symbol: 'SPY' });
    assert.equal(out.body.source, 'tradier');
    assert.deepEqual(out.body.expirations, ['2026-10-16', '2026-10-23']);
  } finally { restore(); }
});
