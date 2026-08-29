import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DecisionTimeError,
  computeDecisionAt,
  isForwardObservation,
  reconcileWrite,
  signalContentHash,
} from '../src/persistence/identity';
import type { ClassifiedSignal, SignalLeg } from '../src/flow-engine/types';

const T0 = Date.parse('2026-08-29T14:30:00.000Z');

function leg(over: Partial<SignalLeg> = {}): SignalLeg {
  return {
    contract: {
      symbol: 'SPY260919C00550000',
      underlying: 'SPY',
      right: 'C',
      strike: 550,
      expiry: '2026-09-19',
    },
    side: 'BUY',
    totalSize: 100,
    totalPremium: 250_000,
    vwap: 25,
    prints: 3,
    exchanges: ['CBOE', 'PHLX'],
    ...over,
  };
}

function sig(over: Partial<ClassifiedSignal> = {}): ClassifiedSignal {
  return {
    id: 'sig_1_x',
    kind: 'SWEEP',
    ts: T0,
    lastTs: T0 + 500,
    receivedAt: T0 + 520,
    emittedAt: T0 + 530,
    underlying: 'SPY',
    side: 'BUY',
    legs: [leg()],
    totalPremium: 250_000,
    totalSize: 100,
    iso: true,
    score: 82,
    scoreBreakdown: { premium: 30, iso: 10 },
    printIds: ['p1', 'p2', 'p3'],
    synthetic: false,
    ...over,
  };
}

// ─── Decision time ──────────────────────────────────────────────────────────

test('decisionAt is the max of last event, receipt and emission — not the first print', () => {
  const t = computeDecisionAt(sig());
  assert.equal(t.decisionAt, T0 + 530);
  assert.equal(t.basis, 'OBSERVED');
  assert.equal(t.firstEventAt, T0);
  assert.equal(t.lastEventAt, T0 + 500);
  assert.equal(t.latencyMs, 30);
});

test('the mandate case: a 500ms burst is not actionable at its first tick', () => {
  // The whole reason this function exists. Measuring from `ts` would credit
  // the backtest with 530ms of information it did not have.
  const t = computeDecisionAt(sig());
  assert.ok(t.decisionAt > t.firstEventAt);
  assert.equal(t.decisionAt - t.firstEventAt, 530);
});

test('a missing receipt clock yields EVENT_TIME_ONLY, not a silent wall-clock substitute', () => {
  const t = computeDecisionAt(sig({ receivedAt: undefined }));
  assert.equal(t.basis, 'EVENT_TIME_ONLY');
  assert.equal(t.decisionAt, T0 + 500, 'falls back to last event time');
  assert.equal(t.latencyMs, 0);
});

test('an inverted timeline throws rather than being clamped', () => {
  // A clamped timestamp is indistinguishable from a correct one once stored.
  assert.throws(
    () => computeDecisionAt(sig({ ts: T0 + 900, lastTs: T0 })),
    DecisionTimeError,
  );
});

test('a non-finite event time is refused', () => {
  assert.throws(() => computeDecisionAt(sig({ lastTs: NaN })), DecisionTimeError);
});

test('the invariant decisionAt >= lastEventAt >= firstEventAt holds on every branch', () => {
  for (const s of [sig(), sig({ receivedAt: undefined }), sig({ emittedAt: T0 })]) {
    const t = computeDecisionAt(s);
    assert.ok(t.decisionAt >= t.lastEventAt, 'decisionAt >= lastEventAt');
    assert.ok(t.lastEventAt >= t.firstEventAt, 'lastEventAt >= firstEventAt');
  }
});

test('an observation exactly at the decision instant is not forward of it', () => {
  // Strict `>`. This is where a one-tick lookahead would enter.
  assert.equal(isForwardObservation(T0, T0), false);
  assert.equal(isForwardObservation(T0, T0 + 1), true);
  assert.equal(isForwardObservation(T0, T0 - 1), false);
});

// ─── Content identity ───────────────────────────────────────────────────────

test('the same signal hashes identically regardless of leg or venue ordering', () => {
  const a = sig({ legs: [leg({ contract: { ...leg().contract, symbol: 'A' } }), leg({ contract: { ...leg().contract, symbol: 'B' } })] });
  const b = sig({ legs: [leg({ contract: { ...leg().contract, symbol: 'B' } }), leg({ contract: { ...leg().contract, symbol: 'A' } })] });
  assert.equal(signalContentHash(a), signalContentHash(b));

  const v1 = sig({ legs: [leg({ exchanges: ['CBOE', 'PHLX'] })] });
  const v2 = sig({ legs: [leg({ exchanges: ['PHLX', 'CBOE'] })] });
  assert.equal(signalContentHash(v1), signalContentHash(v2));
});

test('identity ignores the engine id, emission clock and score', () => {
  // The engine's sequence id restarts at 1 on every boot; a rescoring must not
  // mint a new signal.
  const base = signalContentHash(sig());
  assert.equal(signalContentHash(sig({ id: 'sig_999_z' })), base);
  assert.equal(signalContentHash(sig({ emittedAt: T0 + 99_999 })), base);
  assert.equal(signalContentHash(sig({ score: 1, scoreBreakdown: {} })), base);
  assert.equal(signalContentHash(sig({ printIds: ['zzz'] })), base);
});

test('identity changes when the economics change', () => {
  const base = signalContentHash(sig());
  const variants: Array<[string, ClassifiedSignal]> = [
    ['premium', sig({ legs: [leg({ totalPremium: 250_001 })] })],
    ['size', sig({ legs: [leg({ totalSize: 101 })] })],
    ['side', sig({ side: 'SELL', legs: [leg({ side: 'SELL' })] })],
    ['strike', sig({ legs: [leg({ contract: { ...leg().contract, strike: 551 } })] })],
    ['expiry', sig({ legs: [leg({ contract: { ...leg().contract, expiry: '2026-09-26' } })] })],
    ['kind', sig({ kind: 'BLOCK' })],
    ['cluster end', sig({ lastTs: T0 + 501 })],
  ];
  for (const [label, v] of variants) {
    assert.notEqual(signalContentHash(v), base, `${label} must change identity`);
  }
});

test('float noise below the fixed precision does not fork identity', () => {
  const a = sig({ legs: [leg({ vwap: 25 })] });
  const b = sig({ legs: [leg({ vwap: 25.0000000001 })] });
  assert.equal(signalContentHash(a), signalContentHash(b));
});

test('negative zero and positive zero are the same value', () => {
  const a = sig({ legs: [leg({ vwap: 0 })] });
  const b = sig({ legs: [leg({ vwap: -0 })] });
  assert.equal(signalContentHash(a), signalContentHash(b));
});

test('the hash is a stable 64-char hex digest', () => {
  assert.match(signalContentHash(sig()), /^[0-9a-f]{64}$/);
});

// ─── Reconciliation ─────────────────────────────────────────────────────────

test('reconcileWrite distinguishes a replay from a rewrite of history', () => {
  const incoming = { signalKey: 'k', contentHash: 'h1' };
  assert.equal(reconcileWrite(undefined, incoming), 'INSERT');
  assert.equal(reconcileWrite({ signalKey: 'k', contentHash: 'h1' }, incoming), 'IDEMPOTENT_REPLAY');
  // The one that matters: treating this as idempotent silently accepts a
  // rewrite of recorded history.
  assert.equal(reconcileWrite({ signalKey: 'k', contentHash: 'h2' }, incoming), 'HISTORY_COLLISION');
});
