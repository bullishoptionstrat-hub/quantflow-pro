/**
 * Finnhub as a second spot source — for display, and only for display.
 *
 * A connector of this name existed before and was deleted: it streamed
 * Finnhub's EQUITY trades and handed each price to `simulatePrints`, putting
 * manufactured OPTION prints on the tape of a deployment that had paid for a
 * real feed. This one publishes what Finnhub actually sends.
 *
 * The rights question is the interesting half. Finnhub's terms, read
 * 2026-09-03, say:
 *
 *   "You hereby agree to not redistribute or share access to data or derived
 *    results from the data obtained from Finnhub with anyone or any 3rd party
 *    without written approval from Finnhub."
 *
 * `/api/track-record` publishes derived results to anyone who can reach it, so
 * `FINNHUB_QUOTES` is PROHIBITED for PERSIST and the grader must not read it.
 * That refusal is the whole reason this file exists as a test rather than a
 * comment.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CONNECTOR = join(__dirname, '..', 'src', 'ingestion', 'connectors', 'finnhub.ts');

/** Load the connector with axios stubbed. */
function load(get: (url: string, cfg: any) => Promise<any>, key = 'fh-test-key') {
  const resolved = require.resolve('../src/ingestion/connectors/finnhub');
  delete require.cache[resolved];
  const axios = require('axios');
  const realGet = axios.default?.get ?? axios.get;
  if (axios.default) axios.default.get = get; else axios.get = get;

  const prev = process.env.FINNHUB_API_KEY;
  if (key) process.env.FINNHUB_API_KEY = key; else delete process.env.FINNHUB_API_KEY;

  const mod = require('../src/ingestion/connectors/finnhub');
  return {
    ...mod,
    restore() {
      if (axios.default) axios.default.get = realGet; else axios.get = realGet;
      if (prev === undefined) delete process.env.FINNHUB_API_KEY;
      else process.env.FINNHUB_API_KEY = prev;
      delete require.cache[resolved];
    },
  };
}

/** Finnhub `/quote`: current, change, percent, high, low, open, prev close, t. */
const quote = (c: number, over: Record<string, unknown> = {}) => ({
  data: { c, d: 1.5, dp: 0.25, h: c + 1, l: c - 1, o: c, pc: c - 1.5, t: 1_780_000_000, ...over },
});

test('a quote is published with the fields Finnhub actually sends', async () => {
  const fh = load(async () => quote(612.4));
  try {
    await fh.startFinnhub();
    const q = fh.getFinnhubSpotQuotes().get('SPY');
    assert.ok(q, 'SPY should be quoted');
    assert.equal(q.price, 612.4);
    assert.equal(q.changePct, 0.25);
    assert.equal(q.source, 'finnhub');
    // `/quote` carries no volume. Null says that; zero would claim none traded.
    assert.equal(q.volume, null);
  } finally { fh.restore(); }
});

test('the seconds timestamp goes through the shared normalizer', async () => {
  // `t` is unix seconds. Writing it straight through is what dated half the
  // tape's board to 1970 the last time a second write path was added to a spot
  // cache — see `deadSources.test.ts`.
  const fh = load(async () => quote(100, { t: 1_780_000_000 }));
  try {
    await fh.startFinnhub();
    assert.equal(fh.getFinnhubSpotQuotes().get('SPY').timestamp, 1_780_000_000_000);
  } finally { fh.restore(); }
});

test('a symbol Finnhub does not cover is not quoted at zero', async () => {
  // `/quote` answers 200 with every field zero for an unknown symbol. Caching
  // that would put $0.00 on the tape in live styling — the Stooq failure with
  // a different vendor.
  const fh = load(async () => quote(0, { d: 0, dp: 0 }));
  try {
    await fh.startFinnhub();
    assert.equal(fh.getFinnhubSpotQuotes().size, 0);
  } finally { fh.restore(); }
});

test('it reports its own health each cycle', async () => {
  const seen: Array<{ ok: boolean; reason?: string }> = [];

  const good = load(async () => quote(500));
  try {
    good.onFinnhubHealth((h: { ok: boolean }) => seen.push(h));
    await good.startFinnhub();
    assert.deepEqual(seen.at(-1), { ok: true });
  } finally { good.restore(); }

  const bad = load(async () => {
    throw Object.assign(new Error('Request failed'), {
      response: { status: 429, data: 'API limit reached' },
    });
  });
  try {
    bad.onFinnhubHealth((h: { ok: boolean }) => seen.push(h));
    await bad.startFinnhub();
    const last = seen.at(-1)!;
    assert.equal(last.ok, false);
    assert.match(last.reason ?? '', /429|API limit/i);
  } finally { bad.restore(); }
});

test('no key means no fetch, and startConnector reports why', async () => {
  let called = 0;
  const fh = load(async () => { called++; return quote(1); }, '');
  try {
    await fh.startFinnhub();
    assert.equal(called, 0, 'a keyless connector must not issue a request');
    assert.equal(fh.getFinnhubSpotQuotes().size, 0);
  } finally { fh.restore(); }
});

test('the token travels in a header, not the query string', () => {
  // `/api/health` publishes vendor error bodies, and `describeHttpError`
  // scrubs credential-shaped strings — but a URL echoed in an error body is a
  // credential in a public field. Keep it out of the URL in the first place.
  const code = readFileSync(CONNECTOR, 'utf8');
  assert.match(code, /'X-Finnhub-Token': API_KEY/);
  assert.ok(!/token=\$\{API_KEY\}/.test(code), 'the key must not be in the query string');
});

test('the connector does not reach the grader', () => {
  // The refusal that motivates the whole rights entry. If a fallback is ever
  // added to `getSpotPrice`, this fails.
  // Scoped to `getSpotPrice` itself, not the whole file: `SpotQuote.source` is
  // the shared union and legitimately names both boards. What must stay clean
  // is the lookup the grader calls.
  const twelve = readFileSync(
    join(__dirname, '..', 'src', 'ingestion', 'connectors', 'twelveData.ts'), 'utf8');
  const spotPrice = twelve.slice(twelve.indexOf('export function getSpotPrice'));
  const body = spotPrice.slice(0, spotPrice.indexOf('\n}') + 2);
  assert.match(body, /spotCache/, 'the mark comes from Twelve Data\'s own cache');
  assert.ok(!/finnhub/i.test(body),
    'the grader\'s mark source must not consult Finnhub — its terms forbid ' +
    'sharing derived results, and a track record is derived results');

  const index = readFileSync(join(__dirname, '..', 'src', 'ingestion', 'index.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
  const grader = index.slice(index.indexOf('grader = new SignalGrader'));
  assert.match(grader.slice(0, 300), /getSpotPrice\(underlying\)/);
  assert.ok(!/finnhub/i.test(grader.slice(0, 300)), 'the grader reads one source');
});

test('the display board merges both, with Twelve Data winning', () => {
  // Twelve Data wins where both have a symbol because it is what the grader
  // prices against — a reader comparing the tape to the track record should
  // see the same number.
  const index = readFileSync(join(__dirname, '..', 'src', 'ingestion', 'index.ts'), 'utf8');
  const fn = index.slice(index.indexOf('export function getSpotQuotes'));
  assert.match(fn.slice(0, 400), /new Map\(getFinnhubSpotQuotes\(\)\)/);
  assert.match(fn.slice(0, 400), /getTwelveDataSpotQuotes\(\)\) merged\.set/);
});
