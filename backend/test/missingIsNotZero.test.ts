/**
 * A field the vendor did not send is not a zero.
 *
 * `deadSources.test.ts` closed this at *response* granularity: Stooq's
 * browser-challenge page stopped becoming twelve quotes priced at zero, and
 * Cboe's 403 stopped becoming a put/call ratio of 0.00 in green. It survived
 * at *field* granularity in two places, inside responses that had succeeded:
 *
 *   - `coinGecko.ts` wrote `?? 0` into every optional field, so a coin
 *     CoinGecko has no market data for was cached at **$0.00** with a 0.00%
 *     change and rendered through the same markup as a live row.
 *   - `cboe.ts` handled the outer failure but parsed each field with
 *     `parseFloat(today.equity_put_call_ratio ?? 0)` — and `parseFloat(0)` is
 *     `0`, not `NaN`, so a present row missing a ratio published one of 0.00
 *     inside an `ok: true` block.
 *
 * CoinGecko also reported no health at all. `startConnector` records what
 * `start()` returned once and never looks again, so a rate-limited CoinGecko
 * kept saying `connected` while serving an ageing cache — the finding that
 * gave Stooq `onStooqHealth`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CONNECTORS = join(__dirname, '..', 'src', 'ingestion', 'connectors');
const code = (f: string) =>
  readFileSync(join(CONNECTORS, f), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');

test('no connector writes a zero where a vendor sent nothing', () => {
  for (const f of ['coinGecko.ts', 'cboe.ts']) {
    const src = code(f);
    assert.ok(!/\?\?\s*0\b/.test(src.replace(/\?\?\s*0\s*,\s*$/gm, '')),
      `${f} still substitutes 0 for an absent field`);
  }
});

test('a coin with no price is not a quote', async () => {
  const gecko = await loadGecko([
    { id: 'bitcoin', symbol: 'btc', name: 'Bitcoin', current_price: 64_000, market_cap: 1e12 },
    { id: 'shiba-inu', symbol: 'shib', name: 'Shiba Inu' }, // no market data at all
  ]);
  try {
    await gecko.startCoinGecko();
    const quotes = gecko.getCryptoQuotes();
    assert.equal(quotes.size, 1, 'the unpriced coin must not be cached');
    assert.equal(quotes.get('BTC')?.price, 64_000);
    assert.equal(quotes.has('SHIB'), false);
  } finally { gecko.restore(); }
});

test('a priced coin missing a derived field carries null, not zero', async () => {
  const gecko = await loadGecko([
    { id: 'bitcoin', symbol: 'btc', name: 'Bitcoin', current_price: 64_000 },
  ]);
  try {
    await gecko.startCoinGecko();
    const q = gecko.getCryptoQuotes().get('BTC');
    assert.ok(q);
    assert.equal(q.price, 64_000);
    // Every one of these rendered as a number on the macro page.
    assert.equal(q.changePct24h, null);
    assert.equal(q.marketCap, null);
    assert.equal(q.volume24h, null);
    assert.equal(q.change24h, null);
  } finally { gecko.restore(); }
});

test('a real zero is kept, because a real zero is data', async () => {
  const gecko = await loadGecko([
    { id: 'bitcoin', symbol: 'btc', name: 'Bitcoin', current_price: 64_000, price_change_percentage_24h: 0 },
  ]);
  try {
    await gecko.startCoinGecko();
    assert.equal(gecko.getCryptoQuotes().get('BTC')?.changePct24h, 0);
  } finally { gecko.restore(); }
});

test('coingecko reports its own health every cycle', async () => {
  const seen: Array<{ ok: boolean; reason?: string }> = [];

  const good = await loadGecko([{ id: 'bitcoin', symbol: 'btc', name: 'Bitcoin', current_price: 1 }]);
  try {
    good.onCoinGeckoHealth((h: { ok: boolean; reason?: string }) => seen.push(h));
    await good.startCoinGecko();
    assert.deepEqual(seen.at(-1), { ok: true });
  } finally { good.restore(); }

  const limited = await loadGecko(null, Object.assign(new Error('Request failed'), {
    response: { status: 429, data: 'rate limited' },
  }));
  try {
    limited.onCoinGeckoHealth((h: { ok: boolean; reason?: string }) => seen.push(h));
    await limited.startCoinGecko();
    const last = seen.at(-1)!;
    assert.equal(last.ok, false);
    assert.match(last.reason ?? '', /429|rate limited/i);
  } finally { limited.restore(); }
});

test('a cboe row missing a ratio is a failure, not a 0.00', async () => {
  const cboe = await loadCboe({ data: [{ equity_put_call_ratio: '0.91' }] }); // index/total absent
  try {
    await cboe.startCBOE();
    const d = cboe.getCBOEData();
    // The block is refused rather than published with invented ratios.
    assert.ok(d === null || d.putCallUnavailable, 'a partial row must not publish ratios');
    if (d?.putCallUnavailable) {
      assert.match(d.putCallUnavailable, /putCallRatioIndex|putCallRatioTotal/);
    }
  } finally { cboe.restore(); }
});

// ─── harness ────────────────────────────────────────────────────────────────

async function loadGecko(marketsPayload: unknown, throws?: Error) {
  return loadWithAxios('../src/ingestion/connectors/coinGecko', async (url: string) => {
    if (throws) throw throws;
    if (url.includes('/coins/markets')) return { data: marketsPayload };
    return { data: { data: {} } };
  });
}

async function loadCboe(pcrPayload: unknown) {
  return loadWithAxios('../src/ingestion/connectors/cboe', async (url: string) => {
    if (url.includes('options_volume')) return { data: pcrPayload };
    return { data: {} };
  });
}

function loadWithAxios(modulePath: string, get: (url: string) => Promise<any>) {
  const resolved = require.resolve(modulePath);
  const axiosPath = require.resolve('axios');
  delete require.cache[resolved];
  const axios = require('axios');
  const realGet = axios.default?.get ?? axios.get;
  if (axios.default) axios.default.get = get; else axios.get = get;
  const mod = require(modulePath);
  return {
    ...mod,
    restore() {
      if (axios.default) axios.default.get = realGet; else axios.get = realGet;
      delete require.cache[resolved];
      delete require.cache[axiosPath];
    },
  };
}

test('every connector poller releases the event loop', () => {
  // Three of eighteen `setInterval`s carried `.unref()` — presumably added
  // wherever someone hit the hang. The other fifteen kept the Node event loop
  // alive, so any process that imports a connector and expects to exit — a
  // CLI, a test, a one-shot script — waited forever on a timer that would
  // never matter to it. This test found it by hanging.
  const { readdirSync } = require('node:fs') as typeof import('node:fs');
  const offenders: string[] = [];

  for (const f of readdirSync(CONNECTORS).filter((n) => n.endsWith('.ts'))) {
    const src = readFileSync(join(CONNECTORS, f), 'utf8');
    // Each `setInterval(` must have `.unref()` before the statement ends.
    let i = src.indexOf('setInterval(');
    while (i !== -1) {
      // Walk to the matching close paren rather than the next `;` — a
      // callback body is full of semicolons, and stopping at the first one
      // hides `.unref()` on every multi-line poller. (It did, on two.)
      let depth = 0;
      let j = src.indexOf('(', i);
      for (; j < src.length; j++) {
        if (src[j] === '(') depth++;
        else if (src[j] === ')' && --depth === 0) break;
      }
      const tail = src.slice(j, j + 20);
      if (!tail.startsWith(').unref()')) {
        offenders.push(`${f}:${src.slice(0, i).split('\n').length}`);
      }
      i = src.indexOf('setInterval(', i + 1);
    }
  }

  assert.deepEqual(offenders, [], `pollers holding the event loop open: ${offenders.join(', ')}`);
});
