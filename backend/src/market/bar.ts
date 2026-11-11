/**
 * A CLOSED price bar, and the refusals that keep a malformed one out.
 *
 * Lives in `market/` rather than `structure/` because the bar feed that does
 * not exist yet (Phase A) has to produce exactly this shape, and the structure
 * engine (Phase B) has to consume it. One definition, two consumers — the same
 * reason `FlowEvent` has one home.
 *
 * **Closed means closed.** A bar enters here only once its interval has ended:
 * `closedAt` is the instant the last trade in it could have happened, and every
 * structure event cites the `closedAt` of the bars that justify it. A forming
 * bar would let a high that is still being made be read as a high, which is the
 * look-ahead the whole engine is built to refuse.
 *
 * **Refusal, not repair.** `validateBar` never rounds a price, swaps a high and
 * a low, or clamps a timestamp. A bar whose high is below its close is not a bar
 * with a typo; it is evidence the source is reporting something other than what
 * the fields claim, and "fixing" it would publish a structure event computed
 * from a number nobody observed — the `?? 0` defect this repository keeps
 * closing, arrived at through arithmetic instead of a default.
 */

export type BarTimeframe = '1m' | '5m' | '15m';

export const BAR_TIMEFRAMES: readonly BarTimeframe[] = ['1m', '5m', '15m'];

/** The nominal length of each timeframe. */
export const TIMEFRAME_MS: Readonly<Record<BarTimeframe, number>> = {
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
};

export interface Bar {
  symbol: string;
  tf: BarTimeframe;
  /** Epoch ms at which the bar's interval began. */
  tOpen: number;
  /** Epoch ms at which the bar's interval ended — when it became knowable. */
  closedAt: number;
  o: number;
  h: number;
  l: number;
  c: number;
  /**
   * Shares traded, or null when the source does not say. Null is not zero: a
   * bar the vendor sent no volume for is not a bar in which nothing traded.
   */
  v: number | null;
  /** Which feed produced it, so a structure event can name its provenance. */
  source: string;
}

export type BarCheck = { ok: true } | { ok: false; reasons: string[] };

const isTimeframe = (x: unknown): x is BarTimeframe =>
  typeof x === 'string' && (BAR_TIMEFRAMES as readonly string[]).includes(x);

const isFiniteNumber = (x: unknown): x is number =>
  typeof x === 'number' && Number.isFinite(x);

/**
 * Every reason a value is not a usable closed bar. Empty means usable.
 *
 * The relational checks run only once every number is readable: comparing a
 * NaN high with a close answers false either way, and a refusal that names the
 * wrong fault sends the reader after the wrong problem.
 */
export function barRefusals(x: unknown): string[] {
  if (typeof x !== 'object' || x === null) return ['not an object'];
  const b = x as Record<string, unknown>;
  const reasons: string[] = [];

  if (typeof b.symbol !== 'string' || b.symbol.trim() === '') reasons.push('symbol is missing');
  if (!isTimeframe(b.tf)) reasons.push(`tf ${JSON.stringify(b.tf)} is not one of ${BAR_TIMEFRAMES.join(', ')}`);
  if (typeof b.source !== 'string' || b.source.trim() === '') reasons.push('source is missing');

  const numeric = ['tOpen', 'closedAt', 'o', 'h', 'l', 'c'] as const;
  const unreadable = numeric.filter((k) => !isFiniteNumber(b[k]));
  for (const k of unreadable) reasons.push(`${k} is not a finite number`);

  if (!(b.v === null || (isFiniteNumber(b.v) && b.v >= 0))) {
    reasons.push('v must be null or a finite, non-negative number');
  }
  if (unreadable.length > 0) return reasons;

  const o = b.o as number, h = b.h as number, l = b.l as number, c = b.c as number;
  const tOpen = b.tOpen as number, closedAt = b.closedAt as number;

  for (const [k, p] of [['o', o], ['h', h], ['l', l], ['c', c]] as const) {
    if (!(p > 0)) reasons.push(`${k} is not a positive price`);
  }
  if (h < Math.max(o, c)) reasons.push(`h ${h} is below max(o, c) ${Math.max(o, c)}`);
  if (l > Math.min(o, c)) reasons.push(`l ${l} is above min(o, c) ${Math.min(o, c)}`);
  if (closedAt <= tOpen) {
    reasons.push(`closedAt ${closedAt} is not after tOpen ${tOpen}`);
  } else if (isTimeframe(b.tf) && closedAt - tOpen > TIMEFRAME_MS[b.tf]) {
    // Shorter is allowed (a session can end inside a bar's nominal interval);
    // longer is a bar labelled with the wrong timeframe.
    reasons.push(`spans ${closedAt - tOpen}ms, longer than a ${b.tf} bar`);
  }
  return reasons;
}

export function validateBar(x: unknown): BarCheck {
  const reasons = barRefusals(x);
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}

/**
 * A series is one symbol at one timeframe, in time order, with no two bars
 * overlapping. Missing bars are allowed — a gap is a fact about the feed and the
 * detectors state what they do across one — but an out-of-order or overlapping
 * bar is refused, because no ordering of it is the true one.
 */
export function validateSeries(bars: readonly unknown[]): BarCheck {
  const reasons: string[] = [];
  let first: Bar | null = null;
  let prev: Bar | null = null;
  for (let i = 0; i < bars.length; i++) {
    const own = barRefusals(bars[i]);
    for (const r of own) reasons.push(`bar ${i}: ${r}`);
    if (own.length > 0) { prev = null; continue; }
    const b = bars[i] as Bar;
    if (first === null) first = b;
    else {
      if (b.symbol !== first.symbol) reasons.push(`bar ${i}: symbol ${b.symbol} differs from ${first.symbol}`);
      if (b.tf !== first.tf) reasons.push(`bar ${i}: tf ${b.tf} differs from ${first.tf}`);
    }
    if (prev !== null) {
      if (b.tOpen <= prev.tOpen) reasons.push(`bar ${i}: tOpen ${b.tOpen} is not after the previous bar's ${prev.tOpen}`);
      else if (b.tOpen < prev.closedAt) reasons.push(`bar ${i}: opens at ${b.tOpen}, before the previous bar closed at ${prev.closedAt}`);
    }
    prev = b;
  }
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}

/** A bar's identity: one symbol, one timeframe, one interval. */
export function barId(b: Pick<Bar, 'symbol' | 'tf' | 'tOpen'>): string {
  return `${b.symbol}:${b.tf}:${b.tOpen}`;
}
