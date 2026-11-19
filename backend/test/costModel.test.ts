/**
 * One cost rule for grading and sizing: the two copies are byte-identical,
 * there are no defaults, and the replay charges what the model says.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { costDollarsPerUnit, costPricePerUnit, costModelRefusals } from '../src/research/costModel';
import { runSetupReplay } from '../src/research/setupReplay';

const ROOT = join(__dirname, '..', '..');
const ES = { tickSize: 0.25, tickValue: 12.5, pointValue: 50 };

test('the frontend copy is byte-identical to the research copy', () => {
  assert.equal(readFileSync(join(ROOT, 'frontend/lib/costModel.ts'), 'utf8'), readFileSync(join(ROOT, 'backend/src/research/costModel.ts'), 'utf8'));
});

test('hand-worked: ES, $4.50 commission, 2 ticks slippage', () => {
  assert.deepEqual(costDollarsPerUnit({ commissionPerUnit: 4.5, slippageTicks: 2 }, ES), { ok: true, value: 29.5 });
  assert.deepEqual(costPricePerUnit({ commissionPerUnit: 4.5, slippageTicks: 2 }, ES), { ok: true, value: 0.59 });
  assert.deepEqual(costPricePerUnit({ commissionPerUnit: 0, slippageTicks: 0 }, ES), { ok: true, value: 0 });
});

test('no defaults: absent, negative, non-finite and a bad instrument are refused by name', () => {
  assert.match(costModelRefusals(undefined).join(), /no default/);
  assert.match(costModelRefusals({ commissionPerUnit: 1 }).join(), /slippageTicks/);
  assert.match(costModelRefusals({ commissionPerUnit: -1, slippageTicks: 0 }).join(), /commissionPerUnit/);
  assert.match(costModelRefusals({ commissionPerUnit: Infinity, slippageTicks: 0 }).join(), /commissionPerUnit/);
  const r = costPricePerUnit({ commissionPerUnit: 1, slippageTicks: 1 }, { ...ES, pointValue: 0 });
  assert.equal(r.ok, false);
});

test('the sizing module charges stop risk through the shared model', () => {
  const src = readFileSync(join(ROOT, 'frontend/lib/riskSize.ts'), 'utf8');
  assert.match(src, /import \{ costDollarsPerUnit \} from '\.\/costModel'/);
  assert.match(src, /stopTicks \* tickValue \+ c\.value/);
  assert.doesNotMatch(src, /\(stopTicks \+ slippageTicks\) \* tickValue \+ costPerUnit/);
});

const FIX = join(__dirname, 'fixtures', 'bars');
const csv = { SPY: readFileSync(join(FIX, 'EPISODE_SPY_1m.csv'), 'utf8'), QQQ: readFileSync(join(FIX, 'EPISODE_QQQ_1m.csv'), 'utf8') };
const SPYI = { tickSize: 0.01, tickValue: 0.01, pointValue: 1 };

test('a replay given the model equals a replay given the price figure it computes, and records the basis', () => {
  const base = { symbols: ['SPY', 'QQQ'], timestampMarks: 'OPEN' };
  const a = runSetupReplay({ config: { ...base, costs: { model: { commissionPerUnit: 0.005, slippageTicks: 1.5 }, instrument: SPYI } }, csv });
  const b = runSetupReplay({ config: { ...base, costs: { roundTripPerUnit: 0.02 } }, csv });
  assert.equal(a.status, 'OK'); assert.equal(b.status, 'OK');
  if (a.status !== 'OK' || b.status !== 'OK') return;
  assert.deepEqual((a.report.costBasis as { roundTripPerUnit: number }).roundTripPerUnit, 0.02);
  assert.deepEqual(a.report.outcomes, b.report.outcomes);
  assert.deepEqual(a.report.counts, b.report.counts);
  assert.equal('costBasis' in b.report, false);
});

test('a replay with both forms, or a model missing a field, is refused', () => {
  const base = { symbols: ['SPY', 'QQQ'], timestampMarks: 'OPEN' };
  const both = runSetupReplay({ config: { ...base, costs: { roundTripPerUnit: 0.02, model: { commissionPerUnit: 0, slippageTicks: 0 }, instrument: SPYI } }, csv });
  assert.equal(both.status, 'REFUSED');
  const half = runSetupReplay({ config: { ...base, costs: { model: { commissionPerUnit: 0 }, instrument: SPYI } }, csv });
  assert.equal(half.status, 'REFUSED');
  if (half.status === 'REFUSED') assert.match(half.reasons.join(), /slippageTicks/);
});
