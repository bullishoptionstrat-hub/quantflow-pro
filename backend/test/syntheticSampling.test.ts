/**
 * The recorder writes at most one synthetic signal a minute and never samples
 * a real one. See SYNTHETIC_PERSIST_INTERVAL_MS for the production measurement
 * that made this necessary.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemorySignalStore } from '../src/persistence/memoryStore';
import { SignalRecorder, SYNTHETIC_PERSIST_INTERVAL_MS } from '../src/persistence/recorder';
import type { ClassifiedSignal } from '../src/flow-engine/types';

const T0 = Date.UTC(2026, 9, 27, 15, 0, 0);

function sig(n: number, synthetic: boolean): ClassifiedSignal {
  // Distinct content per n, so each is a new signal rather than a replay.
  return {
    id: `sig_${n}`, kind: 'SWEEP', ts: T0 + n, lastTs: T0 + n + 500,
    receivedAt: T0 + n + 520, emittedAt: T0 + n + 530,
    underlying: 'SPY', side: 'BUY',
    legs: [{
      contract: { symbol: 'SPY261120C00580000', underlying: 'SPY', right: 'C', strike: 580, expiry: '2026-11-20' },
      side: 'BUY', totalSize: 100, totalPremium: 250_000, vwap: 25, prints: 1, exchanges: ['CBOE'],
    }],
    totalPremium: 250_000 + n, totalSize: 100, iso: true,
    score: 82, scoreBreakdown: {}, printIds: [`p${n}`], synthetic,
  };
}

const simulated = { source: 'simulation', sources: ['simulation'], synthetic: true };
const real = { source: 'tradier', sources: ['tradier'], synthetic: false };

test('a second synthetic signal inside the interval is counted, not written', async () => {
  let now = T0;
  const store = new InMemorySignalStore();
  const r = new SignalRecorder(store, 'PRIVATE_RESEARCH', () => now);

  assert.equal((await r.record(sig(1, true), simulated)).status, 'RECORDED');
  now += SYNTHETIC_PERSIST_INTERVAL_MS - 1;
  assert.equal((await r.record(sig(2, true), simulated)).status, 'SYNTHETIC_SAMPLED_OUT');

  const counts = await store.countSignals();
  assert.equal(counts.synthetic, 1);
  const s = r.getStats();
  assert.equal(s.syntheticRecorded, 1);
  assert.equal(s.syntheticSampledOut, 1);
  assert.equal(s.seen, 2);
});

test('once the interval has passed the next synthetic signal is written', async () => {
  let now = T0;
  const store = new InMemorySignalStore();
  const r = new SignalRecorder(store, 'PRIVATE_RESEARCH', () => now);

  await r.record(sig(1, true), simulated);
  now += SYNTHETIC_PERSIST_INTERVAL_MS;
  assert.equal((await r.record(sig(2, true), simulated)).status, 'RECORDED');
  assert.equal((await store.countSignals()).synthetic, 2);
});

test('real signals are never sampled, even between synthetic ones', async () => {
  const now = T0;
  const store = new InMemorySignalStore();
  const r = new SignalRecorder(store, 'PRIVATE_RESEARCH', () => now);

  await r.record(sig(1, true), simulated);
  for (let n = 2; n < 12; n++) {
    assert.equal((await r.record(sig(n, false), real)).status, 'RECORDED');
  }
  assert.equal((await store.countSignals()).real, 10);
  assert.equal(r.getStats().syntheticSampledOut, 0);
});

test('concurrent synthetic records in one minute write exactly one row', async () => {
  const store = new InMemorySignalStore();
  const r = new SignalRecorder(store, 'PRIVATE_RESEARCH', () => T0);
  const results = await Promise.all([1, 2, 3, 4, 5].map((n) => r.record(sig(n, true), simulated)));
  assert.equal(results.filter((x) => x.status === 'RECORDED').length, 1);
  assert.equal((await store.countSignals()).synthetic, 1);
});
