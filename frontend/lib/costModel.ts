/**
 * THE SHARED COST MODEL — one rule for what a round trip costs per unit, used
 * by research grading (`setupReplay` → the reward gate → `setupOutcome`'s net
 * R) and by position sizing (`frontend/lib/riskSize.ts` `stopRisk`).
 *
 * This file is byte-identical at `backend/src/research/costModel.ts` and
 * `frontend/lib/costModel.ts` (the two packages cannot import each other);
 * `backend/test/costModel.test.ts` fails if they differ. It imports nothing.
 *
 * Fields, all required, none defaulted:
 * - `commissionPerUnit`: round-trip commission and fees per unit, in dollars.
 * - `slippageTicks`: adverse ticks paid per round trip. The plan names spread
 *   and slippage separately; here they are one figure, because both are paid
 *   in ticks and the sizing page already asks for a single number. Spread
 *   crossing belongs in it. 0 is an answer; absent is not.
 *
 * Two readings of the same cost, and nothing else:
 * - `costDollarsPerUnit` = commission + slippageTicks × tickValue
 * - `costPricePerUnit`   = costDollarsPerUnit / pointValue
 * A refusal is returned rather than a number whenever an input is not a finite
 * non-negative value (or tickValue/pointValue not positive).
 */

export interface CostModel {
  commissionPerUnit: number;
  slippageTicks: number;
}

export interface CostInstrument {
  tickSize: number;
  tickValue: number;
  pointValue: number;
}

export type CostResult = { ok: true; value: number } | { ok: false; reasons: string[] };

export function costModelRefusals(m: unknown): string[] {
  if (m === null || typeof m !== 'object' || Array.isArray(m)) return ['cost model: not supplied; there is no default'];
  const o = m as Record<string, unknown>;
  const out: string[] = [];
  for (const k of ['commissionPerUnit', 'slippageTicks']) {
    const v = o[k];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) out.push(`cost model: ${k} must be a finite non-negative number (no default)`);
  }
  return out;
}

export function instrumentRefusals(i: unknown): string[] {
  if (i === null || typeof i !== 'object' || Array.isArray(i)) return ['instrument: not supplied'];
  const o = i as Record<string, unknown>;
  const out: string[] = [];
  for (const k of ['tickSize', 'tickValue', 'pointValue']) {
    const v = o[k];
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) out.push(`instrument: ${k} must be a finite positive number`);
  }
  return out;
}

export function costDollarsPerUnit(m: CostModel, i: CostInstrument): CostResult {
  const reasons = [...costModelRefusals(m), ...instrumentRefusals(i)];
  if (reasons.length > 0) return { ok: false, reasons };
  return { ok: true, value: m.commissionPerUnit + m.slippageTicks * i.tickValue };
}

export function costPricePerUnit(m: CostModel, i: CostInstrument): CostResult {
  const d = costDollarsPerUnit(m, i);
  if (!d.ok) return d;
  return { ok: true, value: d.value / i.pointValue };
}
