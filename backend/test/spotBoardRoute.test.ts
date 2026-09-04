/**
 * The merged spot board existed, and the route that serves the tape read past
 * it.
 *
 * `getSpotQuotes()` in `ingestion/index.ts` merges Twelve Data's cache with
 * Finnhub's, Twelve Data winning where both cover a symbol. `routes/macro.ts`
 * imported `getSpotQuotes` **directly from the Twelve Data connector**, so on
 * a deployment with a Finnhub key and no Twelve Data key the tape served
 * `{"quotes": []}` while ten quotes sat in the other cache, and `/api/health`
 * reported `finnhub: connected` — correctly.
 *
 * The test that shipped with the merge asserted the shape of the merge
 * function by source scan. It never asserted that anyone *called* it, which is
 * the only thing that made the second spot source worth adding. This file
 * drives the route.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** A minimal Express response that records what a handler sent. */
function recorder() {
  const out: { status: number; body: any } = { status: 200, body: undefined };
  const res: any = {
    status(code: number) { out.status = code; return res; },
    json(body: any) { out.body = body; return res; },
  };
  return { res, out };
}

/** Invoke a route handler on a router by path. */
async function call(router: any, path: string) {
  const layer = router.stack.find((l: any) => l.route?.path === path);
  assert.ok(layer, `no handler registered for ${path}`);
  const { res, out } = recorder();
  await layer.route.stack[0].handle({ query: {} } as any, res, () => {});
  return out;
}

test('the tape serves a quote that only the second source has', async () => {
  // The regression, driven end to end: populate Finnhub's cache, leave Twelve
  // Data's empty (its connector has no key here), and ask the route.
  const finnhub = require('../src/ingestion/connectors/finnhub');
  const macroRouter = require('../src/routes/macro').default;

  finnhub.getFinnhubSpotQuotes().set('SPY', {
    symbol: 'SPY', price: 773.17, change: 8.01, changePct: 1.05,
    volume: null, timestamp: Date.now(), source: 'finnhub',
  });

  try {
    const out = await call(macroRouter, '/quotes');
    assert.equal(out.status, 200);
    const symbols = (out.body.quotes ?? []).map((q: any) => q.symbol);
    assert.ok(symbols.includes('SPY'),
      'the route must read the merged board, not one connector\'s cache');
    const spy = out.body.quotes.find((q: any) => q.symbol === 'SPY');
    assert.equal(spy.source, 'finnhub', 'and each quote carries which board it came from');
    assert.equal(spy.volume, null, 'Finnhub sends no volume; null says so, zero would not');
  } finally {
    finnhub.getFinnhubSpotQuotes().delete('SPY');
  }
});

test('Twelve Data wins where both boards have the symbol', async () => {
  // It is what `getSpotPrice` grades against, so a reader comparing the tape
  // to the track record must see the same number.
  const finnhub = require('../src/ingestion/connectors/finnhub');
  const twelve = require('../src/ingestion/connectors/twelveData');
  const macroRouter = require('../src/routes/macro').default;

  finnhub.getFinnhubSpotQuotes().set('QQQ', {
    symbol: 'QQQ', price: 1, change: 0, changePct: 0,
    volume: null, timestamp: Date.now(), source: 'finnhub',
  });
  twelve.getSpotQuotes().set('QQQ', {
    symbol: 'QQQ', price: 717.67, change: 2, changePct: 0.3,
    volume: 1_000, timestamp: Date.now(), source: 'twelvedata',
  });

  try {
    const out = await call(macroRouter, '/quotes');
    const qqq = out.body.quotes.find((q: any) => q.symbol === 'QQQ');
    assert.equal(qqq.source, 'twelvedata');
    assert.equal(qqq.price, 717.67);
  } finally {
    finnhub.getFinnhubSpotQuotes().delete('QQQ');
    twelve.getSpotQuotes().delete('QQQ');
  }
});

test('no route reaches around the merged board', () => {
  // The specific mistake: importing a connector's own getter in a route that
  // is meant to serve every source. `ingestion/index.ts` is the seam.
  const macro = readFileSync(join(__dirname, '..', 'src', 'routes', 'macro.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
  assert.ok(!/getSpotQuotes.*from '\.\.\/ingestion\/connectors\//.test(macro),
    'a route must not import the spot getter from a single connector');
  assert.match(macro, /getSpotQuotes \} from '\.\.\/ingestion\/index'/);
});
