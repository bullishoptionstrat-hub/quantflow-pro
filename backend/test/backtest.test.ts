/**
 * Scanner backtest — a filter over graded history, not a second grader.
 *
 * Roadmap 4.1–4.3. The backtest's whole value is that it reuses the machinery
 * `/api/track-record` already trusts: the same sample gate, the same
 * exclusions, the same honesty notes. These tests hold three things:
 *
 *   1. the filter selects the population it claims to (and case/empty-set
 *      semantics are exactly as documented);
 *   2. every honesty flag the track record enforces is inherited here, and
 *      cannot be bypassed by narrowing to a filter;
 *   3. no label is computed in the backtest path — grading happened once, when
 *      the outcome was written, and this reads it back.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { InMemorySignalStore } from '../src/persistence/memoryStore';
import { matchesScanner, assembleBacktest, type MatchedSignal } from '../src/persistence/backtest';
import { MIN_PUBLISHABLE_SAMPLE } from '../src/persistence/types';
import type { OutcomeRecord, SignalRecord } from '../src/persistence/types';

const T0 = Date.parse('2026-09-01T14:30:00.000Z');

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
    directionalReturnAtHorizon: 0.004,
    dueAt: T0 + 900_000,
    evaluatedAt: T0 + 900_100,
    revision: 1,
    ...over,
  };
}

/** Seed `n` matched signals of a given shape, each with one graded outcome. */
async function seed(
  s: InMemorySignalStore,
  n: number,
  over: Partial<SignalRecord> = {},
  label: OutcomeRecord['label'] = 'POSITIVE',
) {
  for (let i = 0; i < n; i++) {
    const key = `${over.signalKey ?? 'k'}-${i}`;
    await s.writeSignal(rec({ ...over, signalKey: key, contentHash: key }));
    await s.writeOutcome(outcome({
      signalKey: key, label,
      ...(label === 'UNGRADED' ? { ungradedReason: 'side was AMBIGUOUS so no direction was implied' } : {}),
    }));
  }
}

// ─── matchesScanner: the selection predicate ────────────────────────────────

test('an empty filter matches every signal', () => {
  assert.equal(matchesScanner(rec(), {}), true);
});

test('string sets are case-insensitive membership', () => {
  assert.equal(matchesScanner(rec({ kind: 'SWEEP' }), { kinds: ['sweep'] }), true);
  assert.equal(matchesScanner(rec({ underlying: 'SPY' }), { underlyings: ['spy', 'qqq'] }), true);
  assert.equal(matchesScanner(rec({ kind: 'BLOCK' }), { kinds: ['SWEEP'] }), false);
});

test('an empty string set matches nothing, deliberately', () => {
  // Distinct from omitting the field. The route rejects this shape, but the
  // predicate honours it literally — a signal's kind is in no set.
  assert.equal(matchesScanner(rec(), { kinds: [] }), false);
});

test('numeric bounds are inclusive lower bounds', () => {
  assert.equal(matchesScanner(rec({ totalPremium: 250_000 }), { minPremium: 250_000 }), true);
  assert.equal(matchesScanner(rec({ totalPremium: 249_999 }), { minPremium: 250_000 }), false);
  assert.equal(matchesScanner(rec({ score: 82 }), { minScore: 90 }), false);
  assert.equal(matchesScanner(rec({ totalSize: 100 }), { minSize: 50 }), true);
});

test('isoOnly is one-way: true demands ISO, absent demands nothing', () => {
  assert.equal(matchesScanner(rec({ iso: false }), { isoOnly: true }), false);
  assert.equal(matchesScanner(rec({ iso: true }), { isoOnly: true }), true);
  assert.equal(matchesScanner(rec({ iso: false }), {}), true);
});

test('the time window filters on decisionAt, inclusive at both ends', () => {
  const d = T0 + 530;
  assert.equal(matchesScanner(rec({ decisionAt: d }), { from: d, to: d }), true);
  assert.equal(matchesScanner(rec({ decisionAt: d }), { from: d + 1 }), false);
  assert.equal(matchesScanner(rec({ decisionAt: d }), { to: d - 1 }), false);
});

test('all present constraints are a conjunction', () => {
  const sig = rec({ kind: 'SWEEP', underlying: 'SPY', totalPremium: 300_000, iso: true });
  assert.equal(
    matchesScanner(sig, { kinds: ['SWEEP'], underlyings: ['SPY'], minPremium: 250_000, isoOnly: true }),
    true,
  );
  // One failing conjunct fails the whole match.
  assert.equal(
    matchesScanner(sig, { kinds: ['SWEEP'], underlyings: ['QQQ'] }),
    false,
  );
});

// ─── backtest over the store: selection + inherited honesty ─────────────────

test('a backtest reports only the matched population', async () => {
  const s = new InMemorySignalStore();
  await seed(s, MIN_PUBLISHABLE_SAMPLE, { signalKey: 'spy', underlying: 'SPY', kind: 'SWEEP' });
  await seed(s, MIN_PUBLISHABLE_SAMPLE, { signalKey: 'qqq', underlying: 'QQQ', kind: 'SWEEP' });

  const r = await s.backtest({ underlyings: ['SPY'] });
  assert.equal(r.matched, MIN_PUBLISHABLE_SAMPLE, 'only SPY signals matched');
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0]!.kind, 'SWEEP');
  assert.equal(r.rows[0]!.hitRate, 1);
});

test('the sample-size floor is inherited: a thin filter suppresses its rate', async () => {
  const s = new InMemorySignalStore();
  await seed(s, MIN_PUBLISHABLE_SAMPLE - 1, { signalKey: 'thin' });
  const r = await s.backtest({});
  const row = r.rows[0]!;
  assert.equal(row.suppressionReason, 'INSUFFICIENT_SAMPLE');
  assert.equal(row.hitRate, undefined, 'no rate is published below n=30, filter or no filter');
  assert.equal(row.nGraded, MIN_PUBLISHABLE_SAMPLE - 1, 'but the sample is still shown');
});

test('synthetic signals cannot be smuggled into a rate by a filter', async () => {
  const s = new InMemorySignalStore();
  await seed(s, MIN_PUBLISHABLE_SAMPLE, { signalKey: 'syn', synthetic: true });
  const r = await s.backtest({});
  assert.equal(r.rows.length, 0, 'synthetic data produces no rows even when matched');
  assert.equal(r.excluded.synthetic, MIN_PUBLISHABLE_SAMPLE);
  assert.match(r.notes.join(' '), /carries no information about the market/);
});

test('EVENT_TIME_ONLY and rights-refused signals are excluded and counted, scoped to the filter', async () => {
  const s = new InMemorySignalStore();
  await seed(s, 10, { signalKey: 'replay', decisionBasis: 'EVENT_TIME_ONLY' });
  await seed(s, 7, { signalKey: 'unv', rightsClass: 'UNVERIFIED' });
  await seed(s, MIN_PUBLISHABLE_SAMPLE, { signalKey: 'good' });

  const r = await s.backtest({});
  assert.equal(r.excluded.eventTimeOnlyBasis, 10);
  assert.equal(r.excluded.rightsRefused, 7);
  // Only the 30 good ones reach a row.
  assert.equal(r.rows[0]!.nGraded, MIN_PUBLISHABLE_SAMPLE);
  assert.match(r.notes.join(' '), /credits zero feed latency/);
});

test('UNGRADED outcomes stay in the denominator and never pad the sample', async () => {
  const s = new InMemorySignalStore();
  await seed(s, 20, { signalKey: 'good' }, 'POSITIVE');
  await seed(s, 40, { signalKey: 'amb' }, 'UNGRADED');
  const row = (await s.backtest({})).rows[0]!;
  assert.equal(row.nTotal, 60);
  assert.equal(row.nGraded, 20);
  assert.equal(row.nUngraded, 40);
  assert.equal(row.suppressionReason, 'INSUFFICIENT_SAMPLE',
    'the 40 ungraded do not pad 20 graded into publishability');
});

test('a mixed matched ledger reports the true rate over graded rows only', async () => {
  const s = new InMemorySignalStore();
  await seed(s, 20, { signalKey: 'win' }, 'POSITIVE');
  await seed(s, 20, { signalKey: 'lose' }, 'NEGATIVE');
  const row = (await s.backtest({})).rows[0]!;
  assert.equal(row.nGraded, 40);
  assert.equal(row.hitRate, 0.5);
});

test('a filter matching nothing says so, about the filter, not a signal', async () => {
  const s = new InMemorySignalStore();
  await seed(s, MIN_PUBLISHABLE_SAMPLE, { signalKey: 'spy', underlying: 'SPY' });
  const r = await s.backtest({ underlyings: ['TSLA'] });
  assert.equal(r.matched, 0);
  assert.equal(r.rows.length, 0);
  assert.match(r.notes.join(' '), /No signal in the record matched this scanner filter/);
  assert.match(r.notes.join(' '), /statement about the filter/);
});

test('the report echoes the exact filter it applied', async () => {
  const s = new InMemorySignalStore();
  const filter = { kinds: ['SWEEP'], minPremium: 100_000, isoOnly: true };
  const r = await s.backtest(filter);
  assert.deepEqual(r.filter, filter, 'a backtest must not silently drop a constraint it applied');
});

// ─── No second grader ───────────────────────────────────────────────────────

test('the measured-interval disclosure carries into a backtest', async () => {
  // The same disclosure `/api/track-record` publishes: a row filed under M15
  // but measured over 32 minutes says so. If it fired for the track record and
  // not the backtest, the backtest would be the less honest of the two.
  const s = new InMemorySignalStore();
  const ENTRY = T0;
  const EXIT = T0 + 32 * 60_000;
  for (let i = 0; i < MIN_PUBLISHABLE_SAMPLE; i++) {
    const key = `slow-${i}`;
    await s.writeSignal(rec({ signalKey: key, contentHash: key }));
    await s.writeOutcome(outcome({
      signalKey: key, label: 'POSITIVE',
      entryMarkAt: ENTRY, exitMarkAt: EXIT,
    }));
  }
  const r = await s.backtest({});
  const note = r.notes.find((n) => /longer interval than the horizon/.test(n));
  assert.ok(note, 'the interval disclosure must travel with the shared tally');
  assert.match(note, /median 32min/);
});

test('assembleBacktest computes no label of its own', () => {
  // The guard against a second grader: the backtest module must reach its
  // POSITIVE/NEGATIVE/FLAT counts through the shared tally, never by inspecting
  // an excursion or a mark itself. If it grew its own labelling, this source
  // check catches it before the arithmetic ever diverges.
  const src = readFileSync(
    join(__dirname, '..', 'src', 'persistence', 'backtest.ts'), 'utf8');
  assert.match(src, /tallyOutcome\(/, 'it must count outcomes through the shared tally');
  assert.match(src, /tallyToRows\(/, 'and build rows through the shared module');
  assert.match(src, /reportNotes\(/, 'and take its notes from the shared module');
  assert.ok(!/flatBandPct|POSITIVE'|directionalReturnAtHorizon >|directionalReturnAtHorizon </.test(src),
    'a backtest must not re-derive a label — grading happened once, at write time');
  assert.ok(!/function median\(/.test(src), 'it must not keep its own median');
});

test('a backtest and an unfiltered track record agree on the same population', async () => {
  // The strongest statement of "no second grader": with a filter that matches
  // everything, the backtest's rows must equal the track record's rows exactly.
  // Two different numbers here would mean two grading paths had diverged.
  const s = new InMemorySignalStore();
  await seed(s, 20, { signalKey: 'win' }, 'POSITIVE');
  await seed(s, 20, { signalKey: 'lose' }, 'NEGATIVE');

  const tr = await s.trackRecord();
  const bt = await s.backtest({});
  assert.deepEqual(bt.rows, tr.rows, 'match-all backtest must equal the track record');
  assert.deepEqual(bt.excluded, tr.excluded);
});

// ─── assembleBacktest directly, for the empty and store-note paths ──────────

test('assembleBacktest surfaces a store-specific note', () => {
  const matched: MatchedSignal[] = [{
    signal: { kind: 'SWEEP', synthetic: false, decisionBasis: 'OBSERVED', rightsClass: 'PERMITTED' },
    outcomes: [{ horizon: 'M15', label: 'POSITIVE', directionalReturnAtHorizon: 0.01 }],
  }];
  const note = 'a store-specific eviction warning';
  const r = assembleBacktest({}, matched, [note]);
  assert.ok(r.notes.includes(note), 'the store channel must reach the reader');
});
