/**
 * Replay outcome grading: which of target or invalidation the later bars
 * touched first, net of costs, with no rate below the sample floor.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Bar } from '../src/market/bar';
import type { SetupIdea } from '../src/setups/sweepReclaim';
import { gradeIdea, summariseOutcomes, IdeaOutcome } from '../src/research/setupOutcome';
import { runSetupReplay } from '../src/research/setupReplay';

const T0 = Date.parse('2026-01-05T15:00:00Z');
const M = 60_000;
type OHLC = [number, number, number, number];
const mk = (rows: OHLC[], skip: number[] = []): Bar[] => rows.map(([o, h, l, c], i) => ({ symbol: 'SPY', tf: '1m' as const, tOpen: T0 + i * M, closedAt: T0 + (i + 1) * M, o, h, l, c, v: null, source: 'test' }))
  .filter((_, i) => !skip.includes(i));

/** LONG idea: ACTIONABLE at the close of bar 1, entry 100, stop 98, target 106, net 2.5R. */
function idea(over: Partial<SetupIdea> = {}, actionableAt = T0 + 2 * M): SetupIdea {
  return {
    ideaId: 'i1', setup: 'SWEEP_AND_RECLAIM', side: 'LONG', symbol: 'SPY', levelId: 'L', sweepId: 'S',
    invalidation: 98, entry: 100, target: { name: 'PDH', price: 106 }, netR: 2.5,
    history: [{ state: 'ACTIONABLE', knownAt: actionableAt, bar: 'b', events: [], reasons: [] }],
    ...over,
  };
}
const FLAT: OHLC = [100, 101, 99, 100];

test('target first is +netR and names the deciding bar', () => {
  const o = gradeIdea(idea(), mk([FLAT, FLAT, FLAT, [100, 106.5, 99.5, 106]]));
  assert.equal(o.state, 'TARGET_FIRST');
  assert.equal(o.r, 2.5);
  assert.equal(o.decidedAt, T0 + 4 * M);
  assert.equal(o.barsRead, 2);
});

test('stop first is -1R', () => {
  const o = gradeIdea(idea(), mk([FLAT, FLAT, [100, 100.5, 97.9, 98.2], [98, 107, 98, 106]]));
  assert.equal(o.state, 'STOP_FIRST');
  assert.equal(o.r, -1);
});

test('the trigger bar and earlier bars are never read', () => {
  // Bar 1 (the trigger bar, closes at the ACTIONABLE knownAt) and bar 0 touch the stop; later bars reach the target.
  const o = gradeIdea(idea(), mk([[100, 100, 97, 99], [99, 100, 97, 100], FLAT, [100, 107, 100, 106]]));
  assert.equal(o.state, 'TARGET_FIRST');
});

test('a bar touching both is AMBIGUOUS, never a win', () => {
  const o = gradeIdea(idea(), mk([FLAT, FLAT, [100, 107, 97, 101]]));
  assert.equal(o.state, 'AMBIGUOUS_SAME_BAR');
  assert.equal(o.r, null);
});

test('bars ending first is OPEN', () => {
  const o = gradeIdea(idea(), mk([FLAT, FLAT, FLAT, FLAT]));
  assert.equal(o.state, 'OPEN');
  assert.equal(o.r, null);
  assert.equal(o.barsRead, 2);
});

test('a gap inside the graded window is reported, not bridged', () => {
  const o = gradeIdea(idea(), mk([FLAT, FLAT, FLAT, FLAT, FLAT, [100, 107, 100, 106]], [3, 4]));
  assert.equal(o.state, 'TARGET_FIRST');
  assert.equal(o.gapMinutes, 2);
});

test('SHORT mirrors LONG', () => {
  const s = idea({ side: 'SHORT', invalidation: 102, target: { name: 'PDL', price: 94 } });
  assert.equal(gradeIdea(s, mk([FLAT, FLAT, [100, 100.5, 93.9, 94]])).state, 'TARGET_FIRST');
  assert.equal(gradeIdea(s, mk([FLAT, FLAT, [100, 102, 99, 101]])).state, 'STOP_FIRST');
});

test('a non-ACTIONABLE idea, or one missing entry or target, is NOT_GRADED', () => {
  const bars = mk([FLAT, FLAT, [100, 107, 100, 106]]);
  const blocked = idea({ history: [{ state: 'BLOCKED', knownAt: T0 + 2 * M, bar: 'b', events: [], reasons: [] }] });
  assert.equal(gradeIdea(blocked, bars).state, 'NOT_GRADED');
  assert.equal(gradeIdea(idea({ target: null }), bars).state, 'NOT_GRADED');
  assert.equal(gradeIdea(idea({ netR: null }), bars).state, 'NOT_GRADED');
});

const o = (state: IdeaOutcome['state'], r: number | null): IdeaOutcome => ({ ideaId: 'x', state, r, decidedAt: null, barsRead: 0, gapMinutes: 0, detail: '' });

test('no rate below 30 decided ideas; ambiguous and open do not count toward the floor', () => {
  const below = [...Array(29).fill(0).map(() => o('TARGET_FIRST', 2)), ...Array(10).fill(0).map(() => o('AMBIGUOUS_SAME_BAR', null)), o('OPEN', null)];
  const s = summariseOutcomes(below);
  assert.equal(s.decided, 29);
  assert.equal(s.hitRate, null);
  assert.equal(s.meanR, null);
  assert.match(s.suppressed!, /INSUFFICIENT_SAMPLE/);
  assert.equal(s.byState.AMBIGUOUS_SAME_BAR, 10);
});

test('at 30 decided ideas the rate and mean R are published over decided ideas only', () => {
  const xs = [...Array(10).fill(0).map(() => o('TARGET_FIRST', 2.5)), ...Array(20).fill(0).map(() => o('STOP_FIRST', -1)), o('AMBIGUOUS_SAME_BAR', null)];
  const s = summariseOutcomes(xs);
  assert.equal(s.decided, 30);
  assert.equal(s.hitRate, 10 / 30);
  assert.equal(s.meanR, (25 - 20) / 30);
  assert.equal(s.suppressed, null);
});

test('on the fixture replay, every graded idea agrees with the engine\'s COMPLETED bar', () => {
  const FIX = join(__dirname, 'fixtures', 'bars');
  const r = runSetupReplay({
    config: JSON.parse(readFileSync(join(FIX, 'replay.config.json'), 'utf8')),
    csv: { SPY: readFileSync(join(FIX, 'SYNTHETIC_SPY_1m.csv'), 'utf8'), QQQ: readFileSync(join(FIX, 'SYNTHETIC_QQQ_1m.csv'), 'utf8') },
  });
  assert.equal(r.status, 'OK');
  if (r.status !== 'OK') return;
  const rep = r.report as any;
  const ideas = (rep.runs as any[]).flatMap((x) => x.ideas as SetupIdea[]);
  const byId = new Map((rep.outcomes.ideas as IdeaOutcome[]).map((x) => [x.ideaId, x]));
  for (const i of ideas) {
    const g = byId.get(i.ideaId);
    if (!i.history.some((h) => h.state === 'ACTIONABLE')) { assert.equal(g, undefined); continue; }
    assert.ok(g);
    const done = i.history.find((h) => h.state === 'COMPLETED');
    if (done) assert.equal(g.decidedAt, done.knownAt, `${i.ideaId}: grader and engine disagree on the deciding bar`);
  }
});

test('driven through the real state machine, the grader agrees with COMPLETED and grades the target', async () => {
  const { runSweepReclaim, EMPTY_LEDGER } = await import('../src/setups/sweepReclaim');
  const { DEFAULT_SETUP_PARAMS } = await import('../src/setups/params');
  const at = (i: number) => T0 + (i + 1) * M;
  const ev = (x: Record<string, unknown>) => ({ tf: '1m', methodVersion: 'test', evidence: [], symbol: 'SPY', ...x }) as any;
  const rows: OHLC[] = [[95, 96, 94, 95], [94, 95, 93, 93.5], [91.5, 92.5, 91.2, 92.4], [92.4, 95, 92.3, 94.8],
    [94, 94, 93.2, 93.8], [93.8, 94.2, 93.6, 94.0], [94, 95, 93.7, 94.5], [94.5, 108.5, 94, 108], [108, 109, 107, 108]];
  const bars = mk(rows);
  const events = [
    ev({ id: 'R1', kind: 'DEALING_RANGE', knownAt: at(0), high: { price: 110 }, low: { price: 90 }, eq: 100 }),
    ev({ id: 'PDH1', kind: 'SESSION_LEVEL', knownAt: at(0), name: 'PDH', status: 'COMPLETE', price: 108 }),
    ev({ id: 'SMT1', kind: 'SMT_DIVERGENCE', knownAt: at(1), side: 'LOW' }),
    ev({ id: 'SW1', kind: 'SWEEP_RECLAIM', knownAt: at(2), side: 'LOW', level: { id: 'L1', price: 92 }, extreme: 91, excursion: { closedAt: at(2) } }),
    ev({ id: 'D1', kind: 'DISPLACEMENT', knownAt: at(3), direction: 'BULL' }),
    ev({ id: 'F1', kind: 'FVG_FORMED', knownAt: at(3), direction: 'BULLISH', top: 93.5, bottom: 92.6 }),
  ];
  const res = runSweepReclaim({ symbol: 'SPY', bars, events, pairSymbol: 'QQQ', costs: { roundTripPerUnit: 0.05 }, ledger: EMPTY_LEDGER, params: { ...DEFAULT_SETUP_PARAMS } });
  const i = res.ideas[0]!;
  const done = i.history.find((h) => h.state === 'COMPLETED')!;
  const g = gradeIdea(i, bars);
  assert.equal(g.state, 'TARGET_FIRST');
  assert.equal(g.decidedAt, done.knownAt);
  assert.equal(g.r, i.netR);
  assert.ok(g.r! >= 2, 'the gate passed it, so its net R is at least 2');
});

test('missing bars straight after ACTIONABLE are counted as a gap (audit 2026-11-18)', () => {
  // ACTIONABLE at T0+2M; bars 2 and 3 are missing, so the first graded bar opens at T0+4M.
  const o = gradeIdea(idea(), mk([FLAT, FLAT, FLAT, FLAT, [100, 106.5, 99.5, 106]], [2, 3]));
  assert.equal(o.state, 'TARGET_FIRST');
  assert.equal(o.gapMinutes, 2);
});
