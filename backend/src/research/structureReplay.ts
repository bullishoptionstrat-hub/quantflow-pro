/**
 * STRUCTURE REPLAY — one imported 1-minute CSV (and optionally its SMT pair) →
 * the structure engine's events, as JSON. The same `analyse` the setup engine
 * builds on; no second detector path.
 *
 * Read-only and reporting only: it publishes events, each with its `knownAt`
 * and the bars it cites, and counts by kind. It decides nothing, grades nothing
 * and stores nothing. Every definition is an untuned, versioned hypothesis, and
 * `scope` says so on the payload rather than in a comment.
 *
 * Deterministic: no clock, no randomness, no environment.
 */
import { createHash } from 'node:crypto';
import { importBarsCsv, BarDataset, TimestampMarks } from '../market/barImport';
import { analyse, STRUCTURE_RULES_VERSION, DEFAULT_PARAMS } from '../structure';
import type { StructureParams } from '../structure/params';
import { stableStringify } from './setupReplay';

export interface StructureReplayConfig {
  symbol: string;
  /** The other symbol of an SMT pair. Absent means SMT is not computed, and the report says so. */
  pairSymbol?: string;
  timestampMarks: TimestampMarks;
  params?: Partial<StructureParams>;
}

export type StructureReplayResult = { status: 'OK'; report: Record<string, unknown> } | { status: 'REFUSED'; reasons: string[] };

const SYMBOL = /^[A-Z0-9.]{1,10}$/;
const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

export function structureConfigRefusals(c: unknown): string[] {
  if (c === null || typeof c !== 'object' || Array.isArray(c)) return ['config: not an object'];
  const o = c as Record<string, unknown>;
  const r: string[] = [];
  for (const k of Object.keys(o)) if (!['symbol', 'pairSymbol', 'timestampMarks', 'params'].includes(k)) r.push(`config.${k}: unknown field`);
  if (typeof o.symbol !== 'string' || !SYMBOL.test(o.symbol)) r.push('config.symbol: a symbol is required');
  if (o.pairSymbol !== undefined && (typeof o.pairSymbol !== 'string' || !SYMBOL.test(o.pairSymbol))) r.push('config.pairSymbol: must be a symbol when present');
  if (o.pairSymbol !== undefined && o.pairSymbol === o.symbol) r.push('config.pairSymbol: must differ from config.symbol');
  if (o.timestampMarks !== 'OPEN' && o.timestampMarks !== 'CLOSE') r.push('config.timestampMarks: must be OPEN or CLOSE (no default)');
  if (o.params !== undefined && (o.params === null || typeof o.params !== 'object' || Array.isArray(o.params))) r.push('config.params: must be an object when present');
  return r;
}

function datasetSummary(d: BarDataset) {
  return {
    provenance: d.provenance, contentId: d.contentId, symbol: d.symbol, tf: d.tf,
    timestampMarks: d.timestampMarks, coverage: d.coverage, gaps: d.gaps, rejected: d.rejected,
  };
}

export function runStructureReplay(input: { config: unknown; csv: Record<string, string> }): StructureReplayResult {
  const refusals = structureConfigRefusals(input.config);
  if (refusals.length > 0) return { status: 'REFUSED', reasons: refusals };
  const cfg = input.config as StructureReplayConfig;
  const symbols = cfg.pairSymbol !== undefined ? [cfg.symbol, cfg.pairSymbol] : [cfg.symbol];
  const datasets: Record<string, BarDataset> = {};
  const reasons: string[] = [];
  for (const s of symbols) {
    const text = input.csv[s];
    if (text === undefined) { reasons.push(`csv: no file supplied for ${s}`); continue; }
    const d = importBarsCsv(text, { symbol: s, timestampMarks: cfg.timestampMarks, source: 'USER_IMPORT' });
    if (d.status !== 'OK') { reasons.push(...d.reasons.map((x) => `${s}: ${x}`)); continue; }
    datasets[s] = d;
  }
  for (const k of Object.keys(input.csv)) if (!symbols.includes(k)) reasons.push(`csv.${k}: not named in config`);
  if (reasons.length > 0) return { status: 'REFUSED', reasons };

  const own = datasets[cfg.symbol]!;
  const pair = cfg.pairSymbol !== undefined ? datasets[cfg.pairSymbol]! : undefined;
  const r = analyse(own.bars, {
    ...(cfg.params !== undefined ? { params: cfg.params } : {}),
    ...(pair !== undefined ? { pair: pair.bars } : {}),
  });
  if (r.status !== 'OK') return { status: 'REFUSED', reasons: r.reasons };

  const byKind: Record<string, number> = {};
  for (const e of r.events) byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;

  const notComputed: { name: string; status: 'UNMEASURABLE'; reason: string }[] = r.notComputed.map((n) => ({ ...n }));
  if (pair === undefined) notComputed.push({ name: 'SMT', status: 'UNMEASURABLE', reason: 'No pair file was supplied, so no SMT event can appear.' });

  return {
    status: 'OK',
    report: {
      kind: 'STRUCTURE_REPLAY',
      scope: 'Structure events over the imported bars: swings, session levels, dealing ranges, displacement, the FVG lifecycle, sweeps, BOS/CHoCH and (with a pair) SMT. Each event carries the close it became knowable at and the bars it cites. Every definition is an untuned, versioned hypothesis with no measured predictive value; nothing here is a signal.',
      configHash: sha(stableStringify(input.config)),
      methodVersion: r.methodVersion,
      rulesVersion: STRUCTURE_RULES_VERSION,
      paramsInForce: { ...DEFAULT_PARAMS, ...(cfg.params ?? {}) },
      symbol: r.symbol,
      pairSymbol: r.pairSymbol,
      tf: r.tf,
      asOf: r.asOf,
      datasets: symbols.map((s) => datasetSummary(datasets[s]!)),
      counts: { events: r.events.length, byKind },
      notComputed,
      events: r.events,
    },
  };
}
