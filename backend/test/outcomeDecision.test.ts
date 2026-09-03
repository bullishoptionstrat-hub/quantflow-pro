/**
 * The measurement origin has two homes, so it is a checked mirror.
 *
 * `backend/src/persistence/identity.ts` derives `decisionAt` for the
 * production recorder. `flow-engine/outcome/types.ts` derives the same origin
 * for the standalone module's `OutcomeTracker`, and it cannot import across
 * that boundary — the module ships on its own.
 *
 * That is one rule in two files, which is the shape this repo keeps closing
 * (`STALE_MS`, the flow filter predicate, the ticker tape's symbol list). It
 * cannot be collapsed here, so it is held to agreement instead: the two must
 * return the same instant and the same basis for every combination of clocks.
 *
 * The tracker used to measure from `signal.ts` — the FIRST print in the
 * cluster — which `CLAUDE.md` deprecates for any measurement: a signal
 * assembled from a 500ms burst was not actionable at that burst's first tick,
 * so the horizon is handed the burst duration plus the feed latency for free
 * and every excursion comes out flattering.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { computeDecisionAt } from '../src/persistence/identity';
import { decisionTimeOf } from '../src/flow-engine/outcome/types';
import type { ClassifiedSignal } from '../src/flow-engine/types';

const BASE: ClassifiedSignal = {
  id: 'sig_1_1000',
  kind: 'SWEEP',
  ts: 1_000,
  lastTs: 1_500,
  receivedAt: 1_700,
  emittedAt: 1_900,
  underlying: 'SPY',
  side: 'BUY',
  legs: [{
    contract: { symbol: 'SPY_C610', underlying: 'SPY', right: 'C', strike: 610, expiry: '2026-12-18' },
    side: 'BUY', totalSize: 100, totalPremium: 100_000, vwap: 10, prints: 1, exchanges: ['CBOE'],
  }],
  totalPremium: 100_000,
  totalSize: 100,
  iso: false,
  score: 70,
  scoreBreakdown: {},
  printIds: ['p1'],
} as ClassifiedSignal;

/** Every combination of the two clocks, plus an out-of-order receipt. */
const CASES: Array<[string, Partial<ClassifiedSignal>]> = [
  ['both clocks present', {}],
  ['no receipt clock', { receivedAt: undefined }],
  ['no emission clock', { emittedAt: undefined as unknown as number }],
  ['neither clock', { receivedAt: undefined, emittedAt: undefined as unknown as number }],
  ['receipt before the last print', { receivedAt: 1_200 }],
  ['emission before the last print', { emittedAt: 1_100 }],
  ['both before the last print', { receivedAt: 1_100, emittedAt: 1_200 }],
  ['a single-print signal', { ts: 1_500, lastTs: 1_500 }],
];

test('both homes of the decision rule agree on the instant and the basis', () => {
  for (const [name, patch] of CASES) {
    const sig = { ...BASE, ...patch } as ClassifiedSignal;
    const production = computeDecisionAt(sig);
    const module_ = decisionTimeOf(sig);

    assert.equal(module_.at, production.decisionAt, `${name}: different instant`);
    assert.equal(module_.basis, production.basis, `${name}: different basis`);
  }
});

test('the origin is never earlier than the last forming print', () => {
  // The invariant `decisionAt >= lastEventAt >= firstEventAt`, which
  // `identity.ts` throws on and which the module must not quietly violate.
  for (const [name, patch] of CASES) {
    const sig = { ...BASE, ...patch } as ClassifiedSignal;
    assert.ok(decisionTimeOf(sig).at >= sig.lastTs, `${name}: origin precedes lastTs`);
    assert.ok(decisionTimeOf(sig).at >= sig.ts, `${name}: origin precedes ts`);
  }
});

test('the tracker no longer measures from the first print', () => {
  const { readFileSync } = require('node:fs') as typeof import('node:fs');
  const { join } = require('node:path') as typeof import('node:path');
  const tracker = readFileSync(join(__dirname, '..', 'src', 'flow-engine', 'outcome', 'tracker.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');

  assert.ok(!/signal\.ts/.test(tracker), '`signal.ts` is the first print — deprecated for measurement');
  assert.match(tracker, /decisionTimeOf\(signal\)/, 'the origin comes from the shared rule');
  // Three call sites read `legs[0]`, which is not the leg `side` came from.
  assert.ok(!/legs\[0\]/.test(tracker), 'legs[0] is not the dominant leg');
  assert.match(tracker, /dominantLegOf/, 'and there is one helper for it');
});
