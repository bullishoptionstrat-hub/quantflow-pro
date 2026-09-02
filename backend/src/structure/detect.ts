/**
 * Market-structure detection — BOS, CHoCH, FVG, order blocks, liquidity sweeps.
 *
 * ─── THE CAUSALITY CONTRACT (the whole point of this module) ────────────────
 *
 * Every detection carries THREE distinct times:
 *
 *   formation_time    when the pattern's bars occurred (in the past)
 *   confirmation_time when the bar that CONFIRMS it CLOSED
 *   actionable_time   the earliest time a strategy could have acted
 *
 * They are deliberately different. A fair value gap forms across bars i-2..i,
 * but you cannot know it exists until bar i closes — so acting at
 * formation_time would be reading the future. The invariant
 *
 *     formation_time <= confirmation_time <= actionable_time
 *
 * is enforced by `assertCausality()` and asserted in the regression tests.
 *
 * REPAINTING: a detector must never revise or withdraw a past detection when a
 * later bar arrives. Every function here takes a bar array and returns
 * detections whose `confirmation_index` is strictly within the data supplied —
 * `detectAll(bars.slice(0, n))` is a prefix of `detectAll(bars)` for every n.
 * That property is itself a test.
 */

export interface Bar {
  /** Epoch ms of the bar's OPEN. */
  time: number;
  /** Epoch ms of the bar's CLOSE — when its information became available. */
  closeTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type StructureKind =
  | 'BOS'              // break of structure — trend continuation
  | 'CHOCH'            // change of character — potential reversal
  | 'FVG'              // fair value gap / imbalance
  | 'ORDER_BLOCK'
  | 'LIQUIDITY_SWEEP';

export type Direction = 'BULLISH' | 'BEARISH';

export interface StructureDetection {
  kind: StructureKind;
  direction: Direction;

  /** Index of the bar where the pattern's structure formed. */
  formation_index: number;
  /** Index of the bar whose CLOSE confirmed it. */
  confirmation_index: number;

  formation_time: number;
  confirmation_time: number;
  /**
   * Earliest actionable moment. Equals confirmation_time: the confirming bar's
   * close is the first instant the information exists. Anything earlier is
   * lookahead.
   */
  actionable_time: number;

  /** Price level the detection refers to. */
  level: number;
  /** For gaps/blocks: the zone bounds. */
  zone?: { upper: number; lower: number };

  confidence: number;
  method: string;
}

export class CausalityViolation extends Error {
  constructor(message: string, readonly detection: StructureDetection) {
    super(message);
    this.name = 'CausalityViolation';
  }
}

/** Enforces formation <= confirmation <= actionable. Throws rather than emitting. */
export function assertCausality(d: StructureDetection): StructureDetection {
  if (d.formation_time > d.confirmation_time) {
    throw new CausalityViolation(
      `${d.kind}: formation_time (${d.formation_time}) is after confirmation_time (${d.confirmation_time})`,
      d,
    );
  }
  if (d.confirmation_time > d.actionable_time) {
    throw new CausalityViolation(
      `${d.kind}: confirmation_time (${d.confirmation_time}) is after actionable_time (${d.actionable_time})`,
      d,
    );
  }
  if (d.formation_index > d.confirmation_index) {
    throw new CausalityViolation(
      `${d.kind}: formation_index (${d.formation_index}) is after confirmation_index (${d.confirmation_index})`,
      d,
    );
  }
  return d;
}

/** Swing high: a bar whose high exceeds `lookback` bars on BOTH sides. */
export function findSwingHighs(bars: readonly Bar[], lookback = 2): number[] {
  const out: number[] = [];
  for (let i = lookback; i < bars.length - lookback; i++) {
    const h = bars[i]!.high;
    let isSwing = true;
    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j !== i && bars[j]!.high >= h) { isSwing = false; break; }
    }
    if (isSwing) out.push(i);
  }
  return out;
}

export function findSwingLows(bars: readonly Bar[], lookback = 2): number[] {
  const out: number[] = [];
  for (let i = lookback; i < bars.length - lookback; i++) {
    const l = bars[i]!.low;
    let isSwing = true;
    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j !== i && bars[j]!.low <= l) { isSwing = false; break; }
    }
    if (isSwing) out.push(i);
  }
  return out;
}

/**
 * Fair value gap: a three-bar imbalance where bar i-2 and bar i do not overlap.
 *
 * Formation spans i-2..i, but it is only KNOWABLE once bar i closes — so
 * confirmation and actionable time both come from bar i's close, never from
 * bar i-2's open.
 */
export function detectFvg(bars: readonly Bar[]): StructureDetection[] {
  const out: StructureDetection[] = [];
  for (let i = 2; i < bars.length; i++) {
    const a = bars[i - 2]!;
    const c = bars[i]!;

    // Bullish FVG: the gap between bar i-2's high and bar i's low.
    if (c.low > a.high) {
      out.push(assertCausality({
        kind: 'FVG',
        direction: 'BULLISH',
        formation_index: i - 2,
        confirmation_index: i,
        formation_time: a.time,
        confirmation_time: c.closeTime,
        actionable_time: c.closeTime,
        level: (c.low + a.high) / 2,
        zone: { upper: c.low, lower: a.high },
        confidence: 0.6,
        method: 'three_bar_imbalance',
      }));
    }

    // Bearish FVG.
    if (c.high < a.low) {
      out.push(assertCausality({
        kind: 'FVG',
        direction: 'BEARISH',
        formation_index: i - 2,
        confirmation_index: i,
        formation_time: a.time,
        confirmation_time: c.closeTime,
        actionable_time: c.closeTime,
        level: (c.high + a.low) / 2,
        zone: { upper: a.low, lower: c.high },
        confidence: 0.6,
        method: 'three_bar_imbalance',
      }));
    }
  }
  return out;
}

/**
 * Break of structure: price CLOSES beyond a prior confirmed swing.
 *
 * Uses the CLOSE, not the high/low, so an intrabar wick that reverses does not
 * produce a signal that later "unhappens" — that is the classic repainting bug.
 */
export function detectBos(bars: readonly Bar[], lookback = 2): StructureDetection[] {
  const out: StructureDetection[] = [];
  const highs = findSwingHighs(bars, lookback);
  const lows = findSwingLows(bars, lookback);

  for (const swingIdx of highs) {
    // A swing at index s is only confirmed at s+lookback (it needs bars after
    // it). Only bars strictly after that can break it.
    const confirmedAt = swingIdx + lookback;
    const level = bars[swingIdx]!.high;
    for (let i = confirmedAt + 1; i < bars.length; i++) {
      if (bars[i]!.close > level) {
        out.push(assertCausality({
          kind: 'BOS',
          direction: 'BULLISH',
          formation_index: swingIdx,
          confirmation_index: i,
          formation_time: bars[swingIdx]!.time,
          confirmation_time: bars[i]!.closeTime,
          actionable_time: bars[i]!.closeTime,
          level,
          confidence: 0.7,
          method: 'close_beyond_confirmed_swing_high',
        }));
        break; // first break only — later breaks are new structure
      }
    }
  }

  for (const swingIdx of lows) {
    const confirmedAt = swingIdx + lookback;
    const level = bars[swingIdx]!.low;
    for (let i = confirmedAt + 1; i < bars.length; i++) {
      if (bars[i]!.close < level) {
        out.push(assertCausality({
          kind: 'BOS',
          direction: 'BEARISH',
          formation_index: swingIdx,
          confirmation_index: i,
          formation_time: bars[swingIdx]!.time,
          confirmation_time: bars[i]!.closeTime,
          actionable_time: bars[i]!.closeTime,
          level,
          confidence: 0.7,
          method: 'close_beyond_confirmed_swing_low',
        }));
        break;
      }
    }
  }

  return out.sort((a, b) => a.confirmation_index - b.confirmation_index);
}

/**
 * Liquidity sweep: price wicks BEYOND a swing level but CLOSES back inside —
 * i.e. stops were taken without a real break.
 */
export function detectLiquiditySweep(bars: readonly Bar[], lookback = 2): StructureDetection[] {
  const out: StructureDetection[] = [];
  const highs = findSwingHighs(bars, lookback);
  const lows = findSwingLows(bars, lookback);

  for (const swingIdx of highs) {
    const level = bars[swingIdx]!.high;
    for (let i = swingIdx + lookback + 1; i < bars.length; i++) {
      const b = bars[i]!;
      if (b.high > level && b.close < level) {
        out.push(assertCausality({
          kind: 'LIQUIDITY_SWEEP',
          direction: 'BEARISH',
          formation_index: swingIdx,
          confirmation_index: i,
          formation_time: bars[swingIdx]!.time,
          confirmation_time: b.closeTime,
          actionable_time: b.closeTime,
          level,
          confidence: 0.55,
          method: 'wick_beyond_swing_close_inside',
        }));
        break;
      }
    }
  }

  for (const swingIdx of lows) {
    const level = bars[swingIdx]!.low;
    for (let i = swingIdx + lookback + 1; i < bars.length; i++) {
      const b = bars[i]!;
      if (b.low < level && b.close > level) {
        out.push(assertCausality({
          kind: 'LIQUIDITY_SWEEP',
          direction: 'BULLISH',
          formation_index: swingIdx,
          confirmation_index: i,
          formation_time: bars[swingIdx]!.time,
          confirmation_time: b.closeTime,
          actionable_time: b.closeTime,
          level,
          confidence: 0.55,
          method: 'wick_beyond_swing_close_inside',
        }));
        break;
      }
    }
  }

  return out.sort((a, b) => a.confirmation_index - b.confirmation_index);
}

/** All detectors, ordered by when each became actionable. */
export function detectAll(bars: readonly Bar[], lookback = 2): StructureDetection[] {
  return [
    ...detectFvg(bars),
    ...detectBos(bars, lookback),
    ...detectLiquiditySweep(bars, lookback),
  ].sort((a, b) => a.actionable_time - b.actionable_time || a.kind.localeCompare(b.kind));
}

/**
 * SMT divergence: two correlated instruments disagree at a swing — one makes a
 * higher high while the other fails to.
 *
 * Both series must be aligned by time. Bars whose times do not match are
 * skipped rather than assumed to correspond.
 */
export interface SmtDivergence {
  direction: Direction;
  index: number;
  time: number;
  confirmation_time: number;
  actionable_time: number;
  leaderMadeNewExtreme: boolean;
  confidence: number;
  method: string;
}

export function detectSmtDivergence(
  a: readonly Bar[],
  b: readonly Bar[],
  lookback = 2,
): SmtDivergence[] {
  const out: SmtDivergence[] = [];
  const n = Math.min(a.length, b.length);
  const aHighs = new Set(findSwingHighs(a.slice(0, n), lookback));
  const aLows = new Set(findSwingLows(a.slice(0, n), lookback));

  for (let i = lookback; i < n - lookback; i++) {
    // Only compare bars that represent the same instant.
    if (a[i]!.time !== b[i]!.time) continue;

    const prev = i - lookback - 1;
    if (prev < 0) continue;

    if (aHighs.has(i)) {
      const aHigher = a[i]!.high > a[prev]!.high;
      const bHigher = b[i]!.high > b[prev]!.high;
      if (aHigher !== bHigher) {
        out.push({
          direction: 'BEARISH',
          index: i,
          time: a[i]!.time,
          // Only knowable once the swing is confirmed, `lookback` bars later.
          confirmation_time: a[Math.min(i + lookback, n - 1)]!.closeTime,
          actionable_time: a[Math.min(i + lookback, n - 1)]!.closeTime,
          leaderMadeNewExtreme: aHigher,
          confidence: 0.5,
          method: 'swing_high_disagreement',
        });
      }
    }

    if (aLows.has(i)) {
      const aLower = a[i]!.low < a[prev]!.low;
      const bLower = b[i]!.low < b[prev]!.low;
      if (aLower !== bLower) {
        out.push({
          direction: 'BULLISH',
          index: i,
          time: a[i]!.time,
          confirmation_time: a[Math.min(i + lookback, n - 1)]!.closeTime,
          actionable_time: a[Math.min(i + lookback, n - 1)]!.closeTime,
          leaderMadeNewExtreme: aLower,
          confidence: 0.5,
          method: 'swing_low_disagreement',
        });
      }
    }
  }

  return out;
}
