/**
 * Enrichment seam tests.
 *
 * The vendored Firecrawl module has its own guarantees (schema validation,
 * retry/backoff, typed errors). What is tested here is only what the seam adds:
 * the keyless default, the latch that stops spending after a terminal error, and
 * the context-only contract riding on the payload.
 *
 * No network: `fetch` is stubbed, so these assert the seam's behaviour rather
 * than Firecrawl's availability.
 *
 * Run: npm test
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const realFetch = globalThis.fetch;
const realKey = process.env.FIRECRAWL_API_KEY;

/** Reload the seam so its module-level state starts clean for each test. */
async function loadSeam() {
  const path = require.resolve('../src/enrichment/index');
  delete require.cache[path];
  return require('../src/enrichment/index') as typeof import('../src/enrichment/index');
}

function stubFetch(handler: () => { status: number; body?: unknown }) {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    const { status, body } = handler();
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body ?? ''),
    } as any;
  }) as any;
  return { calls: () => calls };
}

beforeEach(() => { delete process.env.FIRECRAWL_API_KEY; });

afterEach(() => {
  globalThis.fetch = realFetch;
  if (realKey === undefined) delete process.env.FIRECRAWL_API_KEY;
  else process.env.FIRECRAWL_API_KEY = realKey;
});

test('no key is "disabled", not "error" — a keyless deploy is a choice, not a fault', async () => {
  const seam = await loadSeam();
  seam.startEnrichment();
  const status = seam.getEnrichmentStatus();
  assert.equal(status.state, 'disabled');
  assert.equal(status.latchedOff, false);
  assert.match(status.reason, /FIRECRAWL_API_KEY is not set/);
});

test('a request with no key fails without touching the network', async () => {
  const seam = await loadSeam();
  const fetchStub = stubFetch(() => ({ status: 200, body: {} }));
  seam.startEnrichment();

  await assert.rejects(
    () => seam.fetchNewsContext('SPY'),
    (err: any) => err.name === 'EnrichmentUnavailable' && err.httpStatus === 503,
  );
  assert.equal(fetchStub.calls(), 0, 'must not spend a request without a key');
});

test('a malformed key is rejected at startup and latches off', async () => {
  process.env.FIRECRAWL_API_KEY = 'not-an-fc-key';
  const seam = await loadSeam();
  seam.startEnrichment();
  const status = seam.getEnrichmentStatus();
  assert.equal(status.state, 'error');
  assert.equal(status.latchedOff, true);
});

test('a successful fetch carries the context-only contract on the payload', async () => {
  process.env.FIRECRAWL_API_KEY = 'fc-testkey';
  const seam = await loadSeam();
  stubFetch(() => ({
    status: 200,
    body: {
      success: true,
      data: [{ url: 'https://example.test/a', title: 'A', description: 'snippet' }],
    },
  }));
  seam.startEnrichment();

  const result = await seam.fetchNewsContext('SPY', 1);
  assert.equal(result.context_only, true);
  assert.match(result.disclaimer, /never a trade trigger/i);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].url, 'https://example.test/a');
  assert.equal(seam.getEnrichmentStatus().state, 'connected');
});

test('402 latches the service off — no further request spends a credit', async () => {
  process.env.FIRECRAWL_API_KEY = 'fc-testkey';
  const seam = await loadSeam();
  const fetchStub = stubFetch(() => ({ status: 402, body: { error: 'out of credits' } }));
  seam.startEnrichment();

  await assert.rejects(
    () => seam.fetchNewsContext('SPY'),
    (err: any) => err.httpStatus === 503 && err.code === 'INSUFFICIENT_CREDITS',
  );
  const after = fetchStub.calls();
  assert.equal(after, 1, '402 must fail fast, not retry');
  assert.equal(seam.getEnrichmentStatus().latchedOff, true);

  // The whole point of the latch: the second call never reaches the network.
  await assert.rejects(() => seam.fetchNewsContext('QQQ'), (e: any) => e.httpStatus === 503);
  assert.equal(fetchStub.calls(), after, 'latched off must not issue another request');
});

test('401 latches off too — a revoked key does not un-revoke itself', async () => {
  process.env.FIRECRAWL_API_KEY = 'fc-testkey';
  const seam = await loadSeam();
  const fetchStub = stubFetch(() => ({ status: 401 }));
  seam.startEnrichment();

  await assert.rejects(
    () => seam.fetchNewsContext('SPY'),
    (err: any) => err.httpStatus === 503 && err.code === 'AUTH',
  );
  assert.equal(fetchStub.calls(), 1, '401 must fail fast, not retry');
  assert.equal(seam.getEnrichmentStatus().latchedOff, true);
});

test('a transient upstream failure does NOT latch — the next request may try again', async () => {
  process.env.FIRECRAWL_API_KEY = 'fc-testkey';
  const seam = await loadSeam();
  let mode: 'fail' | 'ok' = 'fail';
  stubFetch(() =>
    mode === 'fail'
      ? { status: 503 }
      : { status: 200, body: { success: true, data: [] } },
  );
  seam.startEnrichment();

  await assert.rejects(
    () => seam.fetchNewsContext('SPY'),
    (err: any) => err.httpStatus === 502,
  );
  const status = seam.getEnrichmentStatus();
  assert.equal(status.state, 'error');
  assert.equal(status.latchedOff, false, 'a 5xx is transient and must not latch');

  // And recovery clears the recorded failure.
  mode = 'ok';
  const result = await seam.fetchNewsContext('SPY');
  assert.equal(result.context_only, true);
  assert.equal(seam.getEnrichmentStatus().state, 'connected');
});
