/**
 * WAVE 5 — GEX sign convention and reproducibility.
 *
 * The sign convention is the single easiest thing to get backwards in a gamma
 * model, and getting it backwards inverts every support/resistance call the
 * product makes. It is therefore asserted explicitly, from a fixed fixture.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CONTRACT_MULTIPLIER,
  computeGex,
  confidenceFor,
  GEX_CALCULATION_VERSION,
  type ChainStrikeSnapshot,
  type GexInputs,
} from '../src/gex/compute';
import {
  computeIvRank,
  computeSkew,
  computeTermStructure,
  MIN_IV_OBSERVATIONS,
  type IvObservation,
} from '../src/gex/volatility';

const SNAPSHOT_AT = '2026-08-15T14:30:00.000Z';

/** Fixed, hand-checkable fixture. No randomness anywhere. */
function fixture(overrides: Partial<GexInputs> = {}): GexInputs {
  const strikes: ChainStrikeSnapshot[] = [];
  for (let k = 560; k <= 600; k += 5) {
    strikes.push({ strike: k, callOI: 10_000, putOI: 10_000, callGamma: 0.02, putGamma: 0.02 });
  }
  return { symbol: 'SPY', spotPrice: 580, strikes, snapshotAt: SNAPSHOT_AT, ...overrides };
}

describe('SIGN CONVENTION — call GEX positive, put GEX negative', () => {
  it('a call-only chain produces POSITIVE net GEX', () => {
    const r = computeGex(fixture({
      strikes: [{ strike: 580, callOI: 1_000, putOI: 0, callGamma: 0.02, putGamma: 0.02 }],
    }));
    assert.ok(r.strikes[0]!.callGex > 0, 'call GEX must be positive');
    assert.equal(r.strikes[0]!.putGex, 0);
    assert.ok(r.totalGex > 0, 'call-dominated chain must be net positive');
    assert.equal(r.strikes[0]!.levelType, 'SUPPORT');
  });

  it('a put-only chain produces NEGATIVE net GEX', () => {
    const r = computeGex(fixture({
      strikes: [{ strike: 580, callOI: 0, putOI: 1_000, callGamma: 0.02, putGamma: 0.02 }],
    }));
    assert.ok(r.strikes[0]!.putGex < 0, 'put GEX must be negative');
    assert.equal(r.strikes[0]!.callGex, 0);
    assert.ok(r.totalGex < 0, 'put-dominated chain must be net negative');
    assert.equal(r.strikes[0]!.levelType, 'RESISTANCE');
  });

  it('equal call and put OI at the same gamma cancels to zero', () => {
    const r = computeGex(fixture({
      strikes: [{ strike: 580, callOI: 5_000, putOI: 5_000, callGamma: 0.02, putGamma: 0.02 }],
    }));
    assert.equal(r.totalGex, 0);
    assert.equal(r.strikes[0]!.levelType, 'NEUTRAL');
  });
});

describe('UNITS — the contract multiplier is applied', () => {
  it('includes ×100, so the magnitude is not 100× too small', () => {
    // Hand-computed: 1000 OI × 0.02 gamma × 100 mult × 580² × 0.01
    //              = 1000 × 0.02 × 100 × 336400 × 0.01 = 6,728,000
    const r = computeGex(fixture({
      strikes: [{ strike: 580, callOI: 1_000, putOI: 0, callGamma: 0.02, putGamma: 0.02 }],
    }));
    assert.equal(CONTRACT_MULTIPLIER, 100);
    assert.equal(r.strikes[0]!.callGex, 6_728_000);
  });

  it('scales with the square of spot', () => {
    const at580 = computeGex(fixture({
      spotPrice: 580,
      strikes: [{ strike: 580, callOI: 1_000, putOI: 0, callGamma: 0.02, putGamma: 0.02 }],
    })).totalGex;
    const at1160 = computeGex(fixture({
      spotPrice: 1160,
      strikes: [{ strike: 580, callOI: 1_000, putOI: 0, callGamma: 0.02, putGamma: 0.02 }],
    })).totalGex;
    // Doubling spot quadruples dollar gamma.
    assert.equal(Math.round(at1160 / at580), 4);
  });
});

describe('REPRODUCIBILITY — same fixture, same output', () => {
  it('is byte-identical across runs', () => {
    const a = computeGex(fixture());
    const b = computeGex(fixture());
    assert.deepEqual(a, b);
  });

  it('is order-independent — shuffled strikes give the same result', () => {
    const f = fixture();
    const shuffled = { ...f, strikes: [...f.strikes].reverse() };
    assert.deepEqual(computeGex(shuffled), computeGex(f));
  });

  it('stamps a calculation version so results are attributable', () => {
    assert.equal(computeGex(fixture()).calculation_version, GEX_CALCULATION_VERSION);
  });
});

describe('OBSERVED vs ESTIMATED are separated', () => {
  it('reports what was actually measured', () => {
    const r = computeGex(fixture());
    assert.equal(r.observed_inputs.strikeCount, 9);
    assert.equal(r.observed_inputs.totalCallOI, 90_000);
    assert.equal(r.observed_inputs.totalPutOI, 90_000);
    assert.equal(r.observed_inputs.snapshotAt, SNAPSHOT_AT);
  });

  it('names the dealer-positioning assumption explicitly', () => {
    const r = computeGex(fixture());
    assert.ok(r.model_assumptions.length >= 3);
    assert.ok(
      r.model_assumptions.some((a) => /dealers are assumed/i.test(a)),
      'the dealer-inventory assumption must be stated, not hidden',
    );
    assert.ok(r.model_assumptions.some((a) => /not public/i.test(a)));
  });
});

describe('quality flags and confidence are pessimistic', () => {
  it('zero open interest ⇒ confidence 0, not a confident zero', () => {
    const r = computeGex(fixture({
      strikes: [{ strike: 580, callOI: 0, putOI: 0, callGamma: 0.02, putGamma: 0.02 }],
    }));
    assert.ok(r.quality_flags.includes('ZERO_OPEN_INTEREST'));
    assert.equal(r.confidence, 0);
  });

  it('zero gamma ⇒ confidence 0', () => {
    const r = computeGex(fixture({
      strikes: [{ strike: 580, callOI: 1_000, putOI: 1_000, callGamma: 0, putGamma: 0 }],
    }));
    assert.ok(r.quality_flags.includes('ZERO_GAMMA'));
    assert.equal(r.confidence, 0);
  });

  it('a sparse chain is flagged and loses confidence', () => {
    const r = computeGex(fixture({
      strikes: [{ strike: 580, callOI: 100, putOI: 50, callGamma: 0.02, putGamma: 0.02 }],
    }));
    assert.ok(r.quality_flags.includes('SPARSE_CHAIN'));
    assert.ok(r.confidence < 1);
  });

  it('flags call/put gamma divergence — BS says they should match', () => {
    const r = computeGex(fixture({
      strikes: [{ strike: 580, callOI: 100, putOI: 100, callGamma: 0.02, putGamma: 0.05 }],
    }));
    assert.ok(r.quality_flags.includes('ASYMMETRIC_GAMMA'));
  });

  it('flags spot outside the strike range', () => {
    const r = computeGex(fixture({ spotPrice: 400 }));
    assert.ok(r.quality_flags.includes('SPOT_OUTSIDE_STRIKE_RANGE'));
  });

  it('a full, clean chain scores full confidence', () => {
    assert.equal(confidenceFor([], 30), 1);
  });
});

describe('gamma flip', () => {
  it('is null when cumulative GEX never changes sign', () => {
    const r = computeGex(fixture({
      strikes: [
        { strike: 575, callOI: 1_000, putOI: 0, callGamma: 0.02, putGamma: 0.02 },
        { strike: 580, callOI: 1_000, putOI: 0, callGamma: 0.02, putGamma: 0.02 },
      ],
    }));
    assert.equal(r.gammaFlip, null, 'no crossing must report null, not a made-up strike');
  });

  it('identifies the strike where cumulative GEX crosses zero', () => {
    const r = computeGex(fixture({
      strikes: [
        { strike: 575, callOI: 1_000, putOI: 0,     callGamma: 0.02, putGamma: 0.02 },
        { strike: 580, callOI: 0,     putOI: 5_000, callGamma: 0.02, putGamma: 0.02 },
      ],
    }));
    assert.equal(r.gammaFlip, 580);
  });
});

describe('IV rank refuses to answer without enough history', () => {
  const obs = (n: number, iv = 0.2): IvObservation[] =>
    Array.from({ length: n }, (_, i) => ({
      date: new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10),
      iv,
    }));

  it('returns nulls, not a guess, below the minimum sample', () => {
    const r = computeIvRank(obs(10), 0.25);
    assert.equal(r.status, 'insufficient_history');
    assert.equal(r.ivRank, null);
    assert.equal(r.ivPercentile, null);
    assert.equal(r.requiredObservations, MIN_IV_OBSERVATIONS);
    assert.equal(r.observationCount, 10);
  });

  it('computes rank and percentile as DIFFERENT numbers', () => {
    // 99 observations at 0.10, one at 0.50 ⇒ current 0.30 sits mid-range but
    // above almost every observation. Rank and percentile must differ.
    const observations = [...obs(99, 0.1), { date: '2026-06-01', iv: 0.5 }];
    const r = computeIvRank(observations, 0.3);
    assert.equal(r.status, 'ok');
    assert.equal(r.ivRank, 50);          // (0.30-0.10)/(0.50-0.10) = 50%
    assert.equal(r.ivPercentile, 99);    // above 99 of 100
    assert.notEqual(r.ivRank, r.ivPercentile);
  });

  it('handles a flat range without dividing by zero', () => {
    const r = computeIvRank(obs(60, 0.2), 0.2);
    assert.equal(r.status, 'ok');
    assert.equal(r.ivRank, 0);
    assert.ok(Number.isFinite(r.ivRank!));
  });
});

describe('term structure is COMPUTED, not hardcoded', () => {
  it('detects contango', () => {
    const r = computeTermStructure([{ dte: 7, iv: 0.15 }, { dte: 30, iv: 0.2 }, { dte: 90, iv: 0.25 }]);
    assert.equal(r.shape, 'contango');
    assert.ok(r.slope! > 0);
  });

  it('detects backwardation — the state the hardcoded value could never report', () => {
    const r = computeTermStructure([{ dte: 7, iv: 0.4 }, { dte: 30, iv: 0.25 }, { dte: 90, iv: 0.18 }]);
    assert.equal(r.shape, 'backwardation');
    assert.ok(r.slope! < 0);
  });

  it('detects flat and mixed', () => {
    assert.equal(computeTermStructure([{ dte: 7, iv: 0.2 }, { dte: 90, iv: 0.2 }]).shape, 'flat');
    assert.equal(
      computeTermStructure([{ dte: 7, iv: 0.2 }, { dte: 30, iv: 0.35 }, { dte: 90, iv: 0.25 }]).shape,
      'mixed',
    );
  });

  it('returns unknown with zero confidence below two points', () => {
    const r = computeTermStructure([{ dte: 30, iv: 0.2 }]);
    assert.equal(r.shape, 'unknown');
    assert.equal(r.confidence, 0);
    assert.equal(r.slope, null);
  });
});

describe('skew', () => {
  it('reports missing_leg rather than assuming symmetry', () => {
    assert.equal(computeSkew(null, 0.2).status, 'missing_leg');
    assert.equal(computeSkew(0.2, null).skew, null);
  });

  it('computes put minus call', () => {
    assert.equal(computeSkew(0.28, 0.2).skew, 0.08);
  });
});
