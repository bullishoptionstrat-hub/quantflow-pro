import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { gridCells, runSensitivityGrid } from '../src/research/sensitivityGrid';
import { runSetupReplay } from '../src/research/setupReplay';

// A synthetic TEST plan over the episode fixtures. It is not a real plan and
// nothing here is a finding.
const FIX = join(__dirname, 'fixtures', 'bars');
const read = (f: string) => readFileSync(join(FIX, f), 'utf8');
const csv = { SPY: read('EPISODE_SPY_1m.csv'), QQQ: read('EPISODE_QQQ_1m.csv') };
const HOLDOUT = read('SYNTHETIC_SPY_1m.csv');
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const config = { symbols: ['SPY', 'QQQ'], timestampMarks: 'OPEN', costs: { roundTripPerUnit: 0.02 } };
const NOW = Date.parse('2026-11-18T12:00:00Z');

function plan(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 'prereg/1', id: 'PR-901', status: 'FROZEN', frozenAt: '2026-11-17',
    question: 'TEST ONLY: how do terminal-state counts move with the expiry window?',
    grid: { expiryBars: [20, 30], displacementWindowBars: [5, 8] },
    primaryMetric: 'STATE_COUNTS', selectionRule: 'REPORT_ALL_CELLS', minDecided: 30,
    datasets: [{ id: 'ep-spy', sha256: sha(csv.SPY) }, { id: 'ep-qqq', sha256: sha(csv.QQQ) }],
    holdout: [{ id: 'syn-spy', sha256: sha(HOLDOUT) }],
    dataExaminedBeforeFreeze: false,
    ...over,
  };
}
const refusal = (r: ReturnType<typeof runSensitivityGrid>) => (r.status === 'REFUSED' ? r.reasons.join(' | ') : '');

test('a DRAFT plan is refused even though it validates', () => {
  const r = runSensitivityGrid({ plan: plan({ status: 'DRAFT', frozenAt: null }), config, csv, nowMs: NOW });
  assert.match(refusal(r), /only from a FROZEN plan/);
});

test('an invalid plan is refused with the validator reasons', () => {
  const r = runSensitivityGrid({ plan: plan({ selectionRule: 'BEST_CELL' }), config, csv, nowMs: NOW });
  assert.match(refusal(r), /plan: selectionRule/);
});

test('a file not named by hash is refused; a holdout file is refused by name; a missing dataset is refused', () => {
  assert.match(refusal(runSensitivityGrid({ plan: plan(), config, csv: { ...csv, SPY: csv.SPY + '\n' }, nowMs: NOW })), /not an analysis dataset/);
  assert.match(refusal(runSensitivityGrid({ plan: plan(), config, csv: { ...csv, X: HOLDOUT }, nowMs: NOW })), /holdout dataset syn-spy/);
  assert.match(refusal(runSensitivityGrid({ plan: plan(), config, csv: { SPY: csv.SPY }, nowMs: NOW })), /dataset ep-qqq: not supplied/);
});

test('a config that sets params is refused', () => {
  const r = runSensitivityGrid({ plan: plan(), config: { ...config, params: { expiryBars: 20 } }, csv, nowMs: NOW });
  assert.match(refusal(r), /config.params/);
});

test('every cell is reported in plan order, each equal to a direct replay of that cell', () => {
  const r = runSensitivityGrid({ plan: plan(), config, csv, nowMs: NOW });
  assert.equal(r.status, 'OK');
  if (r.status !== 'OK') return;
  const cells = r.report.cells as { params: Record<string, number>; ideas: number; STATE_COUNTS: Record<string, number> }[];
  assert.deepEqual(cells.map((c) => c.params), [
    { expiryBars: 20, displacementWindowBars: 5 }, { expiryBars: 20, displacementWindowBars: 8 },
    { expiryBars: 30, displacementWindowBars: 5 }, { expiryBars: 30, displacementWindowBars: 8 },
  ]);
  for (const c of cells) {
    const d = runSetupReplay({ config: { ...config, params: c.params }, csv });
    assert.equal(d.status, 'OK');
    if (d.status !== 'OK') continue;
    assert.deepEqual(c.STATE_COUNTS, (d.report.counts as { byTerminalState: unknown }).byTerminalState);
  }
  const keys = JSON.stringify(r.report, (k, v) => (k === 'note' ? undefined : v)).match(/"[A-Za-z_]+":/g) ?? [];
  assert.equal(keys.filter((k) => /hitRate|best|rank|winRate|meanR/i.test(k)).length, 0);
});

test('OUTCOME_COUNTS tallies graded outcome states, never a rate', () => {
  const r = runSensitivityGrid({ plan: plan({ primaryMetric: 'OUTCOME_COUNTS' }), config, csv, nowMs: NOW });
  assert.equal(r.status, 'OK');
  if (r.status !== 'OK') return;
  for (const c of r.report.cells as { params: Record<string, number>; OUTCOME_COUNTS: Record<string, number> }[]) {
    const d = runSetupReplay({ config: { ...config, params: c.params }, csv });
    if (d.status !== 'OK') throw new Error('replay refused');
    const ideas = (d.report.outcomes as { ideas: { state: string }[] }).ideas;
    assert.equal(Object.values(c.OUTCOME_COUNTS).reduce((a, b) => a + b, 0), ideas.length);
  }
});

test('gridCells is the full cartesian product', () => {
  assert.equal(gridCells({ a: [1, 2, 3], b: [4, 5] }).length, 6);
  assert.deepEqual(gridCells({ a: [1] }), [{ a: 1 }]);
});
