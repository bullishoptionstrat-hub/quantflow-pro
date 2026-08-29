import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemorySignalStore } from '../src/persistence/memoryStore';
import { MIN_PUBLISHABLE_SAMPLE } from '../src/persistence/types';
import type { OutcomeRecord, SignalRecord } from '../src/persistence/types';

const T0 = Date.parse('2026-08-29T14:30:00.000Z');

function rec(over: Partial<SignalRecord> = {}): SignalRecord {
  const key = over.signalKey ?? 'key-1';
  return {
    signalKey: key,
    contentHash: over.contentHash ?? key,
    engineId: 'sig_1_x',
    kind: 'SWEEP',
    underlying: 'SPY',
    side: 'BUY',
    totalPremium: 250_000,
    totalSize: 100,
    iso: true,
    score: 82,
    scoreBreakdown: {},
    legs: [{
      contractSymbol: 'SPY260919C00550000',
      underlying: 'SPY', right: 'C', strike: 550, expiry: '2026-09-19',
      side: 'BUY', totalSize: 100, totalPremium: 250_000, vwap: 25,
      prints: 3, exchanges: ['CBOE'],
    }],
    firstEventAt: T0,
    lastEventAt: T0 + 500,
    decisionAt: T0 + 530,
    decisionBasis: 'OBSERVED',
    latencyMs: 30,
    source: 'tradier',
    datasetId: 'TRADIER_STREAM',
    rightsClass: 'PERMITTED',
    synthetic: false,
    recordedAt: T0 + 600,
    ...over,
  };
}

function outcome(over: Partial<OutcomeRecord> = {}): OutcomeRecord {
  return {
    signalKey: 'key-1',
    horizon: 'M15',
    label: 'POSITIVE',
    excursion: 0.004,
    dueAt: T0 + 900_000,
    evaluatedAt: T0 + 900_100,
    revision: 1,
    ...over,
  };
}

// ─── Write reconciliation ───────────────────────────────────────────────────

test('an identical re-write is an idempotent replay, not a duplicate row', async () => {
  const s = new InMemorySignalStore();
  assert.equal((await s.writeSignal(rec())).verdict, 'INSERT');
  assert.equal((await s.writeSignal(rec())).verdict, 'IDEMPOTENT_REPLAY');
  assert.equal((await s.countSignals()).total, 1);
});

test('a differing write on an existing key is refused and recorded as an incident', async () => {
  const s = new InMemorySignalStore();
  await s.writeSignal(rec({ signalKey: 'k', contentHash: 'h1', totalPremium: 250_000 }));
  const res = await s.writeSignal(rec({ signalKey: 'k', contentHash: 'h2', totalPremium: 999_999 }));

  assert.equal(res.verdict, 'HISTORY_COLLISION');

  // The original stands — history is not rewritten.
  const stored = await s.getSignal('k');
  assert.equal(stored!.totalPremium, 250_000);
  assert.equal(stored!.contentHash, 'h1');

  const incidents = await s.listIncidents(10);
  assert.equal(incidents.length, 1);
  assert.equal(incidents[0]!.incidentType, 'HISTORY_COLLISION');
  assert.equal(incidents[0]!.existingContentHash, 'h1');
  assert.equal(incidents[0]!.incomingContentHash, 'h2');
});

// ─── Outcome append-only ────────────────────────────────────────────────────

test('an UNGRADED outcome with no reason is refused', async () => {
  const s = new InMemorySignalStore();
  await s.writeSignal(rec());
  await assert.rejects(
    () => s.writeOutcome(outcome({ label: 'UNGRADED', ungradedReason: undefined })),
    /cannot be distinguished from a grading bug/,
  );
  await assert.rejects(
    () => s.writeOutcome(outcome({ label: 'UNGRADED', ungradedReason: '   ' })),
    /cannot be distinguished/,
  );
});

test('a graded outcome cannot be silently overwritten', async () => {
  const s = new InMemorySignalStore();
  await s.writeSignal(rec());
  await s.writeOutcome(outcome({ label: 'POSITIVE' }));

  await assert.rejects(
    () => s.writeOutcome(outcome({ label: 'NEGATIVE' })),
    /immutable/,
    'flipping a graded label in place must be refused',
  );
});

test('supersession preserves both revisions', async () => {
  const s = new InMemorySignalStore();
  await s.writeSignal(rec());
  await s.writeOutcome(outcome({ label: 'POSITIVE', excursion: 0.004, revision: 1 }));
  await s.writeOutcome(outcome({
    label: 'NEGATIVE', excursion: -0.002, revision: 2,
    supersedes: 'key-1:1',
  }));

  const hist = await s.listOutcomes('key-1');
  assert.equal(hist.length, 2, 'the corrected revision does not erase the original');
  assert.equal(hist[0]!.label, 'POSITIVE');
  assert.equal(hist[1]!.label, 'NEGATIVE');
  assert.equal(hist[1]!.supersedes, 'key-1:1');
});

// ─── Gaps ───────────────────────────────────────────────────────────────────

test('an inverted or trivially-justified gap is refused', async () => {
  const s = new InMemorySignalStore();
  await assert.rejects(
    () => s.recordGap({ id: 'g1', kind: 'NOT_OBSERVED', startedAt: T0 + 100, endedAt: T0, reason: 'process was restarted for a deploy' }),
    /ends .* before it starts/,
  );
  await assert.rejects(
    () => s.recordGap({ id: 'g2', kind: 'NOT_OBSERVED', startedAt: T0, endedAt: T0 + 100, reason: 'oops' }),
    /too thin to be useful/,
  );
});

test('gaps are retrievable by window', async () => {
  const s = new InMemorySignalStore();
  await s.recordGap({
    id: 'g1', kind: 'NOT_OBSERVED', startedAt: T0, endedAt: T0 + 60_000,
    reason: 'render free tier spun the service down after 15 minutes idle',
  });
  assert.equal((await s.listGaps(T0)).length, 1);
  assert.equal((await s.listGaps(T0 + 120_000)).length, 0);
});

// ─── Track record honesty ───────────────────────────────────────────────────

async function seed(s: InMemorySignalStore, n: number, over: Partial<SignalRecord> = {}, label: OutcomeRecord['label'] = 'POSITIVE') {
  for (let i = 0; i < n; i++) {
    const key = `${over.signalKey ?? 'k'}-${i}`;
    await s.writeSignal(rec({ ...over, signalKey: key, contentHash: key }));
    await s.writeOutcome(outcome({
      signalKey: key, label,
      ...(label === 'UNGRADED' ? { ungradedReason: 'side was AMBIGUOUS so no direction was implied' } : {}),
    }));
  }
}

test('a rate below the minimum sample is suppressed, not rounded or shown as zero', async () => {
  const s = new InMemorySignalStore();
  await seed(s, MIN_PUBLISHABLE_SAMPLE - 1);
  const r = await s.trackRecord();

  assert.equal(r.rows.length, 1);
  const row = r.rows[0]!;
  assert.equal(row.suppressionReason, 'INSUFFICIENT_SAMPLE');
  assert.equal(row.hitRate, undefined, 'no rate is published below the threshold');
  assert.equal(row.nGraded, MIN_PUBLISHABLE_SAMPLE - 1, 'but the sample size is still shown');
});

test('at the threshold the rate is published', async () => {
  const s = new InMemorySignalStore();
  await seed(s, MIN_PUBLISHABLE_SAMPLE);
  const row = (await s.trackRecord()).rows[0]!;
  assert.equal(row.suppressionReason, undefined);
  assert.equal(row.hitRate, 1);
  assert.equal(row.medianExcursion, 0.004);
});

test('synthetic signals never enter a rate, and are counted where a reader can see them', async () => {
  const s = new InMemorySignalStore();
  await seed(s, MIN_PUBLISHABLE_SAMPLE, { signalKey: 'syn', synthetic: true });
  const r = await s.trackRecord();

  assert.equal(r.rows.length, 0, 'synthetic data produces no rows at all');
  assert.equal(r.excluded.synthetic, MIN_PUBLISHABLE_SAMPLE);
  assert.match(r.notes.join(' '), /carries no information about the market/);
});

test('EVENT_TIME_ONLY rows are excluded from rates and counted separately', async () => {
  const s = new InMemorySignalStore();
  await seed(s, MIN_PUBLISHABLE_SAMPLE, { signalKey: 'replay', decisionBasis: 'EVENT_TIME_ONLY' });
  const r = await s.trackRecord();

  assert.equal(r.rows.length, 0);
  assert.equal(r.excluded.eventTimeOnlyBasis, MIN_PUBLISHABLE_SAMPLE);
  assert.match(r.notes.join(' '), /credits zero feed latency/);
});

test('signals from a non-permitted source are excluded from rates and counted', async () => {
  const s = new InMemorySignalStore();
  await seed(s, MIN_PUBLISHABLE_SAMPLE, {
    signalKey: 'unv', rightsClass: 'UNVERIFIED', datasetId: 'CBOE_CDN_DELAYED_CHAIN',
  });
  const r = await s.trackRecord();

  assert.equal(r.rows.length, 0);
  assert.equal(r.excluded.rightsRefused, MIN_PUBLISHABLE_SAMPLE);
});

test('UNGRADED outcomes are reported, never quietly dropped from the denominator', async () => {
  const s = new InMemorySignalStore();
  await seed(s, 20, { signalKey: 'good' }, 'POSITIVE');
  await seed(s, 40, { signalKey: 'amb' }, 'UNGRADED');
  const row = (await s.trackRecord()).rows[0]!;

  assert.equal(row.nTotal, 60);
  assert.equal(row.nGraded, 20);
  assert.equal(row.nUngraded, 40);
  // 20 graded is under the threshold, so still suppressed — the 40 ungraded
  // do NOT get to pad the sample into publishability.
  assert.equal(row.suppressionReason, 'INSUFFICIENT_SAMPLE');
});

test('a mixed real ledger reports the true rate over graded rows only', async () => {
  const s = new InMemorySignalStore();
  await seed(s, 20, { signalKey: 'win' }, 'POSITIVE');
  await seed(s, 20, { signalKey: 'lose' }, 'NEGATIVE');
  const row = (await s.trackRecord()).rows[0]!;

  assert.equal(row.nGraded, 40);
  assert.equal(row.hitRate, 0.5);
});

test('an empty store says so plainly rather than returning a bare zero', async () => {
  const r = await new InMemorySignalStore().trackRecord();
  assert.equal(r.rows.length, 0);
  assert.match(r.notes.join(' '), /has completed a checkpoint yet|expected state/);
});

test('listUngraded skips synthetic signals', async () => {
  const s = new InMemorySignalStore();
  await s.writeSignal(rec({ signalKey: 'real' }));
  await s.writeSignal(rec({ signalKey: 'fake', synthetic: true }));
  const open = await s.listUngraded(10);
  assert.deepEqual(open.map((r) => r.signalKey), ['real']);
});
