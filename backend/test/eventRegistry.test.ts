/**
 * Event Registry (newsapi.ai) — a different vendor from newsapi.org.
 *
 * The key supplied under the label "NEWSAPI" was rejected by newsapi.org with
 * `apiKeyInvalid` and accepted here, which is how this connector came to
 * exist. Different key, endpoint, request method and response shape.
 *
 * Two things about this vendor need holding down. It answers **200 with an
 * `error` field** for a rejected key or a malformed query, so a status check
 * alone reads a refusal as success. And it is the only news source that scores
 * its own articles — the other two carry no score, so the wire has to record
 * which produced the label.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CONNECTOR = join(__dirname, '..', 'src', 'ingestion', 'connectors', 'eventRegistry.ts');

/** One article as the live API returns it, fields trimmed to those read. */
const article = (over: Record<string, unknown> = {}) => ({
  uri: '9455804617',
  url: 'https://example.test/wall-street',
  title: 'Wall Street ends sharply higher',
  body: 'NVDA and AAPL led the tape higher.',
  source: { uri: 'example.test', title: 'Example Times' },
  dateTimePub: '2026-09-03T21:39:18Z',
  dateTime: '2026-09-03T21:40:21Z',
  sentiment: 0.42,
  isDuplicate: false,
  ...over,
});

function load(post: (url: string, body: any, cfg: any) => Promise<any>, key = 'er-test-key') {
  const resolved = require.resolve('../src/ingestion/connectors/eventRegistry');
  delete require.cache[resolved];
  const axios = require('axios');
  const realPost = axios.default?.post ?? axios.post;
  if (axios.default) axios.default.post = post; else axios.post = post;

  const prev = process.env.EVENT_REGISTRY_API_KEY;
  if (key) process.env.EVENT_REGISTRY_API_KEY = key;
  else delete process.env.EVENT_REGISTRY_API_KEY;

  const mod = require('../src/ingestion/connectors/eventRegistry');
  return {
    ...mod,
    restore() {
      if (axios.default) axios.default.post = realPost; else axios.post = realPost;
      if (prev === undefined) delete process.env.EVENT_REGISTRY_API_KEY;
      else process.env.EVENT_REGISTRY_API_KEY = prev;
      delete require.cache[resolved];
    },
  };
}

const respond = (results: unknown[]) => async () => ({ data: { articles: { results } } });

test('an article is published with the outlet, its own publish time, and tagged symbols', async () => {
  const er = load(respond([article()]));
  try {
    await er.startEventRegistry();
    const [h] = er.getEventRegistryHeadlines();
    assert.ok(h);
    assert.equal(h.source, 'Example Times', 'the outlet, not the vendor');
    assert.equal(h.publishedAt, '2026-09-03T21:39:18Z', 'dateTimePub, not the discovery time');
    assert.deepEqual(h.symbols.sort(), ['AAPL', 'NVDA']);
    assert.equal(h.provider, 'eventregistry');
  } finally { er.restore(); }
});

test('a 200 carrying an error field is a failure, not an empty result', async () => {
  // The trap. This vendor answers 200 with `{ error }` for a rejected key or a
  // malformed query; checking the status alone reads a refusal as success and
  // reports the source `connected` with nothing in it.
  const seen: any[] = [];
  const er = load(async () => ({ data: { error: 'Invalid API key' } }));
  try {
    er.onEventRegistryHealth((h: any) => seen.push(h));
    await er.startEventRegistry();
    assert.equal(seen.at(-1)?.ok, false);
    assert.match(seen.at(-1)?.reason ?? '', /Invalid API key/);
    assert.equal(er.getEventRegistryHeadlines().length, 0);
  } finally { er.restore(); }
});

test('the vendor score becomes a label, and the raw score is kept beside it', async () => {
  const er = load(respond([
    article({ uri: 'a', sentiment: 0.42 }),
    article({ uri: 'b', url: 'https://example.test/b', sentiment: -0.42 }),
    article({ uri: 'c', url: 'https://example.test/c', sentiment: 0.01 }),
  ]));
  try {
    await er.startEventRegistry();
    const [a, b, c] = er.getEventRegistryHeadlines();
    assert.equal(a.sentiment, 'bullish');
    assert.equal(b.sentiment, 'bearish');
    assert.equal(c.sentiment, 'neutral');
    // The thresholds are ours; keeping the raw score lets a reader check them.
    assert.equal(a.sentimentScore, 0.42);
  } finally { er.restore(); }
});

test('a missing score is neutral and says so, rather than claiming balance', async () => {
  const er = load(respond([article({ sentiment: null })]));
  try {
    await er.startEventRegistry();
    const [h] = er.getEventRegistryHeadlines();
    assert.equal(h.sentiment, 'neutral');
    assert.equal(h.sentimentScore, null, 'unclassified is not the same as balanced');
  } finally { er.restore(); }
});

test('a reprint is dropped', async () => {
  // `isDuplicate` marks a story already in the set. Keeping both would
  // double-count a name in any tally built from these.
  const er = load(respond([article(), article({ uri: 'dup', isDuplicate: true })]));
  try {
    await er.startEventRegistry();
    assert.equal(er.getEventRegistryHeadlines().length, 1);
  } finally { er.restore(); }
});

test('an article with no url or title is not published', async () => {
  const er = load(respond([article({ url: '' }), article({ uri: 'x', title: '' })]));
  try {
    await er.startEventRegistry();
    assert.equal(er.getEventRegistryHeadlines().length, 0);
  } finally { er.restore(); }
});

test('it reports its own health each cycle', async () => {
  const seen: any[] = [];
  const good = load(respond([article()]));
  try {
    good.onEventRegistryHealth((h: any) => seen.push(h));
    await good.startEventRegistry();
    assert.deepEqual(seen.at(-1), { ok: true });
  } finally { good.restore(); }

  const bad = load(async () => {
    throw Object.assign(new Error('Request failed'), {
      response: { status: 429, data: 'rate limited' },
    });
  });
  try {
    bad.onEventRegistryHealth((h: any) => seen.push(h));
    await bad.startEventRegistry();
    assert.equal(seen.at(-1)?.ok, false);
    assert.match(seen.at(-1)?.reason ?? '', /429|rate limited/i);
  } finally { bad.restore(); }
});

test('no key means no request', async () => {
  let called = 0;
  const er = load(async () => { called++; return { data: { articles: { results: [] } } }; }, '');
  try {
    await er.startEventRegistry();
    assert.equal(called, 0);
  } finally { er.restore(); }
});

test('one batched call per cycle, not one per symbol', () => {
  // The free tier is metered per month and exposes no usage endpoint to read
  // the balance from, so the budget is conservative by construction: a query
  // per symbol would be twelve times the calls for the same articles.
  const code = readFileSync(CONNECTOR, 'utf8');
  assert.match(code, /keyword: WATCHED/, 'every watched name goes in one query');
  assert.match(code, /keywordOper: 'or'/);
  assert.match(code, /const POLL_MS = 60 \* 60_000/, 'hourly');
});

test('the poller releases the event loop and the token stays out of the URL', () => {
  const code = readFileSync(CONNECTOR, 'utf8');
  assert.match(code, /setInterval\(fetchHeadlines, POLL_MS\)\.unref\(\)/);
  // This API takes its key in the POST body rather than the query string, so
  // it cannot leak through a URL echoed into a public error body.
  assert.ok(!/apiKey=\$\{API_KEY\}/.test(code));
});
