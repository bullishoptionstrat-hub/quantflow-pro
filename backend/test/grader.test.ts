/**
 * WAVE 7 — outcome grading, including a HAND-VERIFIED worked example.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildReport,
  DEFAULT_FLAT_THRESHOLD,
  firstMarkAtOrAfter,
  gradeEvent,
  GRADER_VERSION,
  HORIZON_MS,
  type GradeInput,
  type PriceMark,
} from '../src/outcomes/grader';

const T0 = 1_700_000_000_000;
const MIN = 60_000;

function marks(...pairs: Array<[number, number]>): PriceMark[] {
  return pairs.map(([minute, price]) => ({ time: T0 + minute * MIN, price }));
}

function input(over: Partial<GradeInput> = {}): GradeInput {
  return {
    flowEventId: 'evt-1',
    symbol: 'SPY',
    signalAt: T0,
    actionableAt: T0,
    impliedDirection: 'LONG',
    horizon: '15m',
    marks: marks([0, 580], [15, 585]),
    now: T0 + 60 * MIN,
    ...over,
  };
}

describe('HAND-VERIFIED WORKED EXAMPLE', () => {
  /**
   * Checked by hand:
   *   entry  = first mark at/after actionable (T+0)  = 580.00
   *   exit   = first mark at/after T+15m            = 585.80
   *   return = (585.80 − 580.00) / 580.00 = 5.80 / 580.00 = 0.01 exactly
   *   LONG   ⇒ directed return = +0.01 = +1.00%  ⇒ WIN (|0.01| > 0.001)
   */
  const result = gradeEvent(input({
    marks: marks([-5, 575], [0, 580], [7, 583], [15, 585.8], [30, 590]),
    horizon: '15m',
  }));

  it('picks the correct entry and exit marks', () => {
    assert.equal(result.entryMark, 580);
    assert.equal(result.exitMark, 585.8);
  });

  it('computes the return exactly as hand-calculated', () => {
    assert.ok(Math.abs(result.underlyingReturn! - 0.01) < 1e-12,
      `expected +0.010000, got ${result.underlyingReturn}`);
  });

  it('labels it WIN and records the basis and version', () => {
    assert.equal(result.label, 'WIN');
    assert.equal(result.ungradedReason, null);
    assert.equal(result.returnBasis, 'underlying');
    assert.equal(result.calculationVersion, GRADER_VERSION);
  });

  it('the mirrored SHORT on the same data is a LOSS of the same magnitude', () => {
    const short = gradeEvent(input({
      marks: marks([-5, 575], [0, 580], [7, 583], [15, 585.8], [30, 590]),
      impliedDirection: 'SHORT',
    }));
    assert.equal(short.label, 'LOSS');
    assert.ok(Math.abs(short.underlyingReturn! + 0.01) < 1e-12);
  });
});

describe('CAUSALITY — no mark from before actionable_at is ever used', () => {
  it('ignores marks before actionable_at when choosing entry', () => {
    const r = gradeEvent(input({
      actionableAt: T0 + 10 * MIN,
      // A very attractive earlier price that must NOT be used as entry.
      marks: marks([0, 500], [10, 580], [25, 585.8]),
      horizon: '15m',
    }));
    assert.equal(r.entryMark, 580, 'entry must come from at/after actionable_at');
  });

  it('firstMarkAtOrAfter never returns an earlier mark', () => {
    const m = marks([0, 100], [5, 110], [10, 120]);
    assert.equal(firstMarkAtOrAfter(m, T0 + 5 * MIN)?.price, 110);
    assert.equal(firstMarkAtOrAfter(m, T0 + 6 * MIN)?.price, 120);
    assert.equal(firstMarkAtOrAfter(m, T0 + 11 * MIN), null);
  });

  it('is order-independent — shuffled marks give the same grade', () => {
    const ordered = marks([0, 580], [15, 585.8], [30, 590]);
    const shuffled = [...ordered].reverse();
    assert.deepEqual(
      gradeEvent(input({ marks: ordered })),
      gradeEvent(input({ marks: shuffled })),
    );
  });

  it('exit is taken at the horizon, not at the best price in the window', () => {
    // 600 at T+7 would be a much better exit — using it would be lookahead.
    const r = gradeEvent(input({
      marks: marks([0, 580], [7, 600], [15, 585.8]),
      horizon: '15m',
    }));
    assert.equal(r.exitMark, 585.8);
  });
});

describe('UNGRADED is first-class — never coerced to make tables look complete', () => {
  it('ambiguous direction ⇒ UNGRADED, never a coin flip', () => {
    const r = gradeEvent(input({ impliedDirection: null }));
    assert.equal(r.label, 'UNGRADED');
    assert.equal(r.ungradedReason, 'ambiguous_direction');
    assert.equal(r.underlyingReturn, null);
  });

  it('missing entry mark ⇒ UNGRADED', () => {
    const r = gradeEvent(input({ marks: marks([-10, 570]) }));
    assert.equal(r.ungradedReason, 'no_entry_mark');
  });

  it('missing exit mark ⇒ UNGRADED', () => {
    const r = gradeEvent(input({ marks: marks([0, 580]) }));
    assert.equal(r.ungradedReason, 'no_exit_mark');
  });

  it('horizon not yet elapsed ⇒ UNGRADED with no evaluatedAt', () => {
    const r = gradeEvent(input({ now: T0 + 5 * MIN, horizon: '15m' }));
    assert.equal(r.ungradedReason, 'horizon_not_elapsed');
    assert.equal(r.evaluatedAt, null);
  });

  it('a zero entry price ⇒ UNGRADED rather than Infinity', () => {
    const r = gradeEvent(input({ marks: marks([0, 0], [15, 100]) }));
    assert.equal(r.ungradedReason, 'zero_entry_price');
    assert.equal(r.underlyingReturn, null);
  });
});

describe('FLAT band', () => {
  it('a move below the threshold is FLAT, not a marginal WIN', () => {
    // +0.05% < 0.1% threshold
    const r = gradeEvent(input({ marks: marks([0, 580], [15, 580.29]) }));
    assert.equal(r.label, 'FLAT');
    assert.ok(Math.abs(r.underlyingReturn!) < DEFAULT_FLAT_THRESHOLD);
  });

  it('a move just above the threshold is a WIN', () => {
    const r = gradeEvent(input({ marks: marks([0, 580], [15, 581.5]) }));
    assert.equal(r.label, 'WIN');
  });
});

describe('horizons', () => {
  it('uses the correct offset for each horizon', () => {
    assert.equal(HORIZON_MS['15m'], 900_000);
    assert.equal(HORIZON_MS['1h'], 3_600_000);
    assert.equal(HORIZON_MS['1d'], 86_400_000);
  });

  it('grades the same event differently at different horizons', () => {
    const m = marks([0, 580], [15, 575], [60, 590]);
    const at15 = gradeEvent(input({ marks: m, horizon: '15m', now: T0 + 2 * 86_400_000 }));
    const at1h = gradeEvent(input({ marks: m, horizon: '1h', now: T0 + 2 * 86_400_000 }));
    assert.equal(at15.label, 'LOSS');
    assert.equal(at1h.label, 'WIN');
  });
});

describe('synthetic input can only produce a demo-flagged outcome', () => {
  it('propagates isSynthetic into isDemo', () => {
    const r = gradeEvent(input({ isSynthetic: true }));
    assert.equal(r.isSynthetic, true);
    assert.equal(r.isDemo, true);
  });

  it('real input is neither', () => {
    const r = gradeEvent(input());
    assert.equal(r.isSynthetic, false);
    assert.equal(r.isDemo, false);
  });
});

describe('report aggregates honestly', () => {
  it('excludes UNGRADED from the hit rate but COUNTS it', () => {
    const results = [
      gradeEvent(input({ flowEventId: 'a', marks: marks([0, 580], [15, 590]) })),          // WIN
      gradeEvent(input({ flowEventId: 'b', marks: marks([0, 580], [15, 570]) })),          // LOSS
      gradeEvent(input({ flowEventId: 'c', impliedDirection: null })),                      // UNGRADED
      gradeEvent(input({ flowEventId: 'd', impliedDirection: null })),                      // UNGRADED
    ];
    const rep = buildReport(results);
    assert.equal(rep.total, 4);
    assert.equal(rep.graded, 2);
    assert.equal(rep.ungraded, 2);
    assert.equal(rep.hitRate, 0.5, 'hit rate must be over GRADED only');
    assert.equal(rep.ungradedByReason['ambiguous_direction'], 2);
  });

  it('reports hitRate null rather than 0% when nothing is graded', () => {
    const rep = buildReport([gradeEvent(input({ impliedDirection: null }))]);
    assert.equal(rep.hitRate, null, '0/0 must not be presented as 0%');
    assert.equal(rep.averageReturn, null);
  });

  it('always states the underlying-only basis', () => {
    const rep = buildReport([]);
    assert.equal(rep.returnBasis, 'underlying');
    assert.match(rep.note, /option-level P&L/i);
    assert.match(rep.note, /theta/i);
  });
});
