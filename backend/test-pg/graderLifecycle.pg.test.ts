/**
 * The grader's whole durable life, against a real PostgreSQL + PostgREST.
 *
 * Record a signal, grade a checkpoint, restart, recover, grade the rest, and
 * report — the path a track record depends on, end to end. Every piece of it
 * has unit tests, and every one of those runs against `InMemorySignalStore`.
 * Recovery in particular exists *only* for the durable store: the memory
 * store does not survive the restart recovery is for, so the one environment
 * where `recover()` matters is the one it had never run in.
 *
 * Each scenario is a script run twice — once per store — and the answers must
 * match. Where they do not, the memory store has been describing a grader that
 * does not run in production.
 */
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { startStack, type Stack } from '../tools/pgstack/stack';
import { SupabaseSignalStore } from '../src/persistence/supabaseStore';
import { InMemorySignalStore } from '../src/persistence/memoryStore';
import { SignalGrader, type Mark } from '../src/persistence/grader';
import { HORIZON_NOMINAL_MS } from '../src/persistence/types';
import type { SignalRecord, SignalStore } from '../src/persistence/types';

let stack: Stack;
let db: SupabaseClient;

before(async () => {
  stack = await startStack();
  db = createClient(stack.url, stack.serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
});
after(async () => { await stack?.stop(); });
beforeEach(() => {
  stack.psql(
    'truncate public.signal_outcomes, public.signal_write_incidents, '
    + 'public.collection_gaps, public.signal_history restart identity cascade;',
  );
});

const T0 = Date.parse('2026-09-18T14:30:00.000Z');
const SEC = 1_000;
const MIN = 60 * SEC;

function signal(over: Partial<SignalRecord> = {}): SignalRecord {
  const key = 'a'.repeat(64);
  return {
    signalKey: key,
    contentHash: key,
    engineId: 'sig_1_x',
    kind: 'SWEEP',
    underlying: 'SPY',
    side: 'BUY',
    totalPremium: 1_000_000,
    totalSize: 500,
    iso: true,
    score: 80,
    scoreBreakdown: {},
    legs: [{
      contractSymbol: 'SPY261218C00550000',
      underlying: 'SPY', right: 'C', strike: 550, expiry: '2026-12-18',
      side: 'BUY', totalSize: 500, totalPremium: 1_000_000, vwap: 20,
      prints: 2, exchanges: ['CBOE'],
    }],
    firstEventAt: T0 - 1_000,
    lastEventAt: T0 - 500,
    decisionAt: T0,
    decisionBasis: 'OBSERVED',
    latencyMs: 30,
    source: 'tradier',
    datasetId: 'TRADIER_STREAM',
    rightsClass: 'PERMITTED',
    synthetic: false,
    recordedAt: T0 + 70,
    ...over,
  };
}

const RIGHTS = (src: string) => (src === 'twelvedata' ? 'UNVERIFIED' : undefined);

/**
 * A rising underlying, quoted a second behind the clock. A bought call on a
 * rising price is POSITIVE, so every graded label here is a real measurement
 * rather than a dead-band FLAT that would agree for the wrong reason.
 */
function rising(clock: () => number) {
  return (): Mark => {
    const t = clock() - SEC;
    return { price: 550 + ((t - T0) / MIN) * 0.05, source: 'twelvedata', rightsClass: 'UNVERIFIED', asOf: t };
  };
}

const due = (h: 'M15' | 'H1' | 'D1') => T0 + HORIZON_NOMINAL_MS[h] + 5 * SEC;

const defined = <T extends object>(o: T): T =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

async function snapshot(store: SignalStore, key: string) {
  const outcomes = (await store.listOutcomes(key))
    .map(defined)
    .sort((a, b) => a.horizon.localeCompare(b.horizon));
  const ungraded = (await store.listUngraded(100)).map((r) => r.signalKey);
  const tr = await store.trackRecord();
  return { outcomes, ungraded, rows: tr.rows, excluded: tr.excluded };
}

/** Graded at M15 by one process, recovered and finished by the next. */
async function gradedThenRestarted(store: SignalStore) {
  const rec = signal();
  await store.writeSignal(rec);
  let clock = T0;
  const now = () => clock;

  const a = new SignalGrader(store, rising(now), {}, now);
  a.register(rec);
  clock = due('M15');
  assert.equal(await a.tick(), 1);

  // Restart. The grader's memory is gone; the store is not.
  clock = due('H1');
  const b = new SignalGrader(store, rising(now), {}, now);
  const report = await b.recover(500, RIGHTS);
  assert.equal(await b.tick(), 1);
  clock = due('D1');
  assert.equal(await b.tick(), 1);
  // Zero refused writes, not merely the right rows: a recovery that
  // rescheduled the already-graded M15 would still leave three rows — the
  // one-live-outcome index refuses the duplicate — while retrying it on every
  // tick for the life of the process. The rows cannot show that; the counter
  // can.
  return { report, writeFailures: b.getStats().writeFailures, ...(await snapshot(store, rec.signalKey)) };
}

/** A restart before the first checkpoint: nothing was persisted to resume from. */
async function restartedBeforeAnyGrade(store: SignalStore) {
  const rec = signal();
  await store.writeSignal(rec);
  let clock = T0;
  const now = () => clock;
  new SignalGrader(store, rising(now), {}, now).register(rec);

  clock = due('M15');
  const b = new SignalGrader(store, rising(now), {}, now);
  const report = await b.recover(500, RIGHTS);
  assert.equal(await b.tick(), 1);
  return { report, ...(await snapshot(store, rec.signalKey)) };
}

test('graded, restarted, recovered: the durable store answers exactly as the memory store does', async () => {
  const pg = await gradedThenRestarted(new SupabaseSignalStore(db));
  const mem = await gradedThenRestarted(new InMemorySignalStore());
  assert.deepEqual(pg, mem);

  // And the answer is the right one, not merely the same one.
  assert.deepEqual(pg.report, { examined: 1, resumed: 1, alreadyComplete: 0, withEntryMark: 1, failed: 0 });
  assert.equal(pg.writeFailures, 0, 'no horizon already graded is attempted again');
  assert.deepEqual(pg.outcomes.map((o) => o.label), ['POSITIVE', 'POSITIVE', 'POSITIVE']);
  const entries = new Set(pg.outcomes.map((o) => `${o.entryMark}@${o.entryMarkAt}`));
  assert.equal(entries.size, 1, 'every horizon is measured from the one entry mark taken at the decision');
  assert.deepEqual(pg.ungraded, [], 'a fully graded signal leaves the open set');
});

test('a restart before any grade leaves no entry mark to resume from, and the store says so', async () => {
  const pg = await restartedBeforeAnyGrade(new SupabaseSignalStore(db));
  const mem = await restartedBeforeAnyGrade(new InMemorySignalStore());
  assert.deepEqual(pg, mem);

  assert.equal(pg.report.withEntryMark, 0);
  const [m15] = pg.outcomes;
  assert.equal(m15!.label, 'UNGRADED');
  assert.equal(m15!.entryMark, undefined, 'no mark was re-taken at recovery time');
  assert.match(m15!.ungradedReason ?? '', /No usable entry mark/);
});

test('a write the database refuses keeps the checkpoint pending, and the next tick writes it', async () => {
  // The failure is real, not stubbed: the service role loses INSERT on the
  // outcomes table, which is the shape of the missing-column failure that
  // once retired checkpoints without a row.
  const store = new SupabaseSignalStore(db);
  const rec = signal();
  await store.writeSignal(rec);
  let clock = T0;
  const now = () => clock;
  const g = new SignalGrader(store, rising(now), {}, now);
  g.register(rec);

  clock = due('M15');
  stack.psql('revoke insert on public.signal_outcomes from service_role;');
  try {
    assert.equal(await g.tick(), 0);
    assert.equal(g.getStats().writeFailures, 1);
    assert.equal((await store.listOutcomes(rec.signalKey)).length, 0);
  } finally {
    stack.psql('grant insert on public.signal_outcomes to service_role;');
  }

  clock += MIN;
  assert.equal(await g.tick(), 1, 'the retained checkpoint is written once the store accepts it');
  const [o] = await store.listOutcomes(rec.signalKey);
  assert.equal(o!.horizon, 'M15');
  assert.equal(o!.label, 'POSITIVE');
});

test('recovery finds a pending signal behind a full day of graded history', async () => {
  // The case `listUngraded`'s window and chunking exist for, end to end: 600
  // fully graded signals in the recovery window ahead of one still pending.
  const store = new SupabaseSignalStore(db);
  const iso = (ms: number) => new Date(ms).toISOString();
  const graded = Array.from({ length: 600 }, (_, i) => signal({
    signalKey: i.toString(16).padStart(64, '0'), contentHash: i.toString(16).padStart(64, '0'),
    decisionAt: T0 + i * SEC, lastEventAt: T0 + i * SEC - 500, firstEventAt: T0 + i * SEC - 1_000,
  }));
  for (const r of graded) await store.writeSignal(r);
  const rows = graded.flatMap((r) => (['M15', 'H1', 'D1'] as const).map((h) => {
    const d = r.decisionAt + HORIZON_NOMINAL_MS[h];
    return `('${r.signalKey}','${h}','FLAT',0,'${iso(d)}','${iso(d + MIN)}')`;
  }));
  stack.psql(
    'insert into public.signal_outcomes (signal_key, horizon, label, directional_return_at_horizon, due_at, evaluated_at) '
    + `values ${rows.join(',')};`,
  );
  const pending = signal({ decisionAt: T0 + 700 * SEC, lastEventAt: T0 + 700 * SEC - 500, firstEventAt: T0 + 700 * SEC - 1_000 });
  await store.writeSignal(pending);

  const clock = T0 + 10 * MIN;
  const g = new SignalGrader(store, rising(() => clock), {}, () => clock);
  const report = await g.recover(500, RIGHTS);
  assert.equal(report.failed, 0);
  assert.equal(report.resumed, 1);
  assert.equal(g.getStats().tracked, 1);
});
