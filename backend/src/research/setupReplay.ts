/**
 * SETUP REPLAY — two imported 1-minute CSVs and a config → a JSON report from
 * the same `evaluateSetups` the setup engine exposes. No second evaluation path.
 *
 * The report carries signal events only: state histories, and counts by
 * terminal state and blocked reason. It carries no outcome, P&L or win rate,
 * and says so in `scope`. COMPLETED means price reached the stop or the target
 * after an ACTIONABLE signal; which one is deliberately not recorded.
 *
 * Deterministic: no clock, no randomness, no environment. The same inputs give
 * byte-identical output (`stableStringify`), which `setupReplay.test.ts` checks.
 */
import { createHash } from 'node:crypto';
import { importBarsCsv, BarDataset, TimestampMarks } from '../market/barImport';
import { evaluateSetups, EMPTY_LEDGER, AttemptLedger, SetupIdea, TERMINAL_STATES } from '../setups';
import { SETUP_METHOD_VERSION, DEFAULT_SETUP_PARAMS } from '../setups/params';
import { gradeIdea, summariseOutcomes, IdeaOutcome } from './setupOutcome';
import type { SetupParams } from '../setups/params';

export interface ReplayConfig {
  /** The two symbols, each evaluated with the other as its SMT pair. */
  symbols: [string, string];
  timestampMarks: TimestampMarks;
  /** Round-trip cost per unit in price terms. No default: required. */
  costs: { roundTripPerUnit: number };
  params?: Partial<SetupParams>;
}

export interface ReplayInput { config: unknown; csv: Record<string, string> }

export type ReplayResult = { status: 'OK'; report: Record<string, unknown> } | { status: 'REFUSED'; reasons: string[] };

/** JSON with object keys sorted, so equal values serialize to equal bytes. */
export function stableStringify(v: unknown): string {
  const norm = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(norm);
    if (x !== null && typeof x === 'object') {
      const o: Record<string, unknown> = {};
      for (const k of Object.keys(x as object).sort()) o[k] = norm((x as Record<string, unknown>)[k]);
      return o;
    }
    return x;
  };
  return JSON.stringify(norm(v), null, 2) + '\n';
}

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

export function configRefusals(c: unknown): string[] {
  const r: string[] = [];
  if (c === null || typeof c !== 'object') return ['config: not an object'];
  const o = c as Record<string, unknown>;
  const syms = o.symbols;
  if (!Array.isArray(syms) || syms.length !== 2 || !syms.every((s) => typeof s === 'string' && s.length > 0) || syms[0] === syms[1])
    r.push('config.symbols: two distinct symbol strings required');
  if (o.timestampMarks !== 'OPEN' && o.timestampMarks !== 'CLOSE') r.push('config.timestampMarks: must be OPEN or CLOSE (no default)');
  const costs = o.costs as Record<string, unknown> | undefined;
  const rt = costs?.roundTripPerUnit;
  if (typeof rt !== 'number' || !Number.isFinite(rt) || rt < 0) r.push('config.costs.roundTripPerUnit: a finite, non-negative number is required (no default)');
  if (o.params !== undefined && (o.params === null || typeof o.params !== 'object')) r.push('config.params: must be an object when present');
  return r;
}

function datasetSummary(d: BarDataset) {
  return {
    provenance: d.provenance, contentId: d.contentId, symbol: d.symbol, tf: d.tf,
    timestampMarks: d.timestampMarks, coverage: d.coverage, gaps: d.gaps, rejected: d.rejected,
  };
}

function terminalOf(i: SetupIdea): string {
  const last = i.history[i.history.length - 1];
  return last !== undefined && TERMINAL_STATES.includes(last.state) ? last.state : 'OPEN_AT_END_OF_DATA';
}

export function runSetupReplay(input: ReplayInput): ReplayResult {
  const refusals = configRefusals(input.config);
  if (refusals.length > 0) return { status: 'REFUSED', reasons: refusals };
  const cfg = input.config as ReplayConfig;
  const datasets: Record<string, BarDataset> = {};
  const reasons: string[] = [];
  for (const s of cfg.symbols) {
    const text = input.csv[s];
    if (text === undefined) { reasons.push(`csv: no file supplied for ${s}`); continue; }
    const d = importBarsCsv(text, { symbol: s, timestampMarks: cfg.timestampMarks, source: 'USER_IMPORT' });
    if (d.status !== 'OK') { reasons.push(...d.reasons.map((x) => `${s}: ${x}`)); continue; }
    datasets[s] = d;
  }
  if (reasons.length > 0) return { status: 'REFUSED', reasons };

  let ledger: AttemptLedger = EMPTY_LEDGER;
  const runs: Record<string, unknown>[] = [];
  const byTerminal: Record<string, number> = {};
  const byBlocked: Record<string, number> = {};
  let structureMethodVersion: string | null = null;
  const graded: (IdeaOutcome & { symbol: string })[] = [];
  for (const [s, p] of [[cfg.symbols[0], cfg.symbols[1]], [cfg.symbols[1], cfg.symbols[0]]] as const) {
    const r = evaluateSetups(datasets[s]!.bars, {
      pair: datasets[p]!.bars, costs: cfg.costs, ledger, ...(cfg.params !== undefined ? { params: cfg.params } : {}),
    });
    if (r.status !== 'OK') return { status: 'REFUSED', reasons: r.reasons.map((x) => `${s}: ${x}`) };
    ledger = r.ledger;
    structureMethodVersion = r.structureMethodVersion;
    for (const i of r.ideas) {
      const t = terminalOf(i);
      byTerminal[t] = (byTerminal[t] ?? 0) + 1;
      graded.push({ symbol: s, ...gradeIdea(i, datasets[s]!.bars) });
      if (t === 'BLOCKED') for (const reason of i.history[i.history.length - 1]!.reasons) byBlocked[reason.code] = (byBlocked[reason.code] ?? 0) + 1;
    }
    runs.push({ symbol: r.symbol, pairSymbol: r.pairSymbol, asOf: r.asOf, setupMethodVersion: r.methodVersion, ideas: r.ideas });
  }

  return {
    status: 'OK',
    report: {
      kind: 'SETUP_REPLAY',
      scope: 'Signal events, and for each ACTIONABLE idea which of its target or invalidation the later imported bars touched first, in net R. A bar touching both is AMBIGUOUS, bars ending first is OPEN, and no hit rate or mean R is published below the sample floor. Not P&L: fills, slippage past the stop and position size are not modelled; the definitions are untuned, versioned hypotheses.',
      configHash: sha(stableStringify(input.config)),
      setupMethodVersion: SETUP_METHOD_VERSION,
      structureMethodVersion,
      paramsInForce: { ...DEFAULT_SETUP_PARAMS, ...(cfg.params ?? {}) },
      datasets: cfg.symbols.map((s) => datasetSummary(datasets[s]!)),
      counts: { ideas: Object.values(byTerminal).reduce((a, b) => a + b, 0), byTerminalState: byTerminal, blockedByReason: byBlocked },
      outcomes: { rule: 'research/setupOutcome', ideas: graded, summary: summariseOutcomes(graded) },
      runs,
      ledger,
    },
  };
}
