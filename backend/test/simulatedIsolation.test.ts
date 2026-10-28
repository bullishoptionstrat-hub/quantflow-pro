/**
 * A simulated print is synthetic because of where it came from, not only
 * because its producer said so. SIMULATION is PERMITTED for PERSIST, so the
 * rights gate cannot stop an unflagged simulated print; before this, one
 * missing `synthetic: true` put generated data in the record as observed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIngestor, type RawPrint, type SignalOrigin } from '../src/ingestion/flowEngineAdapter';
import { InMemorySignalStore } from '../src/persistence/memoryStore';
import { SignalRecorder } from '../src/persistence/recorder';
import { isSimulatedSource } from '../src/provenance/rights';
import type { ClassifiedSignal } from '../src/flow-engine/types';

const T0 = Date.UTC(2026, 2, 3, 15, 0, 0);

function print(over: Partial<RawPrint>): RawPrint {
  return {
    ts: T0, quoteTs: T0, symbol: 'SPY', expiry: '2026-06-19', strike: 600, right: 'C',
    price: 5, size: 200, exchange: 'CBOE', bid: 4.9, ask: 5.0, underlyingPrice: 590,
    source: 'simulation', ...over,
  };
}

function run(p: RawPrint) {
  const iso = createIngestor({ now: () => T0 + 60_000 });
  const seen: Array<{ sig: ClassifiedSignal; origin: SignalOrigin }> = [];
  iso.onSignal((sig, origin) => seen.push({ sig, origin }));
  const wire = [...iso.ingestPrint(p), ...iso.flush()];
  return { wire, seen };
}

test('simulator sources are recognised by dataset', () => {
  assert.equal(isSimulatedSource('simulation'), true);
  assert.equal(isSimulatedSource('seed'), true);
  assert.equal(isSimulatedSource('tradier'), false);
  assert.equal(isSimulatedSource('unknown'), false);
  assert.equal(isSimulatedSource('constructor'), false);
});

for (const source of ['simulation', 'seed']) {
  test(`an unflagged ${source} print is synthetic on the wire and to the recorder`, () => {
    const { wire, seen } = run(print({ source, synthetic: undefined }));
    assert.ok(wire.length > 0);
    assert.ok(wire.every((e) => e.synthetic === true), 'wire event read as observed');
    assert.ok(seen.length > 0 && seen.every((s) => s.origin.synthetic === true));
  });
}

test('an explicit synthetic:false from a simulator is overruled', () => {
  const { seen } = run(print({ synthetic: false }));
  assert.ok(seen.every((s) => s.origin.synthetic === true));
});

function sig(n: number): ClassifiedSignal {
  return {
    id: `s${n}`, kind: 'BLOCK', ts: T0 + n, lastTs: T0 + n, receivedAt: T0 + n + 20, emittedAt: T0 + n + 30,
    underlying: 'SPY', side: 'BUY',
    legs: [{
      contract: { symbol: 'SPY260619C00600000', underlying: 'SPY', right: 'C', strike: 600, expiry: '2026-06-19' },
      side: 'BUY', totalSize: 200, totalPremium: 100_000, vwap: 5, prints: 1, exchanges: ['CBOE'],
    }],
    totalPremium: 100_000 + n, totalSize: 200, iso: false, score: 80, scoreBreakdown: {},
    printIds: [`p${n}`], synthetic: false,
  };
}

test('the recorder stores a simulator-sourced signal as synthetic even if told otherwise', async () => {
  const store = new InMemorySignalStore();
  const r = new SignalRecorder(store, 'PRIVATE_RESEARCH', () => T0);
  const out = await r.record(sig(1), { source: 'simulation', sources: ['simulation'], synthetic: false });
  assert.equal(out.status, 'RECORDED');
  const counts = await store.countSignals();
  assert.equal(counts.real, 0, 'a simulated signal was counted as real');
  assert.equal(counts.synthetic, 1);
});

test('a cluster mixing a simulator with any other source is synthetic', async () => {
  const store = new InMemorySignalStore();
  const r = new SignalRecorder(store, 'PRIVATE_RESEARCH', () => T0);
  assert.equal((await r.record(sig(2), { source: 'polygon', sources: ['polygon', 'seed'], synthetic: false })).status, 'RECORDED');
  const counts = await store.countSignals();
  assert.equal(counts.real, 0);
  assert.equal(counts.synthetic, 1);
});
