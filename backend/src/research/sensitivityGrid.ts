/**
 * Sensitivity-grid runner. It refuses to run unless `validatePreregistration`
 * accepts the plan as VALID **and FROZEN**, and unless the CSV files it is
 * handed are exactly the plan's analysis datasets, named by SHA-256 of their
 * bytes. A file whose hash is a holdout dataset is refused by name: the
 * holdout is not read until a separate, later step.
 *
 * Every cell of the grid is run through `runSetupReplay` (the function the CLI
 * and `/setups` call) and every cell is reported, in a fixed order, with the
 * plan's primary metric only: counts. No cell is ranked, flagged or chosen.
 * A count is reported but a rate never is.
 *
 * Nothing here has been run on real data: no plan has been frozen.
 */
import { createHash } from 'node:crypto';
import { validatePreregistration, type Preregistration } from './preregistration';
import { runSetupReplay } from './setupReplay';

export type GridResult =
  | { status: 'OK'; report: Record<string, unknown> }
  | { status: 'REFUSED'; reasons: string[] };

export interface GridInput {
  plan: unknown;
  /** Replay config without `params`; the grid supplies them per cell. */
  config: unknown;
  csv: Record<string, string>;
  nowMs: number;
}

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

/** Cartesian product in the plan's key order, values in listed order. */
export function gridCells(grid: Record<string, number[]>): Record<string, number>[] {
  let cells: Record<string, number>[] = [{}];
  for (const [k, vals] of Object.entries(grid)) {
    const next: Record<string, number>[] = [];
    for (const c of cells) for (const v of vals) next.push({ ...c, [k]: v });
    cells = next;
  }
  return cells;
}

export function runSensitivityGrid(input: GridInput): GridResult {
  const verdict = validatePreregistration(input.plan, input.nowMs);
  if (verdict.status !== 'VALID') return { status: 'REFUSED', reasons: verdict.reasons.map((r) => `plan: ${r}`) };
  if (!verdict.frozen) return { status: 'REFUSED', reasons: ['plan: a grid runs only from a FROZEN plan'] };
  const plan = input.plan as Preregistration;

  const reasons: string[] = [];
  const cfg = input.config;
  if (cfg === null || typeof cfg !== 'object' || Array.isArray(cfg)) return { status: 'REFUSED', reasons: ['config: not an object'] };
  if ('params' in (cfg as object)) reasons.push('config.params: the grid sets parameters per cell; the config must not');

  const analysis = new Set(plan.datasets.map((d) => d.sha256));
  const holdout = new Map(plan.holdout.map((d) => [d.sha256, d.id]));
  const supplied = new Set<string>();
  for (const [name, text] of Object.entries(input.csv)) {
    const h = sha(text);
    supplied.add(h);
    if (holdout.has(h)) reasons.push(`csv ${name}: is holdout dataset ${holdout.get(h)}; the holdout is not read by the grid`);
    else if (!analysis.has(h)) reasons.push(`csv ${name}: sha256 ${h} is not an analysis dataset of ${plan.id}`);
  }
  for (const d of plan.datasets) if (!supplied.has(d.sha256)) reasons.push(`dataset ${d.id}: not supplied`);
  if (reasons.length > 0) return { status: 'REFUSED', reasons };

  const cells = gridCells(plan.grid as Record<string, number[]>);
  const rows: Record<string, unknown>[] = [];
  for (const params of cells) {
    const r = runSetupReplay({ config: { ...(cfg as object), params }, csv: input.csv });
    if (r.status !== 'OK') return { status: 'REFUSED', reasons: r.reasons.map((x) => `cell ${JSON.stringify(params)}: ${x}`) };
    const counts = r.report.counts as { ideas: number; byTerminalState: Record<string, number> };
    const outcomes = (r.report.outcomes as { ideas: { state: string }[] }).ideas;
    const metric: Record<string, number> = {};
    if (plan.primaryMetric === 'STATE_COUNTS') Object.assign(metric, counts.byTerminalState);
    else for (const o of outcomes) metric[o.state] = (metric[o.state] ?? 0) + 1;
    rows.push({ params, ideas: counts.ideas, [plan.primaryMetric]: metric, configHash: r.report.configHash });
  }

  return {
    status: 'OK',
    report: {
      kind: 'SENSITIVITY_GRID',
      planId: plan.id,
      preregistrationHash: verdict.preregistrationHash,
      primaryMetric: plan.primaryMetric,
      selectionRule: plan.selectionRule,
      cells: rows,
      note: 'Every cell is reported in plan order. Counts only; no cell is ranked or chosen. The holdout was not read. Untuned definitions; not evidence of an edge.',
    },
  };
}
