/**
 * Per source: prints accepted at the adapter seam and the receipt time of the
 * last, on this process's clock. `sources` on /api/health says a connector is
 * running; this says whether prints are arriving.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createIngestor, type RawPrint } from '../src/ingestion/flowEngineAdapter';

const T0 = Date.UTC(2026, 9, 26, 14, 30, 0);

function print(over: Partial<RawPrint> = {}): RawPrint {
  return {
    source: 'tradier', symbol: 'SPY', expiry: '2026-11-20', right: 'C', strike: 580,
    price: 5, size: 10, exchange: 'C', ts: T0 - 1_000, receivedAt: T0,
    ...over,
  } as RawPrint;
}

test('accepted prints are counted per source with the receipt time of the last', () => {
  let now = T0;
  const ing = createIngestor({ now: () => now });
  ing.ingestPrint(print());
  now = T0 + 5_000;
  ing.ingestPrint(print({ ts: now - 500, receivedAt: now }));
  ing.ingestPrint(print({ source: 'simulation', ts: now - 100, receivedAt: now }));
  assert.deepEqual(ing.printActivity(), {
    tradier: { accepted: 2, lastAcceptedAt: new Date(T0 + 5_000).toISOString() },
    simulation: { accepted: 1, lastAcceptedAt: new Date(T0 + 5_000).toISOString() },
  });
});

test('a refused print does not count as arriving', () => {
  const ing = createIngestor({ now: () => T0 });
  ing.ingestPrint(print({ strike: 0 }));
  ing.ingestPrint(print({ expiry: '20261120' }));
  ing.ingestPrint(print({ ts: Math.floor(T0 / 1_000) }));
  assert.deepEqual(ing.printActivity(), {}, 'nothing accepted, nothing reported');
});

test('the time is this process\'s clock, not the vendor\'s stamp', () => {
  // Off-hours the vendor stamp is the last session's close; reporting it here
  // would make a working stream look hours stale.
  const ing = createIngestor({ now: () => T0 });
  ing.ingestPrint(print({ ts: T0 - 6 * 3_600_000 }));
  assert.equal(ing.printActivity().tradier.lastAcceptedAt, new Date(T0).toISOString());
});

test('/api/health publishes it under ingestion.printActivity', () => {
  const src = readFileSync(join(__dirname, '..', 'src', 'ingestion', 'index.ts'), 'utf8');
  assert.match(src, /printActivity: printActivity\(\)/);
});
