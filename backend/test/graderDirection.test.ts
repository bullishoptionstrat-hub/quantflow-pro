/**
 * A multi-leg signal is graded from the leg it is about, and a structure with
 * no direction is not graded as though it had one. (INV-010)
 *
 * The engine stores legs in the order their contract+side groups were first
 * seen, so `legs[0]` is whichever leg printed first. The production grader
 * read `legs[0]`.
 *
 * `dominantLegOf()` was written for exactly this defect — the entry in
 * CLAUDE.md about grading the wrong leg — but it lives in the flow-engine
 * module, and nothing in `src/` imports that module's tracker. So the fix
 * landed in the deprecated standalone tracker while the production path kept
 * the bug. This suite is the production path's version.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemorySignalStore } from '../src/persistence/memoryStore';
import {
  SignalGrader, dominantStoredLeg, undirectedStructure, type Mark,
} from '../src/persistence/grader';
import { dominantLegOf } from '../src/flow-engine/outcome/types';
import type { ClassifiedSignal } from '../src/flow-engine/types';
import type { SignalRecord, StoredLeg } from '../src/persistence/types';

const T0 = Date.UTC(2026, 8, 18, 14, 30, 0);

function leg(over: Partial<StoredLeg>): StoredLeg {
  return {
    contractSymbol: 'SPY261218C00560000', underlying: 'SPY', right: 'C',
    strike: 560, expiry: '2026-12-18', side: 'BUY', totalSize: 100,
    totalPremium: 1_000, vwap: 10, prints: 1, exchanges: ['CBOE'],
    ...over,
  };
}

/** The documented fixture: small put first, large call second. A strangle. */
function strangle(over: Partial<SignalRecord> = {}): SignalRecord {
  return {
    signalKey: 'k'.repeat(64), engineId: 'sig_1_1', underlying: 'SPY',
    kind: 'MULTI_LEG', side: 'BUY', score: 80,
    totalPremium: 104_200, totalSize: 600,
    firstEventAt: T0 - 1_000, lastEventAt: T0 - 500,
    receivedAt: T0, decisionAt: T0, decisionBasis: 'OBSERVED',
    source: 'tradier', datasetId: 'TRADIER_STREAM', rightsClass: 'PERMITTED',
    synthetic: false,
    legs: [
      leg({ right: 'P', strike: 540, side: 'BUY', totalPremium: 2_200, totalSize: 100 }),
      leg({ right: 'C', strike: 560, side: 'BUY', totalPremium: 102_000, totalSize: 500 }),
    ],
    printIds: ['p1', 'p2'],
    ...over,
  } as SignalRecord;
}

/** Underlying rises 2% — what the $102k call leg was positioned for. */
function risingMark(clock: () => number): () => Mark {
  return () => ({
    price: clock() < T0 + 60_000 ? 500 : 510,
    source: 'twelvedata', rightsClass: 'UNVERIFIED', asOf: clock() - 1_000,
  });
}

test('direction comes from the dominant leg, not the one that printed first', async () => {
  // Without a spreadGuess the structure is UNKNOWN, so it is still graded
  // directionally — this isolates the leg-selection defect from the
  // undirected-structure refusal below.
  const store = new InMemorySignalStore();
  const rec = strangle();
  await store.writeSignal(rec);

  let clock = T0;
  const g = new SignalGrader(store, risingMark(() => clock), {}, () => clock);
  g.register(rec);
  clock = T0 + 15 * 60_000 + 5_000;
  await g.tick();

  const [o] = await store.listOutcomes(rec.signalKey);
  assert.equal(o!.label, 'POSITIVE',
    'a rise is a hit for the $102k call; reading legs[0] graded this NEGATIVE ' +
    'because the $2.2k put printed five milliseconds earlier');
  assert.ok(o!.excursion! > 0);
});

test('a straddle or strangle is not graded directionally at all', async () => {
  const store = new InMemorySignalStore();
  const rec = strangle({ spreadGuess: 'STRADDLE_STRANGLE' });
  await store.writeSignal(rec);

  let clock = T0;
  const g = new SignalGrader(store, risingMark(() => clock), {}, () => clock);
  g.register(rec);
  clock = T0 + 15 * 60_000 + 5_000;
  await g.tick();

  const [o] = await store.listOutcomes(rec.signalKey);
  assert.equal(o!.label, 'UNGRADED',
    'two long wings is a position on movement, not on direction');
  assert.equal(o!.excursion, undefined, 'and no directional excursion is computed');
  assert.match(o!.ungradedReason!, /no direction/i);
  assert.match(o!.ungradedReason!, /STRADDLE_STRANGLE/);
});

test('a risk reversal IS directional and is still graded', async () => {
  // Long one wing, short the other: a directional bet financed by the other
  // side. Refusing it would throw away real directional evidence.
  const store = new InMemorySignalStore();
  const rec = strangle({
    spreadGuess: 'RISK_REVERSAL',
    legs: [
      leg({ right: 'P', strike: 540, side: 'SELL', totalPremium: 2_200 }),
      leg({ right: 'C', strike: 560, side: 'BUY', totalPremium: 102_000 }),
    ],
  });
  await store.writeSignal(rec);

  let clock = T0;
  const g = new SignalGrader(store, risingMark(() => clock), {}, () => clock);
  g.register(rec);
  clock = T0 + 15 * 60_000 + 5_000;
  await g.tick();

  const [o] = await store.listOutcomes(rec.signalKey);
  assert.equal(o!.label, 'POSITIVE', 'a long call risk reversal is bullish');
});

test('an unclassified structure is not silently refused', () => {
  // Refusing everything the classifier could not name would empty the track
  // record over a coverage gap rather than a finding.
  assert.equal(undirectedStructure({ spreadGuess: 'UNKNOWN' }), false);
  assert.equal(undirectedStructure({}), false);
  assert.equal(undirectedStructure({ spreadGuess: 'VERTICAL' }), false);
  assert.equal(undirectedStructure({ spreadGuess: 'STRADDLE_STRANGLE' }), true);
});

test('the persisted-leg rule agrees with the engine module it mirrors', () => {
  // Two implementations of one rule is how this drifted in the first place:
  // the module got the fix, the production path did not. They are held to the
  // same answer, the way vendorMirror.test.ts holds the vendored engine to its
  // source.
  const legs = [
    leg({ right: 'P', totalPremium: 2_200 }),
    leg({ right: 'C', totalPremium: 102_000 }),
    leg({ right: 'C', totalPremium: 50_000 }),
  ];
  const mine = dominantStoredLeg(legs);
  const theirs = dominantLegOf({
    legs: legs.map((l) => ({ ...l, contract: { right: l.right } })),
  } as unknown as ClassifiedSignal);
  assert.equal(mine!.totalPremium, 102_000);
  assert.equal(mine!.totalPremium, theirs!.totalPremium);

  // Ties keep the earlier leg in both, and an empty list is undefined in both.
  assert.equal(dominantStoredLeg([]), undefined);
  const tied = [leg({ strike: 1, totalPremium: 5 }), leg({ strike: 2, totalPremium: 5 })];
  assert.equal(dominantStoredLeg(tied)!.strike, 1);
});

test('a single-leg signal is unaffected', async () => {
  // Which is why the defect survived: it is only wrong on the structures whose
  // direction is hardest to read by eye.
  const store = new InMemorySignalStore();
  const rec = strangle({ legs: [leg({ right: 'C', side: 'BUY', totalPremium: 9_000 })] });
  await store.writeSignal(rec);

  let clock = T0;
  const g = new SignalGrader(store, risingMark(() => clock), {}, () => clock);
  g.register(rec);
  clock = T0 + 15 * 60_000 + 5_000;
  await g.tick();
  assert.equal((await store.listOutcomes(rec.signalKey))[0]!.label, 'POSITIVE');
});
