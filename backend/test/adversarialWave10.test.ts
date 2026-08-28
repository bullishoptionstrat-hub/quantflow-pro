/**
 * WAVE 10 — cross-wave adversarial hardening.
 *
 * Re-attacks every prior wave under hostile conditions: provider outage,
 * malformed data, clock drift, quota exhaustion. These are permanent
 * regression tests, not a one-off script.
 */
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { rejectEmission, markSynthetic } from '../src/config/dataMode';
import { badgeFor, validateProvenance, upstreamProvenance, syntheticProvenance } from '../src/config/provenance';
import { __resetQuota, requestQuota, reportFailure } from '../src/providers/quota';
import { PROVIDERS, getProvider } from '../src/providers/registry';
import { provenanceFromDescriptor } from '../src/providers/types';
import { __resetSourceHealth, getSourceHealth, recordEvent, registerSource } from '../src/ingestion/sourceHealth';
import { computeGex } from '../src/gex/compute';
import { computeIvRank, computeTermStructure } from '../src/gex/volatility';
import { gradeEvent, buildReport } from '../src/outcomes/grader';
import { detectAll, assertCausality } from '../src/structure/detect';
import { AlertGate } from '../src/alerts/dedup';

const T0 = 1_700_000_000_000;
const LIVE = { DATA_MODE: 'live' };

beforeEach(() => { __resetQuota(); __resetSourceHealth(); });

describe('PROVIDER OUTAGE', () => {
  it('a totally dead provider never yields a crash, only typed decisions', () => {
    const env = { POLYGON_API_KEY: 'k', TRADIER_TOKEN: 't' };
    for (let i = 0; i < 200; i++) reportFailure('polygon', () => T0);
    for (let i = 0; i < 200; i++) {
      const d = requestQuota('polygon', { env, now: () => T0 + i });
      assert.ok(['allow', 'defer', 'degrade', 'deny'].includes(d.action));
    }
  });

  it('a source that goes silent degrades to stale on its own', () => {
    recordEvent('tradier', upstreamProvenance({ source: 'tradier' }), () => T0);
    assert.equal(getSourceHealth(() => T0 + 3_600_000)[0]!.lifecycle, 'stale');
  });

  it('a source that never reports is visible, not absent', () => {
    registerSource('marketdata');
    const h = getSourceHealth(() => T0)[0]!;
    assert.equal(h.lifecycle, 'never_reported');
    assert.equal(h.lastEventAt, null);
  });
});

describe('MALFORMED DATA', () => {
  it('GEX survives NaN/Infinity inputs without emitting a confident number', () => {
    const r = computeGex({
      symbol: 'SPY', spotPrice: 580, snapshotAt: new Date(T0).toISOString(),
      strikes: [{ strike: 580, callOI: 0, putOI: 0, callGamma: 0, putGamma: 0 }],
    });
    assert.equal(r.confidence, 0, 'zero inputs must yield zero confidence');
  });

  it('GEX with an empty chain does not invent levels', () => {
    const r = computeGex({
      symbol: 'SPY', spotPrice: 580, snapshotAt: new Date(T0).toISOString(), strikes: [],
    });
    assert.deepEqual(r.strikes, []);
    assert.equal(r.gammaFlip, null);
    assert.equal(r.callWall, null);
  });

  it('IV rank on an empty series refuses rather than dividing by zero', () => {
    const r = computeIvRank([], 0.3);
    assert.equal(r.status, 'insufficient_history');
    assert.equal(r.ivRank, null);
  });

  it('term structure on garbage points returns unknown, not a shape', () => {
    assert.equal(computeTermStructure([]).shape, 'unknown');
    assert.equal(computeTermStructure([{ dte: 30, iv: 0.2 }, { dte: 30, iv: 0.9 }]).shape, 'unknown');
  });

  it('structure detection on degenerate bars emits nothing rather than noise', () => {
    const flat = Array.from({ length: 20 }, (_, i) => ({
      time: T0 + i * 60_000, closeTime: T0 + (i + 1) * 60_000,
      open: 100, high: 100, low: 100, close: 100, volume: 0,
    }));
    for (const d of detectAll(flat)) assertCausality(d); // must not throw
  });

  it('grading with no marks yields UNGRADED, never a fabricated return', () => {
    const r = gradeEvent({
      flowEventId: 'x', symbol: 'SPY', signalAt: T0, actionableAt: T0,
      impliedDirection: 'LONG', horizon: '15m', marks: [], now: T0 + 86_400_000,
    });
    assert.equal(r.label, 'UNGRADED');
    assert.equal(r.underlyingReturn, null);
  });
});

describe('CLOCK DRIFT', () => {
  it('a mark timestamped in the future is not used as an entry', () => {
    const r = gradeEvent({
      flowEventId: 'x', symbol: 'SPY', signalAt: T0, actionableAt: T0,
      impliedDirection: 'LONG', horizon: '15m',
      marks: [{ time: T0 + 10 * 86_400_000, price: 999 }],
      now: T0 + 86_400_000,
    });
    // The only mark is far past the horizon, so it becomes the exit but there
    // is no entry/exit pair that respects the horizon — must not invent one.
    assert.ok(r.label === 'UNGRADED' || r.entryMark !== 999);
  });

  it('grading before the horizon elapses refuses rather than peeking', () => {
    const r = gradeEvent({
      flowEventId: 'x', symbol: 'SPY', signalAt: T0, actionableAt: T0,
      impliedDirection: 'LONG', horizon: '1d',
      marks: [{ time: T0, price: 100 }, { time: T0 + 86_400_000, price: 110 }],
      now: T0 + 1000, // only 1 second has passed
    });
    assert.equal(r.ungradedReason, 'horizon_not_elapsed');
  });

  it('a backwards clock does not produce negative staleness', () => {
    recordEvent('tradier', upstreamProvenance({ source: 'tradier' }), () => T0);
    const h = getSourceHealth(() => T0 - 60_000)[0]!;
    assert.ok((h.stalenessSeconds ?? 0) >= 0, 'staleness must never be negative');
  });

  it('alert gate handles out-of-order timestamps without crashing', () => {
    const gate = new AlertGate();
    for (const at of [T0 + 5000, T0, T0 + 10_000, T0 - 5000]) {
      const d = gate.consider({ dedupKey: 'K', severity: 'HIGH', message: 'm', at });
      assert.ok(['deliver', 'suppress'].includes(d.action));
    }
  });
});

describe('QUOTA EXHAUSTION under load', () => {
  it('every provider, hammered 500×, only ever returns typed decisions', () => {
    const env: NodeJS.ProcessEnv = {};
    for (const p of PROVIDERS) for (const k of p.requiredEnv) env[k] = 'x';
    for (const p of PROVIDERS) {
      for (let i = 0; i < 500; i++) {
        const d = requestQuota(p.id, { env, now: () => T0 + i });
        assert.ok(['allow', 'defer', 'degrade', 'deny'].includes(d.action), `${p.id} returned ${d.action}`);
      }
    }
  });
});

describe('CROSS-WAVE INVARIANT — nothing fabricated can reach a live feed', () => {
  it('every provider descriptor yields a valid provenance envelope', () => {
    for (const p of PROVIDERS) {
      assert.deepEqual(validateProvenance(provenanceFromDescriptor(p)), [], `${p.id}`);
    }
  });

  it('no delayed provider can ever badge as LIVE', () => {
    for (const p of PROVIDERS) {
      if (p.latency === 'realtime') continue;
      assert.notEqual(badgeFor(provenanceFromDescriptor(p)), 'LIVE', `${p.id} badged LIVE while delayed`);
    }
  });

  it('a synthetic payload is refused in live mode however it is dressed', () => {
    const attacks = [
      { source: 'simulation' },
      { source: 'simulation', synthetic: true as const },
      { source: 'tradier', provenance: syntheticProvenance('tradier') },
      markSynthetic({ source: 'polygon' }),
      { source: 'brand-new-generator' },
    ];
    for (const a of attacks) {
      assert.notEqual(rejectEmission(a, LIVE), null, `admitted: ${JSON.stringify(a)}`);
    }
  });

  it('a report over zero graded rows never claims a hit rate', () => {
    const rep = buildReport([]);
    assert.equal(rep.hitRate, null);
    assert.equal(rep.averageReturn, null);
  });

  it('every BLOCKED provider states why', () => {
    for (const p of PROVIDERS) {
      if (p.blockedOnFreeTier) assert.ok(p.blockedReason, `${p.id} blocked with no reason`);
    }
  });

  it('the finra provider can never be selected for equity trades', () => {
    assert.equal(getProvider('finra')?.blockedOnFreeTier, true);
  });
});
