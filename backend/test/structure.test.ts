/**
 * WAVE 6 — lookahead and repainting regression suite.
 *
 * These are the tests that matter. A market-structure detector that silently
 * reads a future bar produces beautiful backtests and loses money, so the
 * properties below are asserted mechanically rather than by inspection.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  assertCausality,
  CausalityViolation,
  detectAll,
  detectBos,
  detectFvg,
  detectLiquiditySweep,
  detectSmtDivergence,
  findSwingHighs,
  findSwingLows,
  type Bar,
} from '../src/structure/detect';

const T0 = 1_700_000_000_000;
const MIN = 60_000;

/** Deterministic bar builder. openTime = T0 + i·1min, closeTime = open + 1min. */
function bar(i: number, o: number, h: number, l: number, c: number, v = 1000): Bar {
  return { time: T0 + i * MIN, closeTime: T0 + (i + 1) * MIN, open: o, high: h, low: l, close: c, volume: v };
}

/**
 * Fixed fixture: rises, pulls back, makes a swing high, then breaks it.
 * Hand-constructed so every expected detection is checkable by eye.
 */
const TREND_UP: Bar[] = [
  bar(0, 100, 101, 99.5, 100.5),
  bar(1, 100.5, 102, 100, 101.5),
  bar(2, 101.5, 105, 101, 104.5),   // swing high at 105
  bar(3, 104.5, 104.8, 102, 102.5),
  bar(4, 102.5, 103, 101.5, 102),
  bar(5, 102, 104, 101.8, 103.5),
  bar(6, 103.5, 106, 103, 105.8),   // CLOSES above 105 ⇒ bullish BOS
  bar(7, 105.8, 107, 105, 106.5),
  bar(8, 106.5, 108, 106, 107.5),
];

describe('causality invariant is enforced, not assumed', () => {
  it('every detection satisfies formation <= confirmation <= actionable', () => {
    for (const d of detectAll(TREND_UP)) {
      assert.ok(d.formation_time <= d.confirmation_time, `${d.kind}: formation after confirmation`);
      assert.ok(d.confirmation_time <= d.actionable_time, `${d.kind}: confirmation after actionable`);
      assert.ok(d.formation_index <= d.confirmation_index, `${d.kind}: index order violated`);
    }
  });

  it('formation and confirmation are genuinely DIFFERENT for patterns that need it', () => {
    // An FVG forms across 3 bars but is only knowable at the third close.
    // If these were equal the detector would be claiming instant knowledge.
    const gapped: Bar[] = [
      bar(0, 100, 101, 99, 100.5),
      bar(1, 101, 106, 100.8, 105.5),
      bar(2, 106, 108, 103, 107),   // low 103 > bar0 high 101 ⇒ bullish FVG
    ];
    const [fvg] = detectFvg(gapped);
    assert.ok(fvg, 'expected an FVG');
    assert.notEqual(fvg.formation_time, fvg.confirmation_time);
    assert.equal(fvg.formation_index, 0);
    assert.equal(fvg.confirmation_index, 2);
    assert.equal(fvg.actionable_time, gapped[2]!.closeTime);
  });

  it('assertCausality THROWS on a violation instead of emitting it', () => {
    assert.throws(
      () => assertCausality({
        kind: 'BOS', direction: 'BULLISH',
        formation_index: 5, confirmation_index: 2,
        formation_time: T0 + 5 * MIN, confirmation_time: T0 + 2 * MIN,
        actionable_time: T0 + 2 * MIN,
        level: 100, confidence: 1, method: 'test',
      }),
      CausalityViolation,
    );
  });
});

describe('NO LOOKAHEAD — a detector never uses a bar it has not seen', () => {
  /**
   * The prefix property: running the detectors on the first n bars must give
   * exactly what running on all bars gives, restricted to confirmations within
   * those n bars. If a detector peeked ahead, the prefix run would differ.
   */
  it('detectAll(prefix) is a prefix of detectAll(full) for EVERY split point', () => {
    const full = detectAll(TREND_UP);

    for (let n = 3; n <= TREND_UP.length; n++) {
      const prefix = detectAll(TREND_UP.slice(0, n));
      const expected = full.filter((d) => d.confirmation_index < n);

      assert.deepEqual(
        prefix.map(key),
        expected.map(key),
        `prefix of length ${n} disagrees with the full run — a detector read the future`,
      );
    }
  });

  it('appending a future bar NEVER changes an existing detection (no repainting)', () => {
    const before = detectAll(TREND_UP);
    // A violent future bar that would tempt a repainting detector to revise.
    const after = detectAll([...TREND_UP, bar(9, 107.5, 130, 80, 85)]);

    const beforeKeys = before.map(key);
    const afterKeys = after.map(key);
    assert.deepEqual(
      afterKeys.slice(0, beforeKeys.length),
      beforeKeys,
      'an earlier detection was revised or withdrawn when a later bar arrived',
    );
  });

  it('detections are never withdrawn as data grows', () => {
    let previousCount = 0;
    for (let n = 3; n <= TREND_UP.length; n++) {
      const count = detectAll(TREND_UP.slice(0, n)).length;
      assert.ok(count >= previousCount, `detections decreased from ${previousCount} to ${count} at n=${n}`);
      previousCount = count;
    }
  });
});

describe('SAME-BAR EXECUTION LEAKAGE', () => {
  it('actionable_time is never before the confirming bar CLOSED', () => {
    for (const d of detectAll(TREND_UP)) {
      const confirmingBar = TREND_UP[d.confirmation_index]!;
      assert.ok(
        d.actionable_time >= confirmingBar.closeTime,
        `${d.kind} is actionable at ${d.actionable_time}, before its confirming bar closed at ${confirmingBar.closeTime}`,
      );
    }
  });

  it('a fill at actionable_time cannot use the confirming bar\'s own intrabar range', () => {
    // Simulating the classic backtest bug: filling at the trigger bar's LOW
    // after confirming on its CLOSE. actionable_time must land at/after that
    // bar's close, so only the NEXT bar's range is available to fill against.
    for (const d of detectAll(TREND_UP)) {
      const nextIndex = d.confirmation_index + 1;
      if (nextIndex >= TREND_UP.length) continue;
      assert.ok(
        d.actionable_time <= TREND_UP[nextIndex]!.closeTime,
        'actionable_time should fall within the next bar, not later',
      );
      assert.ok(
        d.actionable_time >= TREND_UP[d.confirmation_index]!.closeTime,
        'actionable_time must not precede its own confirming close',
      );
    }
  });
});

describe('BOS uses the CLOSE, not the wick', () => {
  it('an intrabar wick above a swing does NOT produce a BOS', () => {
    const wickOnly: Bar[] = [
      bar(0, 100, 101, 99, 100.5),
      bar(1, 100.5, 102, 100, 101),
      bar(2, 101, 105, 100.8, 104),    // swing high 105
      bar(3, 104, 104.5, 102, 102.5),
      bar(4, 102.5, 103, 102, 102.8),
      bar(5, 102.8, 106, 102.5, 103),  // wick to 106 but CLOSES at 103 (< 105)
      bar(6, 103, 103.5, 102, 102.5),
      bar(7, 102.5, 103, 101, 101.5),
    ];
    const bos = detectBos(wickOnly).filter((d) => d.direction === 'BULLISH');
    assert.equal(bos.length, 0, 'a wick that closed back inside must not be a break');
  });

  it('a close beyond the swing DOES produce a BOS, at the right bar', () => {
    const bos = detectBos(TREND_UP).filter((d) => d.direction === 'BULLISH');
    assert.ok(bos.length >= 1);
    assert.equal(bos[0]!.level, 105);
    assert.equal(bos[0]!.confirmation_index, 6);
    assert.equal(bos[0]!.method, 'close_beyond_confirmed_swing_high');
  });

  it('only breaks bars AFTER the swing was confirmable', () => {
    // A swing at index s needs `lookback` bars after it before it is a swing at
    // all; nothing at or before s+lookback may be treated as breaking it.
    for (const d of detectBos(TREND_UP)) {
      assert.ok(
        d.confirmation_index > d.formation_index + 2,
        'break confirmed before the swing itself was confirmable',
      );
    }
  });
});

describe('liquidity sweep — wick beyond, close inside', () => {
  it('detects the wick-and-reject that BOS correctly ignores', () => {
    const swept: Bar[] = [
      bar(0, 100, 101, 99, 100.5),
      bar(1, 100.5, 102, 100, 101),
      bar(2, 101, 105, 100.8, 104),
      bar(3, 104, 104.5, 102, 102.5),
      bar(4, 102.5, 103, 102, 102.8),
      bar(5, 102.8, 106, 102.5, 103),  // sweeps 105, closes back under
      bar(6, 103, 103.5, 102, 102.5),
      bar(7, 102.5, 103, 101, 101.5),
    ];
    const sweeps = detectLiquiditySweep(swept);
    assert.ok(sweeps.some((s) => s.direction === 'BEARISH' && s.level === 105));
  });
});

describe('swing detection', () => {
  it('requires bars on BOTH sides — no swing at the array edges', () => {
    const highs = findSwingHighs(TREND_UP, 2);
    for (const i of highs) {
      assert.ok(i >= 2 && i < TREND_UP.length - 2, `swing at ${i} lacks bars on both sides`);
    }
    assert.ok(findSwingLows(TREND_UP, 2).every((i) => i >= 2 && i < TREND_UP.length - 2));
  });

  it('is deterministic', () => {
    assert.deepEqual(findSwingHighs(TREND_UP), findSwingHighs(TREND_UP));
  });
});

describe('SMT divergence', () => {
  it('skips bars whose times do not align rather than assuming correspondence', () => {
    const a = TREND_UP;
    // Same shape, shifted by 30s ⇒ no bar corresponds.
    const b = TREND_UP.map((x) => ({ ...x, time: x.time + 30_000 }));
    assert.deepEqual(detectSmtDivergence(a, b), []);
  });

  it('flags disagreement at an aligned swing, actionable only after confirmation', () => {
    const a = TREND_UP;
    // b fails to make the same higher high at index 2.
    const b = TREND_UP.map((x, i) => (i === 2 ? { ...x, high: 101.2 } : x));
    const divs = detectSmtDivergence(a, b);
    for (const d of divs) {
      assert.ok(d.actionable_time >= d.time, 'SMT actionable before the swing bar itself');
      assert.equal(d.actionable_time, d.confirmation_time);
    }
  });
});

describe('determinism', () => {
  it('detectAll is byte-identical across runs', () => {
    assert.deepEqual(detectAll(TREND_UP), detectAll(TREND_UP));
  });
});

/** Stable identity for a detection, for prefix/repaint comparisons. */
function key(d: { kind: string; direction: string; formation_index: number; confirmation_index: number; level: number }) {
  return `${d.kind}|${d.direction}|${d.formation_index}|${d.confirmation_index}|${d.level}`;
}
