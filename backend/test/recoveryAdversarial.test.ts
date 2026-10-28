/**
 * Restart recovery under the conditions a single clean restart never reaches:
 * recovery run twice, two recoveries at once, a stored entry mark that is not
 * a usable price, and a synthetic signal in the store.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemorySignalStore } from '../src/persistence/memoryStore';
import { SignalGrader, recoverEntryMark, type Mark } from '../src/persistence/grader';
import type { SignalRecord } from '../src/persistence/types';

const T0 = Date.UTC(2026, 8, 18, 14, 30, 0);
const RIGHTS = (s: string) => (s === 'twelvedata' ? 'UNVERIFIED' : undefined);
const mark = (stamp: () => number): ((u: string) => Mark) =>
  () => ({ price: 100, source: 'twelvedata', rightsClass: 'UNVERIFIED', asOf: stamp() });

function signal(key: string, over: Partial<SignalRecord> = {}): SignalRecord {
  return {
    signalKey: key.padEnd(64, '0'), engineId: 'e', underlying: 'SPY', kind: 'SWEEP', side: 'BUY',
    score: 80, totalPremium: 1e6, totalSize: 500, firstEventAt: T0 - 1000, lastEventAt: T0 - 500,
    receivedAt: T0, decisionAt: T0, decisionBasis: 'OBSERVED', source: 'tradier',
    datasetId: 'TRADIER_STREAM', rightsClass: 'PERMITTED', synthetic: false,
    legs: [{ underlying: 'SPY', expiry: '2026-12-18', strike: 550, right: 'C', side: 'BUY',
      totalSize: 500, totalPremium: 1e6, prints: 2 }],
    printIds: ['p1'], ...over,
  } as SignalRecord;
}

test('recovering twice, or twice at once, schedules each checkpoint once', async () => {
  const store = new InMemorySignalStore();
  const rec = signal('a');
  await store.writeSignal(rec);
  await store.writeEntryMark({ signalKey: rec.signalKey, price: 100, source: 'twelvedata', asOf: T0 - 1000 });

  let clock = T0 + 60_000;
  const g = new SignalGrader(store, mark(() => clock - 1000), {}, () => clock);
  await Promise.all([g.recover(500, RIGHTS), g.recover(500, RIGHTS)]);
  await g.recover(500, RIGHTS);
  assert.equal(g.getStats().tracked, 1);

  clock = T0 + 24 * 3600_000 + 5000;
  await g.tick();
  const horizons = (await store.listOutcomes(rec.signalKey)).map((o) => o.horizon).sort();
  assert.deepEqual(horizons, ['D1', 'H1', 'M15'], 'a duplicate outcome row was written');
});

test('two graders recovering the same signal leave one outcome per horizon', async () => {
  const store = new InMemorySignalStore();
  const rec = signal('b');
  await store.writeSignal(rec);
  await store.writeEntryMark({ signalKey: rec.signalKey, price: 100, source: 'twelvedata', asOf: T0 - 1000 });

  let clock = T0 + 60_000;
  const a = new SignalGrader(store, mark(() => clock - 1000), {}, () => clock);
  const b = new SignalGrader(store, mark(() => clock - 1000), {}, () => clock);
  await Promise.all([a.recover(500, RIGHTS), b.recover(500, RIGHTS)]);
  clock = T0 + 15 * 60_000 + 5000;
  await Promise.all([a.tick(), b.tick()]);
  const m15 = (await store.listOutcomes(rec.signalKey)).filter((o) => o.horizon === 'M15');
  assert.equal(m15.length, 1, 'concurrent graders finalized M15 twice');
});

test('a stored mark that is not a usable price is never used as the entry', () => {
  const bad = [
    { entryMark: Number.NaN, entryMarkSource: 'twelvedata', entryMarkAt: T0 },
    { entryMark: Infinity, entryMarkSource: 'twelvedata', entryMarkAt: T0 },
    { entryMark: -5, entryMarkSource: 'twelvedata', entryMarkAt: T0 },
    { entryMark: 0, entryMarkSource: 'twelvedata', entryMarkAt: T0 },
    { entryMark: 100, entryMarkSource: '', entryMarkAt: T0 },
    { entryMark: 100, entryMarkSource: 'twelvedata', entryMarkAt: Number.NaN },
    { entryMark: 100, entryMarkSource: 'unregistered', entryMarkAt: T0 },
  ];
  for (const o of bad) assert.equal(recoverEntryMark([o], RIGHTS), undefined, JSON.stringify(o));
});

test('a synthetic signal is never resumed', async () => {
  const store = new InMemorySignalStore();
  const rec = signal('c', { synthetic: true, source: 'simulation', datasetId: 'SIMULATION' });
  await store.writeSignal(rec);
  const g = new SignalGrader(store, mark(() => T0), {}, () => T0 + 60_000);
  await g.recover(500, RIGHTS);
  assert.equal(g.getStats().tracked, 0);
});
