/**
 * A stored entry mark that cannot be read is not "no entry mark".
 *
 * `recover()` read `signal_entry_marks` first and fell back to the mark an
 * outcome row recorded. A read that *threw* skipped the fallback: the whole
 * signal counted as `failed` and was left for the next boot, even when an
 * outcome row already held the mark. With the `signal_entry_marks` migration
 * not applied in production, every read throws, so every signal took that path.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemorySignalStore } from '../src/persistence/memoryStore';
import { SignalGrader, HORIZON_OFFSETS_MS, type Mark } from '../src/persistence/grader';
import type { SignalRecord } from '../src/persistence/types';

const T0 = Date.UTC(2026, 8, 18, 14, 30, 0);
const RIGHTS = (src: string) => (src === 'twelvedata' ? 'UNVERIFIED' : undefined);

function signal(): SignalRecord {
  return {
    signalKey: 'm'.repeat(64), engineId: 'sig_1_1', underlying: 'SPY', kind: 'SWEEP', side: 'BUY',
    score: 80, totalPremium: 1_000_000, totalSize: 500,
    firstEventAt: T0 - 1_000, lastEventAt: T0 - 500, receivedAt: T0, decisionAt: T0,
    decisionBasis: 'OBSERVED', source: 'tradier', datasetId: 'TRADIER_STREAM',
    rightsClass: 'PERMITTED', synthetic: false,
    legs: [{ underlying: 'SPY', expiry: '2026-12-18', strike: 550, right: 'C',
      side: 'BUY', totalSize: 500, totalPremium: 1_000_000, prints: 2 }],
    printIds: ['p1', 'p2'],
  } as unknown as SignalRecord;
}

function storeWithUnreadableMarks() {
  const store = new InMemorySignalStore();
  store.getEntryMark = async () => {
    throw new Error('relation "public.signal_entry_marks" does not exist');
  };
  return store;
}

const now = T0 + HORIZON_OFFSETS_MS.M15 + 5 * 60_000; // after M15, before H1
const mark = (): Mark => ({ price: 101, source: 'twelvedata', rightsClass: 'UNVERIFIED', asOf: now });

test('an unreadable stored mark falls back to the outcome row and the signal resumes', async () => {
  const store = storeWithUnreadableMarks();
  const rec = signal();
  await store.writeSignal(rec);
  await store.writeOutcome({
    signalKey: rec.signalKey, horizon: 'M15', label: 'FLAT', directionalReturnAtHorizon: 0,
    entryMark: 100, entryMarkSource: 'twelvedata', entryMarkAt: T0 - 1_000,
    exitMark: 100, exitMarkSource: 'twelvedata', exitMarkAt: T0 + HORIZON_OFFSETS_MS.M15,
    dueAt: T0 + HORIZON_OFFSETS_MS.M15, evaluatedAt: T0 + HORIZON_OFFSETS_MS.M15, revision: 1,
  });

  const g = new SignalGrader(store, mark, {}, () => now);
  const r = await g.recover(10, RIGHTS);
  assert.equal(r.failed, 0, 'the signal is not abandoned');
  assert.equal(r.resumed, 1);
  assert.equal(r.withEntryMark, 1, 'and it carries the mark the outcome row recorded');
  assert.equal(r.entryMarkReadFailures, 1, 'the read failure is still counted');
  assert.equal(g.getStats().tracked, 1);
});

test('with no outcome row to fall back on, the signal waits for the next boot', async () => {
  // Resuming without a mark would grade every horizon UNGRADED for good over
  // what may be a brief outage, so the read failure stays a failure.
  const store = storeWithUnreadableMarks();
  await store.writeSignal(signal());
  const g = new SignalGrader(store, mark, {}, () => T0 + 60_000);
  const r = await g.recover(10, RIGHTS);
  assert.equal(r.resumed, 0);
  assert.equal(r.failed, 1);
  assert.equal(r.entryMarkReadFailures, 1);
  assert.equal(g.getStats().tracked, 0);
});

test('a readable store reports no read failures', async () => {
  const store = new InMemorySignalStore();
  await store.writeSignal(signal());
  const g = new SignalGrader(store, mark, {}, () => T0 + 60_000);
  const r = await g.recover(10, RIGHTS);
  assert.equal(r.entryMarkReadFailures, 0);
  assert.equal(r.failed, 0);
});
