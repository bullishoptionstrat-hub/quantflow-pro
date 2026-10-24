/**
 * `SupabaseSignalStore` against a real PostgreSQL and a real PostgREST.
 * ROADMAP 1.1d.
 *
 * Every other test of this store hands it a stub shaped like a PostgREST
 * reply, and a stub agrees with whatever query the code builds. These do not:
 * the server parses the query, applies the constraints, triggers and RLS the
 * migrations declare, and serializes the answer the way production does.
 *
 * Most of them are **differential**: the same operations go to this store and
 * to `InMemorySignalStore`, and the two answers are compared. The memory store
 * is the reference implementation of the policy and the one most tests drive,
 * so wherever the two disagree, a passing suite has been describing a store
 * that does not run in production.
 *
 * Run with `npm run test:pg`. It needs PostgreSQL server binaries and a
 * PostgREST binary (see `tools/pgstack/stack.ts`), and it refuses rather than
 * skips when they are missing.
 */
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { startStack, type Stack } from '../tools/pgstack/stack';
import { SupabaseSignalStore } from '../src/persistence/supabaseStore';
import { InMemorySignalStore } from '../src/persistence/memoryStore';
import { GRADED_HORIZONS, HORIZON_NOMINAL_MS } from '../src/persistence/types';
import type {
  CollectionGap, OutcomeRecord, SignalRecord, SignalStore,
} from '../src/persistence/types';

let stack: Stack;
let db: SupabaseClient;
let anon: SupabaseClient;

const opts = { auth: { persistSession: false, autoRefreshToken: false } };

before(async () => {
  stack = await startStack();
  db = createClient(stack.url, stack.serviceKey, opts);
  anon = createClient(stack.url, stack.anonKey, opts);
});

after(async () => { await stack?.stop(); });

beforeEach(() => {
  stack.psql(
    'truncate public.signal_outcomes, public.signal_write_incidents, '
    + 'public.collection_gaps, public.signal_history restart identity cascade;',
  );
});

const T0 = Date.parse('2026-08-29T14:30:00.000Z');
const MIN = 60_000;

/** A 64-hex key, the shape `identity.ts` produces, so URL lengths are honest. */
const keyOf = (i: number) => i.toString(16).padStart(64, '0');

function rec(i: number, over: Partial<SignalRecord> = {}): SignalRecord {
  const key = over.signalKey ?? keyOf(i);
  const at = over.decisionAt ?? T0 + i * MIN;
  return {
    signalKey: key,
    contentHash: key,
    engineId: `sig_${i}_x`,
    kind: 'SWEEP',
    underlying: 'SPY',
    side: 'BUY',
    // Fractional and large, so a `numeric` that came back as a string, or was
    // rounded through a float on the way in, is visible.
    totalPremium: 250_000.25,
    totalSize: 100,
    iso: true,
    score: 82.5,
    scoreBreakdown: { premium: 30, clamp: 0 },
    legs: [{
      contractSymbol: 'SPY260919C00550000',
      underlying: 'SPY', right: 'C', strike: 550, expiry: '2026-09-19',
      side: 'BUY', totalSize: 100, totalPremium: 250_000.25, vwap: 25.0025,
      prints: 3, exchanges: ['CBOE', 'ISE'],
    }],
    firstEventAt: at - 530,
    lastEventAt: at - 30,
    decisionAt: at,
    decisionBasis: 'OBSERVED',
    latencyMs: 30,
    source: 'tradier',
    datasetId: 'TRADIER_STREAM',
    rightsClass: 'PERMITTED',
    synthetic: false,
    recordedAt: at + 70,
    ...over,
  };
}

function outcome(sig: SignalRecord, horizon: OutcomeRecord['horizon'], over: Partial<OutcomeRecord> = {}): OutcomeRecord {
  const due = sig.decisionAt + (HORIZON_NOMINAL_MS as Record<string, number>)[horizon]!;
  return {
    signalKey: sig.signalKey,
    horizon,
    label: 'POSITIVE',
    directionalReturnAtHorizon: 0.0041,
    entryMark: 550.12,
    exitMark: 552.38,
    entryMarkSource: 'twelvedata',
    exitMarkSource: 'twelvedata',
    entryMarkAt: sig.decisionAt - 5_000,
    exitMarkAt: due + 2_000,
    dueAt: due,
    evaluatedAt: due + 60_000,
    revision: 1,
    ...over,
  };
}

const both = () => ({ pg: new SupabaseSignalStore(db), mem: new InMemorySignalStore() });

async function apply(stores: SignalStore[], f: (s: SignalStore) => Promise<unknown>) {
  for (const s of stores) await f(s);
}

/**
 * Drops keys whose value is `undefined`. The memory store keeps the object it
 * was handed and the Supabase store builds one from a row, so an absent
 * optional field is "missing" in one and "present, undefined" in the other —
 * the same value, which `deepStrictEqual` would otherwise report as a
 * difference and drown the real ones.
 */
const defined = <T extends object>(o: T): T =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

/** `generatedAt` is a wall clock and legitimately differs; nothing else may. */
const comparable = <T extends { generatedAt?: string }>(r: T) => ({ ...r, generatedAt: '' });

// ─── The setup itself ──────────────────────────────────────────────────────

test('the documented setup — schema.sql, then every migration in order — creates the four tables the store addresses', () => {
  const tables = stack.psql(
    "select string_agg(tablename, ',' order by tablename) from pg_tables "
    + "where schemaname = 'public' and tablename in "
    + "('signal_history','signal_outcomes','signal_write_incidents','collection_gaps')",
  ).trim();
  assert.equal(tables, 'collection_gaps,signal_history,signal_outcomes,signal_write_incidents');
});

// ─── RLS: the designed refusal, measured rather than assumed ──────────────

test('anon holds the table grant and still reads nothing: RLS denies, not a missing privilege', async () => {
  await new SupabaseSignalStore(db).writeSignal(rec(1));
  // The premise first. Without the grant, an empty answer would mean nothing.
  assert.equal(stack.psql("select has_table_privilege('anon', 'public.signal_history', 'SELECT')").trim(), 't');
  const { data, error } = await anon.from('signal_history').select('*');
  assert.equal(error, null);
  assert.deepEqual(data, []);
  const ins = await anon.from('signal_history').insert({ signal_key: 'x' });
  assert.equal(ins.error?.code, '42501', 'anon insert must be refused by RLS');
});

test('a store built on the anon key does not report an empty history — it throws when asked to write', async () => {
  const store = new SupabaseSignalStore(anon);
  await assert.rejects(store.writeSignal(rec(1)), /signal_history insert failed/);
});

// ─── Signals ────────────────────────────────────────────────────────────────

test('a signal round-trips exactly: numerics, jsonb, timestamps', async () => {
  const { pg } = both();
  const r = rec(1, { spreadGuess: 'RISK_REVERSAL' });
  assert.equal((await pg.writeSignal(r)).verdict, 'INSERT');
  assert.deepEqual(await pg.getSignal(r.signalKey), r);
});

test('write reconciliation agrees with the memory store: insert, replay, collision', async () => {
  const { pg, mem } = both();
  const a = rec(1);
  const b = { ...rec(1), contentHash: 'different', totalPremium: 999_999 };
  for (const s of [pg, mem]) {
    assert.equal((await s.writeSignal(a)).verdict, 'INSERT');
    assert.equal((await s.writeSignal(a)).verdict, 'IDEMPOTENT_REPLAY');
    assert.equal((await s.writeSignal(b)).verdict, 'HISTORY_COLLISION');
    assert.deepEqual(defined((await s.getSignal(a.signalKey))!), defined(a), `${s.kind}: the stored row is kept`);
  }
  const [pi] = await pg.listIncidents(10);
  const [mi] = await mem.listIncidents(10);
  assert.deepEqual({ ...pi, detectedAt: 0 }, { ...mi, detectedAt: 0 });
});

test('the timeline CHECK refuses a decision before the last event, even past the application', async () => {
  const pg = new SupabaseSignalStore(db);
  const bad = rec(1);
  bad.decisionAt = bad.lastEventAt - 1;
  await assert.rejects(pg.writeSignal(bad), /signal_history_timeline_ordered/);
});

test('countSignals agrees with the memory store, from a real Content-Range', async () => {
  const { pg, mem } = both();
  const sigs = [rec(1), rec(2), rec(3, { synthetic: true }), rec(4, { synthetic: true }), rec(5)];
  await apply([pg, mem], async (s) => { for (const r of sigs) await s.writeSignal(r); });
  assert.deepEqual(await pg.countSignals(), await mem.countSignals());
  assert.deepEqual(await pg.countSignals(), { total: 5, synthetic: 2, real: 3 });
});

// ─── Outcomes ───────────────────────────────────────────────────────────────

test('an outcome round-trips exactly, numerics included', async () => {
  const { pg, mem } = both();
  const s = rec(1);
  const os = [
    outcome(s, 'M15'),
    outcome(s, 'H1', { label: 'UNGRADED', directionalReturnAtHorizon: undefined, entryMark: undefined,
      exitMark: undefined, entryMarkSource: undefined, exitMarkSource: undefined,
      entryMarkAt: undefined, exitMarkAt: undefined, ungradedReason: 'No usable entry mark at decision time.' }),
  ];
  await apply([pg, mem], async (st) => { await st.writeSignal(s); for (const o of os) await st.writeOutcome(o); });
  assert.deepEqual((await pg.listOutcomes(s.signalKey)).map(defined), (await mem.listOutcomes(s.signalKey)).map(defined));
});

test('a second live outcome for one horizon is refused by the database, not only by the application', async () => {
  const pg = new SupabaseSignalStore(db);
  const s = rec(1);
  await pg.writeSignal(s);
  await pg.writeOutcome(outcome(s, 'M15'));
  await assert.rejects(pg.writeOutcome(outcome(s, 'M15', { label: 'NEGATIVE' })), /signal_outcomes insert failed/);
});

test('a mark without its source, or marks out of order, are refused by the CHECKs', async () => {
  const pg = new SupabaseSignalStore(db);
  const s = rec(1);
  await pg.writeSignal(s);
  await assert.rejects(pg.writeOutcome(outcome(s, 'M15', { entryMarkSource: undefined })), /mark/);
  await assert.rejects(
    pg.writeOutcome(outcome(s, 'H1', { exitMarkAt: s.decisionAt - 10_000 })), /mark/,
  );
});

test('a graded outcome cannot be edited or deleted, whoever asks', () => {
  const pg = new SupabaseSignalStore(db);
  return (async () => {
    const s = rec(1);
    await pg.writeSignal(s);
    await pg.writeOutcome(outcome(s, 'M15'));
    assert.throws(() => stack.psql("update public.signal_outcomes set label = 'NEGATIVE'"), /immutable/);
    assert.throws(() => stack.psql('delete from public.signal_outcomes'), /immutable|append-only/);
  })();
});

/** Inserts `n` real, permitted, observed signals straight into the table. */
function seedSignals(n: number, kind: (i: number) => string = () => 'SWEEP'): SignalRecord[] {
  const sigs = Array.from({ length: n }, (_, i) => rec(i, { kind: kind(i) }));
  const iso = (ms: number) => new Date(ms).toISOString();
  const values = sigs.map((r) =>
    `('${r.signalKey}','${r.contentHash}','e','${r.kind}','SPY','BUY',1,1,false,1,'[]'::jsonb,`
    + `'${iso(r.firstEventAt)}','${iso(r.lastEventAt)}','${iso(r.decisionAt)}','OBSERVED',`
    + `'tradier','TRADIER_STREAM','PERMITTED',false)`);
  stack.psql(
    'insert into public.signal_history (signal_key, content_hash, engine_id, kind, underlying, side, '
    + 'total_premium, total_size, iso, score, legs, first_event_at, last_event_at, decision_at, '
    + `decision_basis, source, dataset_id, rights_class, synthetic) values ${values.join(',')};`,
  );
  return sigs;
}

/** Grades every signal at `horizon` with alternating labels, straight into the table. */
function seedOutcomes(sigs: SignalRecord[], horizon: 'M15' | 'H1' | 'D1'): void {
  const iso = (ms: number) => new Date(ms).toISOString();
  const values = sigs.map((r, i) => {
    const due = r.decisionAt + HORIZON_NOMINAL_MS[horizon];
    return `('${r.signalKey}','${horizon}','${i % 2 ? 'NEGATIVE' : 'POSITIVE'}',${i % 2 ? -0.002 : 0.003},`
      + `'${iso(due)}','${iso(due + 60_000)}')`;
  });
  stack.psql(
    'insert into public.signal_outcomes (signal_key, horizon, label, directional_return_at_horizon, '
    + `due_at, evaluated_at) values ${values.join(',')};`,
  );
}

// ─── listUngraded: the method recovery depends on ──────────────────────────

test('listUngraded returns the same set as the memory store, in a window, with graded history ahead of it', async () => {
  const { pg, mem } = both();
  const sigs: SignalRecord[] = [];
  for (let i = 0; i < 60; i++) sigs.push(rec(i));
  await apply([pg, mem], async (st) => {
    for (const r of sigs) await st.writeSignal(r);
    // The oldest forty are fully graded.
    for (const r of sigs.slice(0, 40)) {
      for (const h of GRADED_HORIZONS) await st.writeOutcome(outcome(r, h));
    }
    // One partially graded: still open.
    await st.writeOutcome(outcome(sigs[45]!, 'M15'));
  });
  const keys = async (s: SignalStore, limit: number, since?: number) =>
    (await s.listUngraded(limit, since)).map((r) => r.signalKey).sort();

  assert.deepEqual(await keys(pg, 100), await keys(mem, 100));
  assert.equal((await keys(pg, 100)).length, 20);
  const since = sigs[50]!.decisionAt;
  assert.deepEqual(await keys(pg, 100, since), await keys(mem, 100, since));
  assert.equal((await keys(pg, 100, since)).length, 10);
});

test('listUngraded answers at the production recovery limit, where the key list is two thousand hashes long', async () => {
  // `recover()` passes 500 and the store fetches `limit * 4` rows, then asks
  // which of them have outcomes. That question used to be one `in.(…)` filter
  // of 2,000 keys, which PostgREST answers with 400 Bad Request.
  const sigs = seedSignals(2000);
  // The oldest 1,800 fully graded, so the 200 still open sit at the far end
  // of the fetch — the case the scan's ordering exists for.
  for (const h of GRADED_HORIZONS) seedOutcomes(sigs.slice(0, 1800), h);
  const open = await new SupabaseSignalStore(db).listUngraded(500);
  assert.equal(open.length, 200);
  assert.deepEqual(open.map((r) => r.signalKey), sigs.slice(1800).map((r) => r.signalKey));
});

// ─── trackRecord ────────────────────────────────────────────────────────────

test('trackRecord agrees with the memory store over a sample large enough to publish', async () => {
  const { pg, mem } = both();
  const sigs: SignalRecord[] = [];
  for (let i = 0; i < 40; i++) {
    sigs.push(rec(i, { kind: i % 2 === 0 ? 'SWEEP' : 'BLOCK' }));
  }
  const labels = ['POSITIVE', 'NEGATIVE', 'FLAT'] as const;
  await apply([pg, mem], async (st) => {
    for (const r of sigs) await st.writeSignal(r);
    for (const [i, r] of sigs.entries()) {
      await st.writeOutcome(outcome(r, 'M15', {
        label: labels[i % 3]!, directionalReturnAtHorizon: (i - 20) / 10_000,
        exitMarkAt: r.decisionAt + HORIZON_NOMINAL_MS.M15 + i * 30_000,
      }));
    }
    // The exclusions: synthetic, event-time-only, rights-refused.
    await st.writeSignal(rec(100, { synthetic: true }));
    await st.writeSignal(rec(101, { decisionBasis: 'EVENT_TIME_ONLY' }));
    await st.writeSignal(rec(102, { rightsClass: 'UNVERIFIED' }));
  });
  assert.deepEqual(comparable(await pg.trackRecord()), comparable(await mem.trackRecord()));
});

test('trackRecord counts a signal that is both event-time-only and rights-refused once, as the memory store does', async () => {
  const { pg, mem } = both();
  await apply([pg, mem], async (st) => {
    await st.writeSignal(rec(1, { decisionBasis: 'EVENT_TIME_ONLY', rightsClass: 'UNVERIFIED' }));
  });
  assert.deepEqual((await pg.trackRecord()).excluded, (await mem.trackRecord()).excluded);
});

test('trackRecord answers over a research population past the old 500-key chunk', async () => {
  // 600 signals put a 500-key chunk on the URL, which the client cannot read
  // the response to. Rates must come out over all 600, not throw.
  const sigs = seedSignals(600, (i) => (i % 2 ? 'BLOCK' : 'SWEEP'));
  seedOutcomes(sigs, 'M15');
  const report = await new SupabaseSignalStore(db).trackRecord();
  const n = report.rows.reduce((s, r) => s + r.nGraded, 0);
  assert.equal(n, 600);
});

test('backtest answers over a selection past the old 500-key chunk', async () => {
  const sigs = seedSignals(600);
  seedOutcomes(sigs, 'M15');
  const report = await new SupabaseSignalStore(db).backtest({});
  assert.equal(report.matched, 600);
  assert.equal(report.rows.reduce((s, r) => s + r.nGraded, 0), 600);
});

test('a correction is refused by name, not by a unique violation', async () => {
  const pg = new SupabaseSignalStore(db);
  const s = rec(1);
  await pg.writeSignal(s);
  await pg.writeOutcome(outcome(s, 'M15'));
  await assert.rejects(
    pg.writeOutcome(outcome(s, 'M15', { label: 'NEGATIVE', revision: 2, supersedes: `${s.signalKey}:1` })),
    /does not implement supersession/,
  );
});

// ─── backtest ───────────────────────────────────────────────────────────────

test('backtest agrees with the memory store, with the numeric bounds evaluated by Postgres', async () => {
  const { pg, mem } = both();
  const sigs: SignalRecord[] = [];
  for (let i = 0; i < 12; i++) {
    sigs.push(rec(i, { totalPremium: 100_000 + i * 50_000.5, score: 60 + i * 2.5, underlying: i % 3 ? 'SPY' : 'qqq' }));
  }
  await apply([pg, mem], async (st) => {
    for (const r of sigs) await st.writeSignal(r);
    for (const r of sigs) await st.writeOutcome(outcome(r, 'M15'));
  });
  for (const filter of [
    {}, { minPremium: 300_000.5 }, { minScore: 70 }, { underlyings: ['QQQ'] },
    { from: sigs[3]!.decisionAt, to: sigs[8]!.decisionAt }, { isoOnly: true },
  ]) {
    assert.deepEqual(comparable(await pg.backtest(filter)), comparable(await mem.backtest(filter)),
      `filter ${JSON.stringify(filter)}`);
  }
});

// ─── Gaps ───────────────────────────────────────────────────────────────────

test('recordGap extends one row under a stable id in both stores, and listGaps agrees', async () => {
  const { pg, mem } = both();
  const g: CollectionGap = {
    id: 'gap-1', kind: 'NOT_OBSERVED', startedAt: T0, endedAt: T0 + MIN,
    reason: 'No recordable source was connected for this window.',
  };
  await apply([pg, mem], async (st) => {
    await st.recordGap(g);
    await st.recordGap({ ...g, endedAt: T0 + 5 * MIN });
  });
  assert.deepEqual((await pg.listGaps(T0)).map(defined), (await mem.listGaps(T0)).map(defined));
  assert.equal((await pg.listGaps(T0)).length, 1);
});
