/**
 * The Sweep-and-Reclaim / Sell-the-Rip state machine, driven by hand-built
 * structure events over hand-built bars, so each gate can be set to exactly
 * the case under test. `setupLookahead.test.ts` drives the same machine through
 * the real structure engine.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Bar } from '../src/market/bar';
import type { StructureEvent } from '../src/structure';
import {
  AttemptLedger, Costs, EMPTY_LEDGER, MachineResult, SetupIdea, TERMINAL_STATES, runSweepReclaim,
} from '../src/setups/sweepReclaim';
import { DEFAULT_SETUP_PARAMS, SetupParams } from '../src/setups/params';

const T0 = Date.parse('2026-01-05T15:00:00Z');
const M = 60_000;
type OHLC = [number, number, number, number];

function mk(symbol: string, rows: OHLC[]): Bar[] {
  return rows.map(([o, h, l, c], i) => ({ symbol, tf: '1m', tOpen: T0 + i * M, closedAt: T0 + (i + 1) * M, o, h, l, c, v: null, source: 'test' }));
}
const at = (i: number) => T0 + (i + 1) * M;
const ev = (x: Record<string, unknown>) => ({ tf: '1m', methodVersion: 'test', evidence: [], ...x }) as unknown as StructureEvent;

/** The valid LONG progression. Index comments are bar indices. */
const BASE: OHLC[] = [
  [95, 96, 94, 95],          // 0
  [94, 95, 93, 93.5],        // 1
  [91.5, 92.5, 91.2, 92.4],  // 2 sweep reclaim close
  [92.4, 95, 92.3, 94.8],    // 3 displacement + FVG
  [94, 94, 93.2, 93.8],      // 4 first touch (closes above top: not an entry)
  [93.8, 94.2, 93.6, 94.0],  // 5 trigger
  [94, 95, 93.7, 94.5],      // 6
  [94.5, 108.5, 94, 108],    // 7 trades through the target
  [108, 109, 107, 108],      // 8
  [108, 109, 107, 108],      // 9
];

interface Opts {
  symbol?: string; rows?: OHLC[]; costs?: Costs | null; ledger?: AttemptLedger;
  params?: Partial<SetupParams>; pairSymbol?: string | null;
  drop?: string[]; extra?: StructureEvent[]; range?: { high: number; low: number }; pdh?: number;
}

function scenario(o: Opts = {}) {
  const symbol = o.symbol ?? 'SPY';
  const r = o.range ?? { high: 110, low: 90 };
  const all: Record<string, StructureEvent> = {
    range: ev({ id: 'R1', kind: 'DEALING_RANGE', symbol, knownAt: at(0), high: { price: r.high }, low: { price: r.low }, eq: (r.high + r.low) / 2 }),
    pdh: ev({ id: 'PDH1', kind: 'SESSION_LEVEL', symbol, knownAt: at(0), name: 'PDH', status: 'COMPLETE', price: o.pdh ?? 108 }),
    smt: ev({ id: 'SMT1', kind: 'SMT_DIVERGENCE', symbol, knownAt: at(1), side: 'LOW' }),
    sweep: ev({ id: 'SW1', kind: 'SWEEP_RECLAIM', symbol, knownAt: at(2), side: 'LOW', level: { id: 'L1', price: 92 }, extreme: 91, excursion: { closedAt: at(2) } }),
    disp: ev({ id: 'D1', kind: 'DISPLACEMENT', symbol, knownAt: at(3), direction: 'BULL' }),
    fvg: ev({ id: 'F1', kind: 'FVG_FORMED', symbol, knownAt: at(3), direction: 'BULLISH', top: 93.5, bottom: 92.6 }),
  };
  for (const k of o.drop ?? []) delete all[k];
  const events = [...Object.values(all), ...(o.extra ?? [])];
  const bars = mk(symbol, o.rows ?? BASE);
  const res = runSweepReclaim({
    symbol, bars, events, pairSymbol: o.pairSymbol === undefined ? (symbol === 'SPY' ? 'QQQ' : symbol === 'QQQ' ? 'SPY' : null) : o.pairSymbol,
    costs: o.costs === undefined ? { roundTripPerUnit: 0.05 } : o.costs,
    ledger: o.ledger ?? EMPTY_LEDGER,
    params: { ...DEFAULT_SETUP_PARAMS, ...(o.params ?? {}) },
  });
  return { res, bars, events };
}

const states = (i: SetupIdea) => i.history.map((h) => h.state);
const last = (i: SetupIdea) => i.history[i.history.length - 1];
const only = (r: MachineResult) => { assert.equal(r.ideas.length, 1); return r.ideas[0]; };

test('valid progression reaches ACTIONABLE on the later closing bar, then COMPLETED', () => {
  const { res } = scenario();
  const idea = only(res);
  assert.deepEqual(states(idea), [
    'OBSERVING', 'CONTEXT_READY', 'LIQUIDITY_EVENT_CONFIRMED', 'DISPLACEMENT_CONFIRMED', 'RETEST_PENDING',
    'TRIGGER_CONFIRMED', 'ACTIONABLE', 'COMPLETED',
  ]);
  const trig = idea.history.find((h) => h.state === 'TRIGGER_CONFIRMED')!;
  assert.equal(trig.knownAt, at(5), 'the first-touch bar (4) is never the entry');
  assert.equal(idea.entry, 94);
  assert.equal(idea.invalidation, 91, 'invalidation is the sweep extreme, fixed before entry');
  assert.deepEqual(idea.target, { name: 'PDH', price: 108 });
  assert.equal(idea.setup, 'SWEEP_AND_RECLAIM');
  assert.ok(res.ledger.used[idea.ideaId] === at(5));
});

test('missing SMT blocks with NO_SMT', () => {
  const idea = only(scenario({ drop: ['smt'] }).res);
  assert.equal(last(idea).state, 'BLOCKED');
  assert.deepEqual(last(idea).reasons.map((r) => r.code), ['NO_SMT']);
});

test('a symbol with no approved pair is BLOCKED even with SMT present', () => {
  const idea = only(scenario({ symbol: 'IWM' }).res);
  assert.equal(last(idea).state, 'BLOCKED');
  assert.match(last(idea).reasons[0].detail, /no approved SMT pair/);
});

test('an SMT pair that was not supplied blocks', () => {
  const idea = only(scenario({ pairSymbol: null }).res);
  assert.deepEqual(last(idea).reasons.map((r) => r.code), ['NO_SMT']);
});

test('stale SMT and opposing SMT both block', () => {
  const stale = ev({ id: 'SMT0', kind: 'SMT_DIVERGENCE', symbol: 'SPY', knownAt: at(2) - 31 * M, side: 'LOW' });
  const a = only(scenario({ drop: ['smt'], extra: [stale] }).res);
  assert.match(last(a).reasons[0].detail, /older than/);
  const opp = ev({ id: 'SMT2', kind: 'SMT_DIVERGENCE', symbol: 'SPY', knownAt: at(4), side: 'HIGH' });
  const b = only(scenario({ extra: [opp] }).res);
  assert.match(last(b).reasons[0].detail, /opposing/);
});

test('unaligned SMT (only unmeasurable) blocks as UNMEASURABLE', () => {
  const um = ev({ id: 'SMTU', kind: 'SMT_UNMEASURABLE', symbol: 'SPY', knownAt: at(1), side: 'LOW' });
  const idea = only(scenario({ drop: ['smt'], extra: [um] }).res);
  assert.equal(last(idea).state, 'BLOCKED');
  assert.equal(last(idea).gates!.find((g) => g.code === 'NO_SMT')!.status, 'UNMEASURABLE');
});

test('midrange, compression and no range each block at the sweep', () => {
  for (const o of [{ range: { high: 100, low: 80 } }, { range: { high: 100.1, low: 100 } }, { drop: ['range'] }] as Opts[]) {
    const idea = only(scenario(o).res);
    assert.deepEqual(states(idea), ['OBSERVING', 'BLOCKED']);
    assert.equal(last(idea).reasons[0].code, 'MIDRANGE_COMPRESSION');
  }
});

test('invalidation before the trigger is terminal and never reverts', () => {
  const rows = BASE.map((r) => [...r] as OHLC);
  rows[4] = [94, 94, 90.5, 93.8];
  const idea = only(scenario({ rows }).res);
  assert.equal(last(idea).state, 'INVALIDATED');
  assert.equal(last(idea).knownAt, at(4));
  const terminals = idea.history.filter((h) => TERMINAL_STATES.includes(h.state));
  assert.equal(terminals.length, 1, 'exactly one terminal transition, and it is the last');
});

test('a trigger after expiry is not taken', () => {
  const idea = only(scenario({ params: { expiryBars: 2 } }).res);
  assert.equal(last(idea).state, 'EXPIRED');
  assert.ok(!states(idea).includes('TRIGGER_CONFIRMED'));
});

test('no displacement expires with NO_DISPLACEMENT', () => {
  const idea = only(scenario({ drop: ['disp'] }).res);
  assert.equal(last(idea).state, 'EXPIRED');
  assert.equal(last(idea).reasons[0].code, 'NO_DISPLACEMENT');
});

test('under 2R net of costs blocks even when gross R is exactly 2', () => {
  // entry 94, stop 91, PDH 100: gross 6/3 = 2.00; net (6-0.05)/(3+0.05) < 2.
  const idea = only(scenario({ pdh: 100 }).res);
  assert.equal(last(idea).state, 'BLOCKED');
  assert.deepEqual(last(idea).reasons.map((r) => r.code), ['REWARD_UNDER_2R']);
  assert.ok(idea.netR! < 2);
});

test('missing costs block; there is no default cost', () => {
  const idea = only(scenario({ costs: null }).res);
  assert.equal(last(idea).state, 'BLOCKED');
  const g = last(idea).gates!.find((x) => x.code === 'REWARD_UNDER_2R')!;
  assert.equal(g.status, 'UNMEASURABLE');
  assert.match(g.detail, /no default/);
});

test('a second attempt at the same idea is blocked after a ledger round-trip', () => {
  const first = scenario().res;
  const ledger = JSON.parse(JSON.stringify(first.ledger)) as AttemptLedger;
  const second = only(scenario({ ledger }).res);
  assert.equal(second.ideaId, first.ideas[0].ideaId);
  assert.equal(last(second).state, 'BLOCKED');
  assert.deepEqual(last(second).reasons.map((r) => r.code), ['ONE_ATTEMPT_ALREADY_USED']);
});

test('a wick with no reclaim starts no idea', () => {
  const wick = ev({ id: 'W1', kind: 'WICK_NO_RECLAIM', symbol: 'SPY', knownAt: at(2), side: 'LOW', level: { id: 'L1', price: 92 }, extreme: 91 });
  const { res } = scenario({ drop: ['sweep'], extra: [wick] });
  assert.equal(res.ideas.length, 0);
});

test('every transition is stamped with its bar close and never precedes its evidence', () => {
  for (const o of [{}, { drop: ['smt'] }, { pdh: 100 }, { params: { expiryBars: 2 } }] as Opts[]) {
    const { res, bars, events } = scenario(o);
    const known = new Map(events.map((e) => [e.id, e.knownAt]));
    const closeOf = new Map(bars.map((b) => [`${b.symbol}:${b.tf}:${b.tOpen}`, b.closedAt]));
    for (const idea of res.ideas) {
      let prev = -Infinity;
      for (const h of idea.history) {
        assert.equal(h.knownAt, closeOf.get(h.bar));
        for (const id of h.events) assert.ok(h.knownAt >= (known.get(id) as number), `${h.state} cites ${id} before it was known`);
        assert.ok(h.knownAt >= prev);
        prev = h.knownAt;
      }
    }
  }
});

test('the SHORT mirror (Sell the Rip) progresses the same way', () => {
  const P = 200;
  const rows = BASE.map(([o, h, l, c]) => [P - o, P - l, P - h, P - c] as OHLC);
  const symbol = 'QQQ';
  const events = [
    ev({ id: 'R1', kind: 'DEALING_RANGE', symbol, knownAt: at(0), high: { price: P - 90 }, low: { price: P - 110 }, eq: P - 100 }),
    ev({ id: 'PDL1', kind: 'SESSION_LEVEL', symbol, knownAt: at(0), name: 'PDL', status: 'COMPLETE', price: P - 108 }),
    ev({ id: 'SMT1', kind: 'SMT_DIVERGENCE', symbol, knownAt: at(1), side: 'HIGH' }),
    ev({ id: 'SW1', kind: 'SWEEP_RECLAIM', symbol, knownAt: at(2), side: 'HIGH', level: { id: 'L1', price: P - 92 }, extreme: P - 91 }),
    ev({ id: 'D1', kind: 'DISPLACEMENT', symbol, knownAt: at(3), direction: 'BEAR' }),
    ev({ id: 'F1', kind: 'FVG_FORMED', symbol, knownAt: at(3), direction: 'BEARISH', top: P - 92.6, bottom: P - 93.5 }),
  ];
  const res = runSweepReclaim({ symbol, bars: mk(symbol, rows), events, pairSymbol: 'SPY', costs: { roundTripPerUnit: 0.05 }, ledger: EMPTY_LEDGER });
  const idea = only(res);
  assert.equal(idea.setup, 'SELL_THE_RIP');
  assert.deepEqual(states(idea).slice(-2), ['ACTIONABLE', 'COMPLETED']);
  assert.equal(idea.history.find((h) => h.state === 'TRIGGER_CONFIRMED')!.knownAt, at(5));
});

test('invariant: no ACTIONABLE carries a failed or unmeasurable gate, and every blocked reason is a gate that did not pass', () => {
  const variants: Opts[] = [{}, { drop: ['smt'] }, { symbol: 'IWM' }, { pdh: 100 }, { costs: null },
    { range: { high: 100, low: 80 } }, { params: { expiryBars: 2 } }];
  for (const o of variants) {
    for (const idea of scenario(o).res.ideas) {
      for (const h of idea.history) {
        if (h.state === 'ACTIONABLE') {
          assert.ok(h.gates && h.gates.length === 3);
          assert.ok(h.gates.every((g) => g.status === 'PASS'));
        }
        if (h.state === 'BLOCKED' && h.gates) {
          const notPass = h.gates.filter((g) => g.status !== 'PASS').map((g) => g.code);
          assert.deepEqual(h.reasons.map((r) => r.code), notPass);
        }
      }
    }
  }
});
