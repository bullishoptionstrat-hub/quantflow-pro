/**
 * THE SETUP ENGINE — imported or supplied closed bars → structure events →
 * the Sweep-and-Reclaim / Sell-the-Rip state machine.
 *
 * Backend only: no route, no UI and no persistence call this. Every definition
 * is a proposed, untuned interpretation (see `sweepReclaim.ts` and `params.ts`)
 * and nothing it emits is evidence of an edge.
 */
import { Bar } from '../market/bar';
import { analyse } from '../structure';
import { AttemptLedger, Costs, MachineResult, runSweepReclaim } from './sweepReclaim';
import { DEFAULT_SETUP_PARAMS, SetupParams, setupParamRefusals } from './params';

export interface EvaluateOptions {
  pair?: readonly Bar[];
  costs: Costs | null;
  ledger: AttemptLedger;
  params?: Partial<SetupParams>;
}

export type EvaluateResult =
  | ({ status: 'OK'; symbol: string; pairSymbol: string | null; asOf: number; structureMethodVersion: string } & MachineResult)
  | { status: 'REFUSED'; reasons: string[] };

export function evaluateSetups(bars: readonly Bar[], opts: EvaluateOptions): EvaluateResult {
  const params: SetupParams = { ...DEFAULT_SETUP_PARAMS, ...(opts.params ?? {}) };
  const pr = setupParamRefusals(params);
  if (pr.length > 0) return { status: 'REFUSED', reasons: pr.map((r) => `params: ${r}`) };
  const a = analyse(bars, opts.pair !== undefined ? { pair: opts.pair } : {});
  if (a.status !== 'OK') return a;
  const r = runSweepReclaim({
    symbol: a.symbol, bars, events: a.events, pairSymbol: a.pairSymbol,
    costs: opts.costs, ledger: opts.ledger, params, structureMethodVersion: a.methodVersion,
  });
  return { status: 'OK', symbol: a.symbol, pairSymbol: a.pairSymbol, asOf: a.asOf, structureMethodVersion: a.methodVersion, ...r };
}

export * from './sweepReclaim';
export { SETUP_METHOD_VERSION, SETUP_RULES_VERSION, DEFAULT_SETUP_PARAMS } from './params';
