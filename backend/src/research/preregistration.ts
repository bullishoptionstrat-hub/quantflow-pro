/**
 * Pre-registration for a setup-parameter sensitivity grid: a template and a
 * validator. **It runs no grid.** It decides only whether a written plan is
 * complete enough that a grid run afterwards could not be steered by its own
 * results.
 *
 * A sensitivity grid varies the untuned parameters in `setups/params.ts` and
 * reports how idea counts move. Run without a plan, it invites the reader to
 * pick the best-looking cell, which is curve-fitting. So the plan must be
 * frozen, with its data named by hash, before the grid runs, and it must say
 * in advance that every cell is reported (`selectionRule: REPORT_ALL_CELLS`).
 *
 * Rules, all fail-closed (anything unreadable is a refusal, never a default):
 *  - every varied parameter is a real `SetupParams` key, and every grid value
 *    passes `setupParamRefusals` with the other parameters at their defaults;
 *  - each axis contains the default value, so the shipped setting is a cell
 *    and not something the grid is compared against from outside;
 *  - no duplicate values; the cell count is at most `MAX_GRID_CELLS`;
 *  - the reported quantity is counts only (`STATE_COUNTS` / `OUTCOME_COUNTS`);
 *    no hit rate, R or P&L is a permitted primary metric;
 *  - `minDecided` is at least `MIN_PUBLISHABLE_SAMPLE`, the backend's floor;
 *  - analysis and holdout datasets are named by SHA-256 and are disjoint;
 *  - FROZEN needs a real, non-future `frozenAt` and
 *    `dataExaminedBeforeFreeze: false`.
 *
 * `preregistrationHash` is a hash of the canonical content, so a plan changed
 * after freezing is visibly a different plan.
 */
import { createHash } from 'node:crypto';
import { DEFAULT_SETUP_PARAMS, setupParamRefusals, type SetupParams } from '../setups/params';
import { MIN_PUBLISHABLE_SAMPLE } from '../persistence/types';

export const PREREG_VERSION = 'prereg/1';
export const MAX_GRID_CELLS = 200;
export const PRIMARY_METRICS = ['STATE_COUNTS', 'OUTCOME_COUNTS'] as const;
export type PrimaryMetric = (typeof PRIMARY_METRICS)[number];

export interface DatasetRef { id: string; sha256: string }

export interface Preregistration {
  version: typeof PREREG_VERSION;
  id: string;
  status: 'DRAFT' | 'FROZEN';
  frozenAt: string | null;
  question: string;
  grid: Partial<Record<keyof SetupParams, number[]>>;
  primaryMetric: PrimaryMetric;
  selectionRule: 'REPORT_ALL_CELLS';
  minDecided: number;
  datasets: DatasetRef[];
  holdout: DatasetRef[];
  dataExaminedBeforeFreeze: boolean;
}

export type PreregVerdict =
  | { status: 'VALID'; frozen: boolean; cells: number; preregistrationHash: string }
  | { status: 'REFUSED'; reasons: string[] };

const HEX64 = /^[0-9a-f]{64}$/;
const ID = /^PR-\d{3}$/;

/** A blank plan. Every field must be answered; nothing here is a default. */
export function preregistrationTemplate(): Record<string, unknown> {
  return {
    version: PREREG_VERSION,
    id: 'PR-000',
    status: 'DRAFT',
    frozenAt: null,
    question: '',
    grid: {},
    primaryMetric: null,
    selectionRule: null,
    minDecided: null,
    datasets: [],
    holdout: [],
    dataExaminedBeforeFreeze: null,
  };
}

function isRealIsoDate(s: unknown): s is string {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function datasetRefusals(name: string, v: unknown): string[] {
  if (!Array.isArray(v) || v.length === 0) return [`${name} must be a non-empty list of { id, sha256 }`];
  const out: string[] = [];
  v.forEach((d, i) => {
    if (typeof d !== 'object' || d === null) { out.push(`${name}[${i}] is not an object`); return; }
    const r = d as Record<string, unknown>;
    if (typeof r.id !== 'string' || r.id.trim() === '') out.push(`${name}[${i}].id is missing`);
    if (typeof r.sha256 !== 'string' || !HEX64.test(r.sha256)) out.push(`${name}[${i}].sha256 must be 64 lowercase hex characters`);
  });
  return out;
}

/** Canonical JSON: object keys sorted at every depth. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

export function validatePreregistration(input: unknown, nowMs: number): PreregVerdict {
  const reasons: string[] = [];
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { status: 'REFUSED', reasons: ['the pre-registration is not an object'] };
  }
  const p = input as Record<string, unknown>;
  const known = new Set(Object.keys(preregistrationTemplate()));
  for (const k of Object.keys(p)) if (!known.has(k)) reasons.push(`unknown field ${k}`);

  if (p.version !== PREREG_VERSION) reasons.push(`version must be ${PREREG_VERSION}`);
  if (typeof p.id !== 'string' || !ID.test(p.id) || p.id === 'PR-000') reasons.push('id must look like PR-001 (PR-000 is the template)');
  if (p.status !== 'DRAFT' && p.status !== 'FROZEN') reasons.push('status must be DRAFT or FROZEN');
  if (typeof p.question !== 'string' || p.question.trim().length < 20) reasons.push('question must state what the grid asks, in at least 20 characters');

  // Grid.
  let cells = 0;
  const grid = p.grid;
  if (typeof grid !== 'object' || grid === null || Array.isArray(grid) || Object.keys(grid).length === 0) {
    reasons.push('grid must name at least one parameter');
  } else {
    cells = 1;
    const paramKeys = new Set(Object.keys(DEFAULT_SETUP_PARAMS));
    for (const [k, vals] of Object.entries(grid as Record<string, unknown>)) {
      if (!paramKeys.has(k)) { reasons.push(`grid.${k} is not a setup parameter`); cells = 0; continue; }
      const key = k as keyof SetupParams;
      if (!Array.isArray(vals) || vals.length < 2) { reasons.push(`grid.${k} must list at least two values`); cells = 0; continue; }
      if (new Set(vals).size !== vals.length) reasons.push(`grid.${k} repeats a value`);
      for (const v of vals) {
        const trial = { ...DEFAULT_SETUP_PARAMS, [key]: v } as SetupParams;
        for (const r of setupParamRefusals(trial)) reasons.push(`grid.${k}: ${r}`);
      }
      if (!vals.includes(DEFAULT_SETUP_PARAMS[key])) reasons.push(`grid.${k} must include the shipped default ${DEFAULT_SETUP_PARAMS[key]}`);
      cells *= vals.length;
    }
    if (cells > MAX_GRID_CELLS) reasons.push(`the grid has ${cells} cells; the limit is ${MAX_GRID_CELLS}`);
  }

  if (!(PRIMARY_METRICS as readonly unknown[]).includes(p.primaryMetric)) {
    reasons.push(`primaryMetric must be one of ${PRIMARY_METRICS.join(', ')} (counts only: no hit rate, R or P&L)`);
  }
  if (p.selectionRule !== 'REPORT_ALL_CELLS') reasons.push('selectionRule must be REPORT_ALL_CELLS: no cell is chosen as best');
  if (!(Number.isInteger(p.minDecided) && (p.minDecided as number) >= MIN_PUBLISHABLE_SAMPLE)) {
    reasons.push(`minDecided must be an integer of at least ${MIN_PUBLISHABLE_SAMPLE}`);
  }

  const dsR = datasetRefusals('datasets', p.datasets);
  const hoR = datasetRefusals('holdout', p.holdout);
  reasons.push(...dsR, ...hoR);
  if (dsR.length === 0 && hoR.length === 0) {
    const a = p.datasets as DatasetRef[];
    const h = p.holdout as DatasetRef[];
    const aHashes = new Set(a.map((d) => d.sha256));
    const aIds = new Set(a.map((d) => d.id));
    for (const d of h) {
      if (aHashes.has(d.sha256) || aIds.has(d.id)) reasons.push(`holdout ${d.id} is also an analysis dataset`);
    }
  }

  if (typeof p.dataExaminedBeforeFreeze !== 'boolean') reasons.push('dataExaminedBeforeFreeze must be answered true or false');
  if (p.status === 'FROZEN') {
    if (!isRealIsoDate(p.frozenAt)) reasons.push('a FROZEN plan needs frozenAt as a real YYYY-MM-DD date');
    else if (Date.parse(`${p.frozenAt}T00:00:00Z`) > nowMs) reasons.push('frozenAt is in the future');
    if (p.dataExaminedBeforeFreeze !== false) reasons.push('a plan cannot be FROZEN once its data has been examined');
  } else if (p.frozenAt !== null) {
    reasons.push('a DRAFT plan has frozenAt null');
  }

  if (reasons.length > 0) return { status: 'REFUSED', reasons };
  const preregistrationHash = createHash('sha256').update(canonical(p)).digest('hex');
  return { status: 'VALID', frozen: p.status === 'FROZEN', cells, preregistrationHash };
}
