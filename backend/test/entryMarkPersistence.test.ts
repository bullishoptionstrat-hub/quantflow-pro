/**
 * The entry price survives the process that took it.
 *
 * It used to reach storage only with the first outcome row, fifteen minutes
 * after the decision. A sleep, deploy or crash in between lost it, and
 * recovery — which never takes a fresh entry price, because a price from after
 * the decision is lookahead — could only grade every horizon UNGRADED. Render
 * spins a free service down after fifteen minutes idle and documents that it
 * may restart one at any time, so this was the ordinary case, not an edge.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemorySignalStore } from '../src/persistence/memoryStore';
import { SignalGrader, type Mark } from '../src/persistence/grader';
import type { SignalRecord, SignalStore } from '../src/persistence/types';

const T0 = Date.UTC(2026, 8, 18, 14, 30, 0);
const MIN = 60_000;
const RIGHTS = (src: string) => (src === 'twelvedata' ? 'UNVERIFIED' : undefined);

function signal(): SignalRecord {
  return {
    signalKey: 'e'.repeat(64), contentHash: 'e'.repeat(64), engineId: 'sig_1_1',
    underlying: 'SPY', kind: 'SWEEP', side: 'BUY', score: 80, totalPremium: 1_000_000, totalSize: 500,
    iso: true, scoreBreakdown: {},
    firstEventAt: T0 - 1_000, lastEventAt: T0 - 500, decisionAt: T0, decisionBasis: 'OBSERVED', latencyMs: 30,
    source: 'tradier', datasetId: 'TRADIER_STREAM', rightsClass: 'PERMITTED', synthetic: false, recordedAt: T0 + 70,
    legs: [{ contractSymbol: 'SPY261218C00550000', underlying: 'SPY', expiry: '2026-12-18', strike: 550, right: 'C',
      side: 'BUY', totalSize: 500, totalPremium: 1_000_000, vwap: 20, prints: 2, exchanges: ['CBOE'] }],
  };
}

/** A rising price quoted a second behind the clock, so a re-taken mark would differ from the original. */
const rising = (clock: () => number) => (): Mark => {
  const t = clock() - 1_000;
  return { price: 550 + ((t - T0) / MIN) * 0.05, source: 'twelvedata', rightsClass: 'UNVERIFIED', asOf: t };
};

test('the entry mark is written when it is taken, not fifteen minutes later', async () => {
  const store = new InMemorySignalStore();
  const rec = signal();
  await store.writeSignal(rec);
  let clock = T0;
  const g = new SignalGrader(store, rising(() => clock), {}, () => clock);
  g.register(rec);
  await g.settle();
  const m = await store.getEntryMark(rec.signalKey);
  assert.ok(m, 'stored at registration');
  assert.equal(m!.asOf, T0 - 1_000);
  assert.equal(m!.source, 'twelvedata');
  assert.equal(g.getStats().entryMarksPersisted, 1);
  assert.equal((await store.listOutcomes(rec.signalKey)).length, 0, 'and before any checkpoint was due');
});

test('a restart before the first checkpoint now grades it, from the original mark', async () => {
  const store = new InMemorySignalStore();
  const rec = signal();
  await store.writeSignal(rec);
  let clock = T0;
  const a = new SignalGrader(store, rising(() => clock), {}, () => clock);
  a.register(rec);
  await a.settle();
  const original = (await store.getEntryMark(rec.signalKey))!;

  // The process is gone before M15. A new one starts after it fell due.
  clock = T0 + 15 * MIN + 5_000;
  const b = new SignalGrader(store, rising(() => clock), {}, () => clock);
  const report = await b.recover(500, RIGHTS);
  assert.equal(report.withEntryMark, 1);
  assert.equal(await b.tick(), 1);
  const [m15] = await store.listOutcomes(rec.signalKey);
  assert.equal(m15!.label, 'POSITIVE');
  // The mark it was measured from is the one observed at the decision —
  // a price re-taken at recovery would be ~0.75 higher on this rising tape.
  assert.equal(m15!.entryMark, original.price);
  assert.equal(m15!.entryMarkAt, original.asOf);
  // A resumed mark came from storage; writing it back would count a write
  // that observed nothing new.
  await b.settle();
  assert.equal(b.getStats().entryMarksPersisted, 0, 'recovery does not re-persist the mark it read');
});

test('a signal never registered still grades UNGRADED, and no mark is taken at recovery', async () => {
  const store = new InMemorySignalStore();
  const rec = signal();
  await store.writeSignal(rec);
  const clock = T0 + 15 * MIN + 5_000;
  const g = new SignalGrader(store, rising(() => clock), {}, () => clock);
  assert.equal((await g.recover(500, RIGHTS)).withEntryMark, 0);
  await g.tick();
  const [m15] = await store.listOutcomes(rec.signalKey);
  assert.equal(m15!.label, 'UNGRADED');
  assert.equal(m15!.entryMark, undefined);
  assert.equal(await store.getEntryMark(rec.signalKey), undefined, 'recovery writes no entry mark of its own');
});

test('the entry mark is write-once: the first observation is kept', async () => {
  const store = new InMemorySignalStore();
  const rec = signal();
  await store.writeSignal(rec);
  const first = { signalKey: rec.signalKey, price: 550, source: 'twelvedata', asOf: T0 - 1_000 };
  assert.equal(await store.writeEntryMark(first), 'WRITTEN');
  assert.equal(await store.writeEntryMark({ ...first, price: 999, asOf: T0 + 60 * MIN }), 'EXISTS');
  assert.deepEqual(await store.getEntryMark(rec.signalKey), first);
  await assert.rejects(store.writeEntryMark({ ...first, signalKey: 'f'.repeat(64) }), /unknown signal/);
});

test('a failed entry-mark write is counted, and grading still proceeds from the mark held in memory', async () => {
  const inner = new InMemorySignalStore();
  const store: SignalStore = Object.assign(Object.create(Object.getPrototypeOf(inner)), inner, {
    writeEntryMark: async () => { throw new Error('store refused'); },
  });
  const rec = signal();
  await store.writeSignal(rec);
  let clock = T0;
  const g = new SignalGrader(store, rising(() => clock), {}, () => clock);
  g.register(rec);
  await g.settle();
  assert.equal(g.getStats().entryMarkWriteFailures, 1);
  clock = T0 + 15 * MIN + 5_000;
  await g.tick();
  assert.equal((await store.listOutcomes(rec.signalKey))[0]!.label, 'POSITIVE');
});

test('the durable store reads a numeric entry mark that arrives as a string', async () => {
  // PostgREST may send `numeric` as a JSON string (arbitrary precision does
  // not fit a float64). The local test stack happens to send a number, so
  // only a fixture in the string form exercises the coercion.
  const { SupabaseSignalStore } = await import('../src/persistence/supabaseStore');
  const row = { signal_key: 'e'.repeat(64), entry_mark: '550.25', mark_source: 'twelvedata', mark_at: '2026-09-18T14:29:59.000Z' };
  const chain = { select: () => chain, eq: () => chain, maybeSingle: async () => ({ data: row, error: null }) };
  const db = { from: () => chain } as unknown as ConstructorParameters<typeof SupabaseSignalStore>[0];
  const m = await new SupabaseSignalStore(db).getEntryMark(row.signal_key);
  assert.equal(m!.price, 550.25);
  assert.equal(typeof m!.price, 'number');
  assert.equal(m!.asOf, Date.parse(row.mark_at));
});
