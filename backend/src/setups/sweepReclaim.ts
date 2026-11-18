/**
 * SWEEP AND RECLAIM (long) and its mirror SELL THE RIP (short), as a state
 * machine over closed bars and structure-engine events.
 *
 * **These definitions are proposed interpretations of the God's Plan playbook,
 * not confirmed rules and not evidence of an edge.** They are written down so
 * they can be tested and versioned (`SETUP_RULES_VERSION`); nothing here has
 * been measured against market data.
 *
 * Definitions (LONG; SHORT mirrors every comparison):
 * - **Idea.** One per (symbol, side, swept level). Its id is a sha256 of the
 *   setup method version, symbol, side and the structure level id, so a second
 *   sweep of the same level is the same idea.
 * - **Liquidity event.** A structure `SWEEP_RECLAIM` of a LOW-side level: price
 *   traded below the level and a later bar CLOSED back above it. A wick that
 *   never closes back inside (`WICK_NO_RECLAIM`) and a close beyond
 *   (`ACCEPTED_BEYOND`) start nothing.
 * - **Context.** The latest `DEALING_RANGE` known at the sweep. None, or a
 *   `RANGE_UNMEASURABLE`, blocks (`MIDRANGE_COMPRESSION`, unmeasurable). A range
 *   narrower than `minRangeFraction` of its EQ is compression and blocks. The
 *   reclaim close must sit in DISCOUNT or below the range; EQUILIBRIUM or the
 *   premium half is midrange and blocks.
 * - **Invalidation is fixed at the liquidity event, before any entry:** the
 *   sweep's extreme. A later bar trading strictly below it before the trigger
 *   INVALIDATES the idea. Terminal states never revert.
 * - **Displacement.** A structure `DISPLACEMENT` with direction BULL, known at or
 *   after the sweep and within `displacementWindowBars` series bars of it, or the
 *   idea EXPIRES (`NO_DISPLACEMENT`).
 * - **Retest zone.** The first bullish `FVG_FORMED` known at or after the sweep
 *   and no later than the bar on which displacement was confirmed. None by then
 *   → EXPIRED (`NO_RETEST`).
 * - **No first-touch entry.** A bar that trades into the zone (low ≤ top) only
 *   marks the touch. The trigger is a LATER bar that CLOSES above the zone's top.
 * - **Expiry.** No trigger within `expiryBars` series bars of the sweep →
 *   EXPIRED; a trigger on a later bar is not taken.
 * - **Gates at the trigger, all evaluated, none skipped:**
 *   - `NO_SMT`: only SPY and QQQ have an approved pair (each other). Any other
 *     symbol is BLOCKED. For SPY/QQQ an `SMT_DIVERGENCE` on the swept side
 *     (LOW for a long) must be known by the trigger and no more than
 *     `smtMaxAgeMinutes` before the sweep. Absent, only unmeasurable, stale, or
 *     followed by a divergence on the opposing side → FAIL.
 *   - `REWARD_UNDER_2R`: entry is the trigger close, stop is the invalidation,
 *     target is the nearest named opposing external level above entry known by
 *     the trigger (a COMPLETE `PDH`, or the dealing range high). Costs are a
 *     round-trip per-unit price amount supplied by the caller and have no
 *     default; missing costs FAIL. Net R = (target − entry − cost) /
 *     (entry − stop + cost) must be at least `minNetR`.
 *   - `ONE_ATTEMPT_ALREADY_USED`: the attempt ledger passed in (and returned)
 *     already holds an ACTIONABLE attempt for this idea.
 *   Every gate PASS → ACTIONABLE. Any FAIL or UNMEASURABLE → BLOCKED with every
 *   failing gate as a machine-readable reason. There is no score.
 * - **Completed.** After ACTIONABLE, the first later bar that trades through the
 *   stop or the target. Which one is deliberately not recorded: this engine
 *   emits signal events, not outcomes.
 *
 * **Time.** Pure and clock-free. Bars are walked in order; on each bar only
 * events with `knownAt` at or before that bar's close are visible, and every
 * transition is stamped with that bar's close and cites it. Nothing transitions
 * before its evidence was knowable.
 */
import { createHash } from 'node:crypto';
import { Bar, barId } from '../market/bar';
import type { StructureEvent } from '../structure';
import type { SweepEvent } from '../structure/sweep';
import type { DisplacementEvent } from '../structure/displacement';
import type { FvgEvent } from '../structure/fvg';
import type { RangeEvent } from '../structure/range';
import type { SessionLevelEvent } from '../structure/levels';
import type { SmtEvent } from '../structure/smt';
import { SetupParams, DEFAULT_SETUP_PARAMS, setupMethodVersionOf } from './params';

export type SetupState =
  | 'OBSERVING' | 'CONTEXT_READY' | 'LIQUIDITY_EVENT_CONFIRMED' | 'DISPLACEMENT_CONFIRMED'
  | 'RETEST_PENDING' | 'TRIGGER_CONFIRMED' | 'ACTIONABLE'
  | 'INVALIDATED' | 'EXPIRED' | 'COMPLETED' | 'BLOCKED';

export const TERMINAL_STATES: readonly SetupState[] = ['INVALIDATED', 'EXPIRED', 'COMPLETED', 'BLOCKED'];

/**
 * The blocker codes this engine emits. Every one is a code of the trade
 * ticket's vocabulary (`frontend/lib/tradeTicket.ts`); `setupBlockerCodes.test.ts`
 * holds them to it, so there is no second vocabulary.
 */
export const SETUP_BLOCKER_CODES = [
  'NO_SMT', 'MIDRANGE_COMPRESSION', 'NO_DISPLACEMENT', 'NO_RETEST',
  'REWARD_UNDER_2R', 'ONE_ATTEMPT_ALREADY_USED',
] as const;
export type SetupBlockerCode = typeof SETUP_BLOCKER_CODES[number];

export type SetupSide = 'LONG' | 'SHORT';
export type GateStatus = 'PASS' | 'FAIL' | 'UNMEASURABLE';
export interface GateResult { code: SetupBlockerCode; status: GateStatus; detail: string }
export interface SetupReason { code: SetupBlockerCode; detail: string }

export interface SetupTransition {
  state: SetupState;
  /** The close of the cited bar: when this transition became knowable. */
  knownAt: number;
  bar: string;
  /** Structure event ids this transition relied on. */
  events: string[];
  reasons: SetupReason[];
  gates?: GateResult[];
}

export interface SetupIdea {
  ideaId: string;
  setup: 'SWEEP_AND_RECLAIM' | 'SELL_THE_RIP';
  side: SetupSide;
  symbol: string;
  levelId: string;
  sweepId: string;
  invalidation: number;
  entry: number | null;
  target: { name: string; price: number } | null;
  netR: number | null;
  history: SetupTransition[];
}

export interface Costs {
  /** Round-trip cost per unit in price terms (commissions + slippage). Required. */
  roundTripPerUnit: number;
}

export interface AttemptLedger {
  version: 1;
  /** ideaId → the knownAt of the ACTIONABLE transition that used the attempt. */
  used: Record<string, number>;
}

export const EMPTY_LEDGER: AttemptLedger = Object.freeze({ version: 1 as const, used: Object.freeze({}) as Record<string, number> });

export interface MachineInput {
  symbol: string;
  bars: readonly Bar[];
  /** Structure events for `symbol` (and SMT events against its pair). */
  events: readonly StructureEvent[];
  /** The SMT pair actually supplied, or null. */
  pairSymbol: string | null;
  costs: Costs | null;
  ledger: AttemptLedger;
  params?: SetupParams;
  structureMethodVersion?: string;
}

export interface MachineResult {
  methodVersion: string;
  ideas: SetupIdea[];
  ledger: AttemptLedger;
}

/** The only SMT pairs this playbook approves. */
export const APPROVED_SMT_PAIRS: Readonly<Record<string, string>> = Object.freeze({ SPY: 'QQQ', QQQ: 'SPY' });

const MINUTE = 60_000;

interface Live {
  idea: SetupIdea;
  sweep: SweepEvent;
  sweepIdx: number;
  state: SetupState;
  displacement: DisplacementEvent | null;
  displacementIdx: number;
  zone: FvgEvent | null;
  touchIdx: number;
  stop: number;
}

function hash(x: unknown): string {
  return createHash('sha256').update(JSON.stringify(x)).digest('hex');
}

export function costRefusals(c: Costs | null): string[] {
  if (c === null) return ['costs were not supplied; there is no default'];
  if (!(Number.isFinite(c.roundTripPerUnit) && c.roundTripPerUnit >= 0)) {
    return [`roundTripPerUnit must be a finite non-negative number, got ${c.roundTripPerUnit}`];
  }
  return [];
}

export function runSweepReclaim(input: MachineInput): MachineResult {
  const params = input.params ?? DEFAULT_SETUP_PARAMS;
  const methodVersion = setupMethodVersionOf(params, input.structureMethodVersion);
  const bars = input.bars;
  const events = [...input.events].sort((a, b) => a.knownAt - b.knownAt);
  const used: Record<string, number> = { ...input.ledger.used };
  const ideas: SetupIdea[] = [];
  const live: Live[] = [];
  let cursor = 0;
  const visible: StructureEvent[] = [];

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    const fresh: StructureEvent[] = [];
    while (cursor < events.length && events[cursor].knownAt <= bar.closedAt) {
      visible.push(events[cursor]);
      fresh.push(events[cursor]);
      cursor++;
    }

    // Step existing ideas on this bar before creating new ones from it.
    for (const L of live) {
      if (TERMINAL_STATES.includes(L.state)) continue;
      step(L, i);
    }

    for (const e of fresh) {
      if (e.kind !== 'SWEEP_RECLAIM' || e.symbol !== input.symbol) continue;
      const sweep = e as SweepEvent;
      const side: SetupSide = sweep.side === 'LOW' ? 'LONG' : 'SHORT';
      const ideaId = hash({ methodVersion, symbol: input.symbol, side, level: sweep.level.id });
      const idea: SetupIdea = {
        ideaId,
        setup: side === 'LONG' ? 'SWEEP_AND_RECLAIM' : 'SELL_THE_RIP',
        side, symbol: input.symbol, levelId: sweep.level.id, sweepId: sweep.id,
        invalidation: sweep.extreme, entry: null, target: null, netR: null,
        history: [{ state: 'OBSERVING', knownAt: bar.closedAt, bar: barId(bar), events: [], reasons: [] }],
      };
      ideas.push(idea);
      const L: Live = {
        idea, sweep, sweepIdx: i, state: 'OBSERVING',
        displacement: null, displacementIdx: -1, zone: null, touchIdx: -1, stop: sweep.extreme,
      };
      live.push(L);
      context(L, i);
      if (!TERMINAL_STATES.includes(L.state)) progress(L, i);
    }
  }

  return { methodVersion, ideas, ledger: { version: 1, used } };

  // ── helpers (closures over this run) ─────────────────────────────────────

  function go(L: Live, i: number, state: SetupState, evIds: string[], reasons: SetupReason[] = [], gates?: GateResult[]) {
    L.state = state;
    const t: SetupTransition = { state, knownAt: bars[i].closedAt, bar: barId(bars[i]), events: evIds, reasons };
    if (gates) t.gates = gates;
    L.idea.history.push(t);
  }

  function long(L: Live) { return L.idea.side === 'LONG'; }

  function latestRange(t: number): StructureEvent | undefined {
    let r: StructureEvent | undefined;
    for (const e of visible) {
      if (e.knownAt > t) break;
      if (e.symbol === input.symbol && (e.kind === 'DEALING_RANGE' || e.kind === 'RANGE_UNMEASURABLE')) r = e;
    }
    return r;
  }

  function context(L: Live, i: number) {
    const r = latestRange(L.sweep.knownAt);
    if (r === undefined || r.kind !== 'DEALING_RANGE') {
      go(L, i, 'BLOCKED', [L.sweep.id], [{ code: 'MIDRANGE_COMPRESSION', detail: 'no measurable dealing range was known at the sweep' }]);
      return;
    }
    const range = r as RangeEvent;
    const close = bars[i].c;
    const width = range.high.price - range.low.price;
    if (width < params.minRangeFraction * range.eq) {
      go(L, i, 'BLOCKED', [L.sweep.id, range.id], [{ code: 'MIDRANGE_COMPRESSION', detail: `range width ${width} is under ${params.minRangeFraction} of EQ ${range.eq}: compression` }]);
      return;
    }
    const ok = long(L) ? close < range.eq : close > range.eq;
    if (!ok) {
      go(L, i, 'BLOCKED', [L.sweep.id, range.id], [{ code: 'MIDRANGE_COMPRESSION', detail: `reclaim close ${close} is not in the ${long(L) ? 'discount' : 'premium'} half of the range (EQ ${range.eq})` }]);
      return;
    }
    go(L, i, 'CONTEXT_READY', [range.id]);
    go(L, i, 'LIQUIDITY_EVENT_CONFIRMED', [L.sweep.id]);
  }

  function step(L: Live, i: number) {
    const bar = bars[i];
    if (L.state === 'ACTIONABLE') {
      const tgt = L.idea.target as { price: number };
      const hit = long(L) ? (bar.l <= L.stop || bar.h >= tgt.price) : (bar.h >= L.stop || bar.l <= tgt.price);
      if (hit) go(L, i, 'COMPLETED', []);
      return;
    }
    const broke = long(L) ? bar.l < L.stop : bar.h > L.stop;
    if (broke) {
      go(L, i, 'INVALIDATED', [L.sweep.id]);
      return;
    }
    if (i - L.sweepIdx > params.expiryBars) {
      go(L, i, 'EXPIRED', [], [{ code: 'NO_RETEST', detail: `no trigger within ${params.expiryBars} bars of the sweep` }]);
      return;
    }
    progress(L, i);
  }

  function progress(L: Live, i: number) {
    const bar = bars[i];
    if (L.state === 'LIQUIDITY_EVENT_CONFIRMED') {
      const want = long(L) ? 'BULL' : 'BEAR';
      const d = visible.find((e) => e.kind === 'DISPLACEMENT' && e.symbol === input.symbol
        && (e as DisplacementEvent).direction === want && e.knownAt >= L.sweep.knownAt) as DisplacementEvent | undefined;
      if (d === undefined) {
        if (i - L.sweepIdx >= params.displacementWindowBars) {
          go(L, i, 'EXPIRED', [L.sweep.id], [{ code: 'NO_DISPLACEMENT', detail: `no ${want} displacement within ${params.displacementWindowBars} bars of the sweep` }]);
        }
        return;
      }
      L.displacement = d;
      L.displacementIdx = i;
      go(L, i, 'DISPLACEMENT_CONFIRMED', [d.id]);
    }
    if (L.state === 'DISPLACEMENT_CONFIRMED') {
      const want = long(L) ? 'BULLISH' : 'BEARISH';
      const z = visible.find((e) => e.kind === 'FVG_FORMED' && e.symbol === input.symbol
        && (e as FvgEvent).direction === want && e.knownAt >= L.sweep.knownAt
        && e.knownAt <= bars[L.displacementIdx].closedAt) as FvgEvent | undefined;
      if (z === undefined) {
        go(L, i, 'EXPIRED', [], [{ code: 'NO_RETEST', detail: `no ${want} fair-value gap formed by the displacement` }]);
        return;
      }
      L.zone = z;
      go(L, i, 'RETEST_PENDING', [z.id]);
      return; // the bar that confirmed the zone cannot also be its touch
    }
    if (L.state === 'RETEST_PENDING') {
      const z = L.zone as FvgEvent;
      if (L.touchIdx < 0) {
        const touched = long(L) ? bar.l <= z.top : bar.h >= z.bottom;
        if (touched && bar.closedAt > z.knownAt) L.touchIdx = i;
        return;
      }
      if (i <= L.touchIdx) return;
      const closed = long(L) ? bar.c > z.top : bar.c < z.bottom;
      if (!closed) return;
      go(L, i, 'TRIGGER_CONFIRMED', [z.id]);
      gate(L, i);
    }
  }

  function gate(L: Live, i: number) {
    const bar = bars[i];
    const entry = bar.c;
    L.idea.entry = entry;
    const gates: GateResult[] = [smtGate(L, bar.closedAt), rewardGate(L, entry, bar.closedAt), ledgerGate(L)];
    const failed = gates.filter((g) => g.status !== 'PASS');
    if (failed.length > 0) {
      go(L, i, 'BLOCKED', [], failed.map((g) => ({ code: g.code, detail: g.detail })), gates);
      return;
    }
    used[L.idea.ideaId] = bar.closedAt;
    go(L, i, 'ACTIONABLE', [], [], gates);
  }

  function smtGate(L: Live, t: number): GateResult {
    const pair = APPROVED_SMT_PAIRS[input.symbol];
    if (pair === undefined) return { code: 'NO_SMT', status: 'FAIL', detail: `${input.symbol} has no approved SMT pair` };
    if (input.pairSymbol !== pair) return { code: 'NO_SMT', status: 'FAIL', detail: `SMT pair ${pair} was not supplied` };
    const side = long(L) ? 'LOW' : 'HIGH';
    const opp = long(L) ? 'HIGH' : 'LOW';
    const since = L.sweep.knownAt - params.smtMaxAgeMinutes * MINUTE;
    const smt = visible.filter((e) => (e.kind === 'SMT_DIVERGENCE' || e.kind === 'SMT_UNMEASURABLE') && e.knownAt <= t) as SmtEvent[];
    const div = smt.filter((e) => e.kind === 'SMT_DIVERGENCE' && e.side === side);
    if (div.length === 0) {
      const um = smt.some((e) => e.kind === 'SMT_UNMEASURABLE' && e.side === side && e.knownAt >= since);
      return { code: 'NO_SMT', status: um ? 'UNMEASURABLE' : 'FAIL', detail: um ? 'SMT on the swept side was unmeasurable (pivots not aligned)' : 'no SMT divergence on the swept side' };
    }
    const last = div[div.length - 1];
    if (last.knownAt < since) return { code: 'NO_SMT', status: 'FAIL', detail: `the latest ${side} SMT divergence is older than ${params.smtMaxAgeMinutes} minutes before the sweep` };
    const opposing = smt.some((e) => e.kind === 'SMT_DIVERGENCE' && e.side === opp && e.knownAt > last.knownAt);
    if (opposing) return { code: 'NO_SMT', status: 'FAIL', detail: `an opposing ${opp} SMT divergence followed` };
    return { code: 'NO_SMT', status: 'PASS', detail: `${side} SMT divergence ${last.id}` };
  }

  function rewardGate(L: Live, entry: number, t: number): GateResult {
    const cr = costRefusals(input.costs);
    if (cr.length > 0) return { code: 'REWARD_UNDER_2R', status: 'UNMEASURABLE', detail: cr.join('; ') };
    const cost = (input.costs as Costs).roundTripPerUnit;
    const above = long(L);
    const candidates: { name: string; price: number }[] = [];
    for (const e of visible) {
      if (e.knownAt > t || e.symbol !== input.symbol) continue;
      if (e.kind === 'SESSION_LEVEL') {
        const s = e as SessionLevelEvent;
        if (s.status === 'COMPLETE' && s.name === (above ? 'PDH' : 'PDL')) candidates.push({ name: s.name, price: s.price });
      }
    }
    const r = latestRange(t);
    if (r !== undefined && r.kind === 'DEALING_RANGE') {
      const rg = r as RangeEvent;
      candidates.push(above ? { name: 'RANGE_HIGH', price: rg.high.price } : { name: 'RANGE_LOW', price: rg.low.price });
    }
    const beyond = candidates.filter((c) => (above ? c.price > entry : c.price < entry))
      .sort((a, b) => (above ? a.price - b.price : b.price - a.price));
    if (beyond.length === 0) return { code: 'REWARD_UNDER_2R', status: 'UNMEASURABLE', detail: 'no named opposing external level beyond the entry' };
    const target = beyond[0];
    L.idea.target = target;
    const reward = (above ? target.price - entry : entry - target.price) - cost;
    const risk = (above ? entry - L.stop : L.stop - entry) + cost;
    if (!(risk > 0)) return { code: 'REWARD_UNDER_2R', status: 'UNMEASURABLE', detail: 'risk to the invalidation is not positive' };
    const netR = reward / risk;
    L.idea.netR = netR;
    if (netR < params.minNetR) return { code: 'REWARD_UNDER_2R', status: 'FAIL', detail: `net ${netR.toFixed(2)}R to ${target.name} ${target.price} is under ${params.minNetR}R` };
    return { code: 'REWARD_UNDER_2R', status: 'PASS', detail: `net ${netR.toFixed(2)}R to ${target.name} ${target.price}` };
  }

  function ledgerGate(L: Live): GateResult {
    const prior = used[L.idea.ideaId];
    if (prior !== undefined) return { code: 'ONE_ATTEMPT_ALREADY_USED', status: 'FAIL', detail: `this idea's attempt was used at ${new Date(prior).toISOString()}` };
    return { code: 'ONE_ATTEMPT_ALREADY_USED', status: 'PASS', detail: 'first attempt' };
  }
}
