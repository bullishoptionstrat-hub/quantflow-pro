/**
 * The enrichment cache was unbounded, and a caller wrote its keys.
 *
 * `InMemoryCache` was a plain `Map` that deleted a key only when that same key
 * was read back after expiry. A key written and never read again stayed for
 * the life of the process — and the news key is `fc:news:${query}:${limit}`,
 * where `query` is a caller-supplied string of up to 200 characters from
 * `/api/sentiment/context?q=`. A signed-in caller could therefore write a new
 * permanent entry per request, each holding up to ten serialized news items.
 *
 * Separately, an empty scrape was cached like any other document: one bad
 * fetch published a document whose `contentHash` is the hash of the empty
 * string, and held it for six hours. A source that is down must not present
 * itself as data.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { EnrichmentService, InMemoryCache } from '../src/enrichment/firecrawl/enrichment.service';

const silent = { info() {}, warn() {}, error() {} };

test('the cache does not grow without bound', async () => {
  const cache = new InMemoryCache(50);
  for (let i = 0; i < 5_000; i++) {
    await cache.set(`fc:news:query-${i}:5`, JSON.stringify([{ url: 'u', title: 't' }]), 900);
  }
  assert.equal(cache.size, 50, 'an unbounded map is a memory-exhaustion surface');
});

test('expired entries are dropped before anything live is evicted', async () => {
  const cache = new InMemoryCache(3);
  await cache.set('stale-a', 'a', -1);
  await cache.set('stale-b', 'b', -1);
  await cache.set('live-1', '1', 900);
  await cache.set('live-2', '2', 900);   // over the cap: the two stale ones go

  assert.equal(await cache.get('live-1'), '1', 'a live entry must survive a stale flood');
  assert.equal(await cache.get('live-2'), '2');
  assert.equal(await cache.get('stale-a'), null);
});

test('eviction is least-recently-used, not oldest-written', async () => {
  // A hot query must not be evicted by a flood of one-shot ones.
  const cache = new InMemoryCache(3);
  await cache.set('hot', 'H', 900);
  await cache.set('b', 'B', 900);
  await cache.set('c', 'C', 900);

  await cache.get('hot');           // touch it: now most-recently-used
  await cache.set('d', 'D', 900);   // evicts the least-recently-used, which is `b`

  assert.equal(await cache.get('hot'), 'H', 'the read should have saved it');
  assert.equal(await cache.get('b'), null);
});

test('an expired entry is not served', async () => {
  const cache = new InMemoryCache(10);
  await cache.set('k', 'v', -1);
  assert.equal(await cache.get('k'), null);
});

test('an empty scrape is not cached as a document', async () => {
  let scrapes = 0;
  const client = {
    async scrape() { scrapes++; return { markdown: '   ', metadata: { title: 'FINRA' } }; },
    async search() { return []; },
  } as never;

  const cache = new InMemoryCache(10);
  const svc = new EnrichmentService(client, { cache, logger: silent });

  await svc.fetchFinraNotice('https://finra.test/notices');
  assert.equal(cache.size, 0, 'a failed scrape must not occupy the cache for six hours');

  // And the next call actually retries rather than serving the empty document.
  await svc.fetchFinraNotice('https://finra.test/notices');
  assert.equal(scrapes, 2);
});

test('a real document is cached, and served without a second fetch', async () => {
  let scrapes = 0;
  const client = {
    async scrape() { scrapes++; return { markdown: '# Notice\n\nBody.', metadata: { title: 'FINRA' } }; },
    async search() { return []; },
  } as never;

  const cache = new InMemoryCache(10);
  const svc = new EnrichmentService(client, { cache, logger: silent });

  const first = await svc.fetchFinraNotice('https://finra.test/notices');
  const second = await svc.fetchFinraNotice('https://finra.test/notices');
  assert.equal(scrapes, 1, 'the second call should be served from cache');
  assert.equal(second.doc.contentHash, first.doc.contentHash);
  assert.equal(cache.size, 1);
});

test('change detection reports unchanged against a matching hash', async () => {
  const client = {
    async scrape() { return { markdown: 'same', metadata: {} }; },
    async search() { return []; },
  } as never;
  const svc = new EnrichmentService(client, { cache: new InMemoryCache(10), logger: silent });

  const first = await svc.fetchFinraNotice('https://finra.test/a');
  assert.equal(first.changed, true, 'no previous hash means it is new to the caller');

  const again = await svc.fetchFinraNotice('https://finra.test/a', first.doc.contentHash);
  assert.equal(again.changed, false);
});
