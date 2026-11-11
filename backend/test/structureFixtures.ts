/**
 * Builders shared by the structure tests: hand-worked bars, a seeded random
 * walk, and the prefix-stability assertion that is the look-ahead guard.
 *
 * Not a test file (no `.test.ts`), so `tsx --test test/*.test.ts` does not run
 * it on its own; `tsconfig.test.json` still typechecks it.
 *
 * Nothing here calls `Math.random` or reads the clock. A property test that
 * cannot be re-run with the same input is a property test whose failures
 * cannot be reproduced.
 */
import assert from 'node:assert/strict';
import { Bar, BarTimeframe, TIMEFRAME_MS, barId } from '../src/market/bar';
import { SwingEvent } from '../src/structure/swings';
import { STRUCTURE_METHOD_VERSION } from '../src/structure/params';
import { refOf } from '../src/structure/types';
import { instantEt } from '../src/market/civil';
import { regularSessionInstants } from '../src/market/session';
import { sessionOn } from '../src/flow-engine/calendar';

export const MIN = 60_000;

/** A New York wall-clock instant, asserted to exist. */
export function et(date: string, hour: number, minute: number): number {
  const t = instantEt(date, hour, minute);
  assert.ok(t !== null, `${date} ${hour}:${minute} ET does not exist`);
  return t;
}

export function bar(
  symbol: string, tf: BarTimeframe, tOpen: number,
  o: number, h: number, l: number, c: number,
): Bar {
  return { symbol, tf, tOpen, closedAt: tOpen + TIMEFRAME_MS[tf], o, h, l, c, v: 100, source: 'test' };
}

/** Contiguous bars from `[o, h, l, c]` rows, the first opening at `t0`. */
export function series(
  symbol: string, tf: BarTimeframe, t0: number,
  rows: readonly (readonly [number, number, number, number])[],
): Bar[] {
  const step = TIMEFRAME_MS[tf];
  return rows.map(([o, h, l, c], i) => bar(symbol, tf, t0 + i * step, o, h, l, c));
}

/** Contiguous bars from `[high, low]` pairs, opening and closing at the midpoint. */
export function fromHL(
  symbol: string, tf: BarTimeframe, t0: number,
  hl: readonly (readonly [number, number])[],
): Bar[] {
  return series(symbol, tf, t0, hl.map(([h, l]) => {
    const m = (h + l) / 2;
    return [m, h, l, m] as const;
  }));
}

// ── Seeded generator ─────────────────────────────────────────────────────────

/** mulberry32: a small, well-known 32-bit PRNG. Same seed, same sequence. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const round2 = (x: number) => Math.round(x * 100) / 100;

/**
 * Bar open times for a list of dates. A published session uses the calendar's
 * bounds (13:00 on a half day); a date the calendar cannot answer for gets
 * 09:30–16:00 — standing in for a vendor that sent bars anyway, which is
 * exactly the case the engine must refuse to compute a level from.
 */
export function sessionTimes(tf: BarTimeframe, dates: readonly string[]): { date: string; times: number[] }[] {
  const step = TIMEFRAME_MS[tf];
  const out: { date: string; times: number[] }[] = [];
  for (const date of dates) {
    const s = regularSessionInstants(date);
    let open: number, close: number;
    if (s.ok) { open = s.open; close = s.close; }
    else if (sessionOn(date).kind === 'UNKNOWN') { open = et(date, 9, 30); close = et(date, 16, 0); }
    else continue;
    const times: number[] = [];
    for (let t = open; t + step <= close; t += step) times.push(t);
    out.push({ date, times });
  }
  return out;
}

export interface WalkOptions {
  symbols: readonly string[];
  tf: BarTimeframe;
  dates: readonly string[];
  seed: number;
  starts: readonly number[];
  /** Probability that any one bar is missing from a symbol's series. */
  dropProb?: number;
  /** Share of the first symbol's shock each other symbol carries. */
  beta?: number;
}

/**
 * Correlated random walks, one series per symbol, on the same session clock.
 * Prices are rounded to cents so equal highs and lows occur, and an
 * occasional fourfold shock makes displacements, gaps and breaks appear.
 */
export function randomWalks(opts: WalkOptions): Bar[][] {
  const rng = mulberry32(opts.seed);
  const step = TIMEFRAME_MS[opts.tf];
  const beta = opts.beta === undefined ? 0.8 : opts.beta;
  const drop = opts.dropProb === undefined ? 0 : opts.dropProb;
  const shock = () => (rng() + rng() + rng() + rng() - 2) * 0.0012 * (rng() < 0.05 ? 4 : 1);
  const prices = [...opts.starts];
  const out: Bar[][] = opts.symbols.map(() => []);

  for (const { times } of sessionTimes(opts.tf, opts.dates)) {
    const overnight = shock() * 3;
    for (let s = 0; s < prices.length; s++) prices[s] = prices[s] * (1 + overnight * (s === 0 ? 1 : beta));
    for (const t of times) {
      const common = shock();
      opts.symbols.forEach((symbol, s) => {
        const z = s === 0 ? common : beta * common + (1 - beta) * shock();
        const o = round2(prices[s]);
        const c = round2(Math.max(1, o * (1 + z)));
        const h = round2(Math.max(o, c) + round2(rng() * o * 0.0008));
        const l = round2(Math.min(o, c) - round2(rng() * o * 0.0008));
        prices[s] = c;
        if (rng() < drop) return;
        out[s].push({ symbol, tf: opts.tf, tOpen: t, closedAt: t + step, o, h, l, c, v: Math.floor(rng() * 5000), source: 'seeded-walk' });
      });
    }
  }
  return out;
}

// ── The look-ahead guard ─────────────────────────────────────────────────────

export interface Known { id: string; knownAt: number; evidence: { closedAt: number }[] }

/**
 * Feed the series one close at a time. At each step, re-run on the bars closed
 * by then and require EXACTLY the batch result restricted to events known by
 * then — same events, same `knownAt`, same everything. A detector that
 * back-dates an event, or that needs a bar it has not seen, cannot pass this.
 *
 * `run(asOf)` must call the detector on the bars whose `closedAt <= asOf`.
 */
export function assertPrefixStable<T extends Known>(
  label: string,
  closes: readonly number[],
  run: (asOf: number) => readonly T[],
): T[] {
  const timeline = [...new Set(closes)].sort((a, b) => a - b);
  assert.ok(timeline.length > 0, `${label}: no bars`);
  const canon = (xs: readonly T[]) => [...xs].sort((a, b) => a.knownAt - b.knownAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const batch = canon(run(timeline[timeline.length - 1]));
  for (const asOf of timeline) {
    const prefix = canon(run(asOf));
    for (const e of prefix) {
      assert.ok(e.knownAt <= asOf, `${label}: ${e.id} is known at ${e.knownAt}, after the last close ${asOf}`);
    }
    assert.deepStrictEqual(prefix, batch.filter((e) => e.knownAt <= asOf),
      `${label}: the run on bars closed by ${asOf} differs from the batch run truncated there`);
  }
  assertNotBackDated(label, batch);
  return batch;
}

/** No event's `knownAt` precedes the close of any bar it cites, and ids are unique. */
export function assertNotBackDated(label: string, events: readonly Known[]): void {
  const ids = new Set<string>();
  for (const e of events) {
    assert.ok(!ids.has(e.id), `${label}: duplicate event id ${e.id}`);
    ids.add(e.id);
    assert.ok(e.evidence.length > 0, `${label}: ${e.id} cites no bar`);
    for (const r of e.evidence) {
      assert.ok(r.closedAt <= e.knownAt, `${label}: ${e.id} is known at ${e.knownAt} but cites a bar closing at ${r.closedAt}`);
    }
  }
}

/**
 * A swing given explicitly — pivot bar, confirming bar, price — so a test can
 * isolate one rule of a consumer without also re-deriving the pivots.
 */
export function swingAt(
  bars: readonly Bar[], kind: SwingEvent['kind'], pivot: number, confirm: number, price: number,
): SwingEvent {
  return {
    id: `${kind}:${barId(bars[pivot])}`,
    kind, symbol: bars[pivot].symbol, tf: bars[pivot].tf, price,
    knownAt: bars[confirm].closedAt,
    methodVersion: STRUCTURE_METHOD_VERSION,
    evidence: bars.slice(pivot, confirm + 1).map(refOf),
    pivot: refOf(bars[pivot]),
    confirmedBy: refOf(bars[confirm]),
  };
}

/** Bars of one or more series closed by `asOf`. */
export const closedBy = (bars: readonly Bar[], asOf: number): Bar[] => bars.filter((b) => b.closedAt <= asOf);
