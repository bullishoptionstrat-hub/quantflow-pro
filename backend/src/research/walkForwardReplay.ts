/**
 * WALK-FORWARD REPLAY — the setup replay and the sensitivity grid, cut into
 * walk-forward folds (`walkForward.ts`).
 *
 * The replay runs once over the whole import, so structure that needs earlier
 * bars (prior-day levels, swings) is built the same way it is in a plain
 * replay; folds then decide which ideas count where. An idea belongs to a
 * window by its ACTIONABLE `knownAt` (the instant the idea existed), never by
 * its outcome time. An idea that is ACTIONABLE inside a test window but is
 * decided after that window ends is counted in `decidedAfterTestEnd`, because
 * its label reaches past the fold. Ideas in an embargo or outside every test
 * window are counted, not dropped.
 *
 * Nothing is fitted: the definitions are fixed, and in the grid every cell is
 * reported. Per window the counts are published always; a hit rate and its
 * Wilson interval only at `MIN_PUBLISHABLE_SAMPLE` decided ideas or more,
 * otherwise null with the reason. Not evidence of an edge.
 */
import { MIN_PUBLISHABLE_SAMPLE } from '../persistence/types';
import { runSensitivityGrid, gridCells } from './sensitivityGrid';
import { runSetupReplay } from './setupReplay';
import type { OutcomeState } from './setupOutcome';
import { walkForwardFolds, walkForwardRefusals, wilsonInterval, type Fold, type WalkForwardSpec } from './walkForward';
import type { Preregistration } from './preregistration';

export const WALK_FORWARD_REPLAY_VERSION = 'wf-replay/1';

export interface WindowSummary {
  byState: Record<OutcomeState, number>;
  decided: number;
  hitRate: number | null;
  wilson95: { low: number; high: number } | null;
  suppressed: string | null;
}

export type WfResult = { status: 'OK'; report: Record<string, unknown> } | { status: 'REFUSED'; reasons: string[] };

interface GradedRow { symbol: string; ideaId: string; state: OutcomeState; decidedAt: number | null }

function summarise(rows: readonly GradedRow[]): WindowSummary {
  const byState: Record<OutcomeState, number> = { TARGET_FIRST: 0, STOP_FIRST: 0, AMBIGUOUS_SAME_BAR: 0, OPEN: 0, NOT_GRADED: 0 };
  for (const r of rows) byState[r.state]++;
  const decided = byState.TARGET_FIRST + byState.STOP_FIRST;
  if (decided < MIN_PUBLISHABLE_SAMPLE) {
    return { byState, decided, hitRate: null, wilson95: null, suppressed: `INSUFFICIENT_SAMPLE: ${decided} decided ideas, ${MIN_PUBLISHABLE_SAMPLE} required` };
  }
  return { byState, decided, hitRate: byState.TARGET_FIRST / decided, wilson95: wilsonInterval(byState.TARGET_FIRST, decided), suppressed: null };
}

const inside = (t: number, a: number, b: number) => t >= a && t < b;

export function runWalkForwardReplay(input: { config: unknown; csv: Record<string, string>; spec: WalkForwardSpec }): WfResult {
  const sr = walkForwardRefusals(input.spec ?? ({} as WalkForwardSpec));
  if (sr.length > 0) return { status: 'REFUSED', reasons: sr.map((x) => `spec: ${x}`) };
  const folds = walkForwardFolds(input.spec);
  if (folds.length === 0) return { status: 'REFUSED', reasons: ['spec: the span is too short for one fold; no fold is shortened'] };
  const r = runSetupReplay({ config: input.config, csv: input.csv });
  if (r.status !== 'OK') return r;

  const actionableAt = new Map<string, number>();
  for (const run of r.report.runs as { symbol: string; ideas: { ideaId: string; history: { state: string; knownAt: number }[] }[] }[]) {
    for (const i of run.ideas) {
      const t = i.history.find((h) => h.state === 'ACTIONABLE');
      if (t !== undefined) actionableAt.set(`${run.symbol}|${i.ideaId}`, t.knownAt);
    }
  }
  const graded = ((r.report.outcomes as { ideas: GradedRow[] }).ideas).map((g) => ({ ...g, at: actionableAt.get(`${g.symbol}|${g.ideaId}`)! }));

  let outside = 0;
  for (const g of graded) if (!folds.some((f) => inside(g.at, f.testStartMs, f.testEndMs))) outside++;
  const oos: GradedRow[] = [];
  const perFold = folds.map((f: Fold) => {
    const test = graded.filter((g) => inside(g.at, f.testStartMs, f.testEndMs));
    const train = graded.filter((g) => inside(g.at, f.trainStartMs, f.trainEndMs));
    oos.push(...test);
    return {
      fold: f,
      train: summarise(train),
      test: summarise(test),
      decidedAfterTestEnd: test.filter((g) => g.decidedAt !== null && g.decidedAt >= f.testEndMs).length,
    };
  });

  return {
    status: 'OK',
    report: {
      kind: 'WALK_FORWARD_REPLAY',
      version: WALK_FORWARD_REPLAY_VERSION,
      spec: input.spec,
      configHash: r.report.configHash,
      setupMethodVersion: r.report.setupMethodVersion,
      structureMethodVersion: r.report.structureMethodVersion,
      paramsInForce: r.report.paramsInForce,
      folds: perFold,
      outOfSample: summarise(oos),
      gradedIdeas: graded.length,
      outsideEveryTestWindow: outside,
      minSample: MIN_PUBLISHABLE_SAMPLE,
      note: 'Ideas are placed by their ACTIONABLE knownAt. Nothing was fitted; a rate and Wilson interval appear only at the sample floor. Untuned definitions; not evidence of an edge.',
    },
  };
}

export function runWalkForwardGrid(input: { plan: unknown; config: unknown; csv: Record<string, string>; spec: WalkForwardSpec; nowMs: number }): WfResult {
  const g = runSensitivityGrid({ plan: input.plan, config: input.config, csv: input.csv, nowMs: input.nowMs });
  if (g.status !== 'OK') return g;
  const plan = input.plan as Preregistration;
  const cells: Record<string, unknown>[] = [];
  for (const params of gridCells(plan.grid as Record<string, number[]>)) {
    const r = runWalkForwardReplay({ config: { ...(input.config as object), params }, csv: input.csv, spec: input.spec });
    if (r.status !== 'OK') return { status: 'REFUSED', reasons: r.reasons.map((x) => `cell ${JSON.stringify(params)}: ${x}`) };
    cells.push({ params, outOfSample: r.report.outOfSample, folds: r.report.folds });
  }
  return {
    status: 'OK',
    report: {
      kind: 'WALK_FORWARD_GRID',
      version: WALK_FORWARD_REPLAY_VERSION,
      planId: plan.id,
      preregistrationHash: g.report.preregistrationHash,
      selectionRule: plan.selectionRule,
      spec: input.spec,
      cells,
      note: 'Every cell is reported in plan order; none is ranked or chosen. The holdout was not read.',
    },
  };
}
