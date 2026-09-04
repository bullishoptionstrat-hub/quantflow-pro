/**
 * `/api/sentiment/news/headlines` published two different records under one
 * key, and the news page could not have read either of them.
 *
 * The route concatenated `getNewsHeadlines()` (NewsAPI) with `getFMPNews()`
 * (FMP) and sent the result as `headlines`. The two connectors do not agree on
 * a single field name that matters:
 *
 *   NewsAPI  id, symbols[], publishedAt, source = the outlet ("Reuters")
 *   FMP      —,  symbol,    publishedDate, source = the literal 'fmp'
 *
 * So a client with one interface for the array was wrong for half of it. The
 * frontend's was written against the NewsAPI shape, which made `h.symbols`
 * `undefined` on every FMP item and `h.symbols.length` a TypeError that
 * unmounts the page — the same latent throw as `StooqQuote.price.toFixed(2)`,
 * waiting on an `FMP_API_KEY` rather than on a code change. `publishedAt` was
 * the quieter half: `undefined` dates to `NaN` and renders "NaNd ago".
 *
 * `toNewsWireItem` resolves the union at the boundary so the route publishes
 * one contract. These tests drive it with values typed as the connectors' own
 * exported interfaces, so a connector renaming a field breaks the typecheck
 * here rather than in a browser.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { toNewsWireItem, type NewsWireItem } from '../src/routes/sentiment';
import type { NewsHeadline } from '../src/ingestion/connectors/newsApi';
import type { NewsItem } from '../src/ingestion/connectors/fmp';
import type { EventRegistryHeadline } from '../src/ingestion/connectors/eventRegistry';

const FROM_NEWSAPI: NewsHeadline = {
  id: 'newsapi-9f2c',
  title: 'Chipmaker guides above consensus on datacenter demand',
  description: 'Full text the wire does not carry.',
  url: 'https://example.test/newsapi/chipmaker',
  source: 'Reuters',
  publishedAt: '2026-09-02T13:45:00.000Z',
  symbols: ['NVDA', 'AMD'],
  sentiment: 'bullish',
  relevanceScore: 0.82,
  provider: 'newsapi',
};

const FROM_FMP: NewsItem = {
  symbol: 'TSLA',
  title: 'Deliveries come in under the street',
  url: 'https://example.test/fmp/deliveries',
  publishedDate: '2026-09-02T11:10:00.000Z',
  sentiment: 'bearish',
  source: 'fmp',
};

const FROM_EVENT_REGISTRY: EventRegistryHeadline = {
  id: 'er:9455804617',
  title: 'Wall Street ends sharply higher as rate-hike fears ease',
  description: 'Body text the wire does not carry in full.',
  url: 'https://example.test/er/wall-street',
  source: 'Free Malaysia Today',
  publishedAt: '2026-09-03T21:39:18Z',
  symbols: ['SPY', 'QQQ'],
  sentiment: 'bullish',
  sentimentScore: 0.176,
  provider: 'eventregistry',
};

/** Every key a client is entitled to read, present on all three. */
const REQUIRED: (keyof NewsWireItem)[] = [
  'id', 'title', 'url', 'publisher', 'provider', 'publishedAt', 'symbols',
  'sentiment', 'sentimentBasis',
];

test('all three connectors normalize to the same set of keys', () => {
  for (const item of [
    toNewsWireItem(FROM_NEWSAPI), toNewsWireItem(FROM_FMP), toNewsWireItem(FROM_EVENT_REGISTRY),
  ]) {
    for (const key of REQUIRED) {
      assert.ok(key in item, `${item.provider} item is missing ${key}`);
      assert.notEqual(item[key], undefined, `${item.provider} item has ${key} undefined`);
    }
  }
});

test('symbols is always an array, so reading .length cannot throw', () => {
  // The defect this route shipped. FMP carries a singular `symbol`; a client
  // typed against NewsAPI called `.length` on `undefined`.
  assert.deepEqual(toNewsWireItem(FROM_NEWSAPI).symbols, ['NVDA', 'AMD']);
  assert.deepEqual(toNewsWireItem(FROM_FMP).symbols, ['TSLA']);

  // An FMP item with no symbol is a valid record, not an error: it normalizes
  // to an empty list rather than to `[undefined]`, which would render a blank
  // ticker chip.
  assert.deepEqual(toNewsWireItem({ ...FROM_FMP, symbol: '' }).symbols, []);
});

test('publishedAt is a parseable instant on both, under one name', () => {
  for (const item of [toNewsWireItem(FROM_NEWSAPI), toNewsWireItem(FROM_FMP)]) {
    assert.ok(
      Number.isFinite(new Date(item.publishedAt).getTime()),
      `${item.provider} publishedAt does not parse: ${item.publishedAt}`,
    );
  }
});

test('publisher names the outlet, and is null when nobody named one', () => {
  // The trap being closed: both connectors have a `source`, and it means the
  // outlet in one and the connector in the other. A client rendering `source`
  // as a byline printed "fmp" beside half its headlines.
  assert.equal(toNewsWireItem(FROM_NEWSAPI).publisher, 'Reuters');
  assert.equal(toNewsWireItem(FROM_FMP).publisher, null);

  assert.equal(toNewsWireItem(FROM_NEWSAPI).provider, 'newsapi');
  assert.equal(toNewsWireItem(FROM_FMP).provider, 'fmp');
});

test("the connector's own 'Unknown' sentinel is not passed off as an outlet", async () => {
  // `newsApi.ts` writes `a.source?.name ?? 'Unknown'`, so an article naming no
  // outlet arrives with a placeholder in the field a client renders as a
  // byline. It is normalized to `null` here rather than printed in the same
  // colour as "Reuters" — and the sentinel is read out of the connector so
  // this test cannot pass while the connector uses a different one.
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const connector = readFileSync(
    join(__dirname, '..', 'src', 'ingestion', 'connectors', 'newsApi.ts'), 'utf8');
  const sentinel = connector.match(/source:\s*a\.source\?\.name\s*\?\?\s*'([^']+)'/)?.[1];
  assert.equal(sentinel, 'Unknown', 'the newsapi connector changed its no-outlet placeholder');

  assert.equal(toNewsWireItem({ ...FROM_NEWSAPI, source: sentinel }).publisher, null);
});

test('ids are present and do not collide across providers', () => {
  const a = toNewsWireItem(FROM_NEWSAPI);
  const b = toNewsWireItem(FROM_FMP);
  assert.notEqual(a.id, b.id);

  // FMP sends no id, so the URL stands in. A NewsAPI id that happened to be a
  // URL would otherwise key against it in the same list.
  assert.equal(b.id, `fmp:${FROM_FMP.url}`);
  assert.equal(toNewsWireItem({ ...FROM_NEWSAPI, id: FROM_FMP.url }).id, FROM_FMP.url);
});

test('the route maps every item it sends, on both news paths', async () => {
  // `toNewsWireItem` being correct is worth nothing if a path forgets to call
  // it — the same class of miss as a connector bypassing `quoteTimestamp()`.
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const src = readFileSync(join(__dirname, '..', 'src', 'routes', 'sentiment.ts'), 'utf8');

  // Every line that puts a news array on a response body, wherever it sits in
  // the object literal. The filter is not keyed on anything incidental to
  // today's two call sites — `.slice(` was the first version of this and a
  // third path written without it would have dropped out of the check while
  // the count still passed.
  const emitting = [...src.matchAll(/^[^\S\n]*(?:res\.json\(\{\s*)?(?:headlines|news):[^\n]*$/gm)]
    .map(m => m[0]!)
    .filter(line => !line.trim().startsWith('*') && !line.trim().startsWith('//'));

  // Exact, not a floor: a new news-emitting response has to come here and say
  // so rather than pass by being ignored.
  assert.equal(emitting.length, 2,
    `expected exactly two news-emitting responses, found ${emitting.length}:\n${emitting.join('\n')}`);
  for (const line of emitting) {
    assert.match(line, /toNewsWireItem/, `a news response is sent unnormalized: ${line.trim()}`);
  }
});

// ─── The third source ───────────────────────────────────────────────────────

/**
 * Event Registry (newsapi.ai) is a different vendor from newsapi.org, despite
 * the name — different key, endpoint and response shape. A newsapi.ai key sent
 * to newsapi.org returns `apiKeyInvalid`, which is how the connector came to
 * exist.
 *
 * It is the only source that scores its own articles. The other two carry no
 * score, so this service classifies them with its own keyword list — and the
 * wire has to say which, or one field name carries two provenances. That is
 * exactly what `source` did before it was split into `publisher`/`provider`.
 */

test('a vendor-scored article is marked as such, and a keyword-scored one is not', () => {
  assert.equal(toNewsWireItem(FROM_EVENT_REGISTRY).sentimentBasis, 'vendor');
  assert.equal(toNewsWireItem(FROM_NEWSAPI).sentimentBasis, 'keyword');
  assert.equal(toNewsWireItem(FROM_FMP).sentimentBasis, 'keyword');
});

test('the third provider is distinguishable from the other two', () => {
  // `symbols` separates FMP from the other two; `provider` separates those
  // two from each other. Both discriminants are on the record.
  assert.equal(toNewsWireItem(FROM_EVENT_REGISTRY).provider, 'eventregistry');
  assert.equal(toNewsWireItem(FROM_NEWSAPI).provider, 'newsapi');
  assert.equal(toNewsWireItem(FROM_FMP).provider, 'fmp');
});

test('the outlet is carried through, not the vendor', () => {
  // Event Registry sends `source.title` (the outlet) and `source.uri` (its
  // domain). Publishing "newsapi.ai" as the byline would be the `fmp` mistake.
  assert.equal(toNewsWireItem(FROM_EVENT_REGISTRY).publisher, 'Free Malaysia Today');
});

test('its publication time is the outlet\'s, not the vendor\'s discovery time', () => {
  // The API returns both `dateTimePub` (when the outlet published) and
  // `dateTime` (when Event Registry saw it). A reader means the first.
  const item = toNewsWireItem(FROM_EVENT_REGISTRY);
  assert.equal(item.publishedAt, '2026-09-03T21:39:18Z');
  assert.ok(Number.isFinite(new Date(item.publishedAt).getTime()));
});

test('the connector reads dateTimePub in preference to dateTime', () => {
  const { readFileSync } = require('node:fs') as typeof import('node:fs');
  const { join } = require('node:path') as typeof import('node:path');
  const code = readFileSync(
    join(__dirname, '..', 'src', 'ingestion', 'connectors', 'eventRegistry.ts'), 'utf8');
  assert.match(code, /a\?\.dateTimePub === 'string'\s*\n?\s*\?/,
    'dateTimePub must be preferred over the vendor\'s discovery time');
});
