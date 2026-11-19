/**
 * The walk-forward runner places each replay idea by its ACTIONABLE knownAt,
 * reports every fold and grid cell, and publishes no rate below n=30.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { runWalkForwardReplay, runWalkForwardGrid } from '../src/research/walkForwardReplay';
import { runSetupReplay } from '../src/research/setupReplay';

const FIX = join(__dirname, 'fixtures', 'bars');
const read = (f: string) => readFileSync(join(FIX, f), 'utf8');
const csv = { SPY: read('EPISODE_SPY_1m.csv'), QQQ: read('EPISODE_QQQ_1m.csv') };
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const config = { symbols: ['SPY', 'QQQ'], timestampMarks: 'OPEN', costs: { roundTripPerUnit: 0.02 } };
const D = 86_400_000;
const spec = { startMs: Date.parse('2026-01-05T00:00:00Z'), endMs: Date.parse('2026-01-10T00:00:00Z'), trainMs: 2 * D, testMs: D, embargoMs: 0, mode: 'ROLLING' as const };
const NOW = Date.parse('2026-11-18T12:00:00Z');

test('every graded idea is in exactly one test window or counted outside; totals reconcile with the plain replay', () => {
  const r = runWalkForwardReplay({ config, csv, spec });
  assert.equal(r.status, 'OK'); if (r.status !== 'OK') return;
  const plain = runSetupReplay({ config, csv });
  assert.equal(plain.status, 'OK'); if (plain.status !== 'OK') return;
  const graded = (plain.report.outcomes as { ideas: unknown[] }).ideas.length;
  assert.ok(graded > 0, 'the fixture must produce graded ideas or this test proves nothing');
  const folds = r.report.folds as { test: { byState: Record<string, number> } }[];
  assert.equal(folds.length, 3);
  const inTests = folds.reduce((a, f) => a + Object.values(f.test.byState).reduce((x, y) => x + y, 0), 0);
  assert.equal(inTests + (r.report.outsideEveryTestWindow as number), graded);
});

test('no rate or interval below the sample floor', () => {
  const r = runWalkForwardReplay({ config, csv, spec });
  if (r.status !== 'OK') return assert.fail();
  const oos = r.report.outOfSample as { hitRate: number | null; wilson95: unknown; suppressed: string | null; decided: number };
  assert.ok(oos.decided < 30);
  assert.equal(oos.hitRate, null); assert.equal(oos.wilson95, null);
  assert.match(oos.suppressed ?? '', /INSUFFICIENT_SAMPLE/);
});

test('ideas are placed by ACTIONABLE knownAt: a fold covering one ACTIONABLE instant holds that idea', () => {
  const plain = runSetupReplay({ config, csv });
  if (plain.status !== 'OK') return assert.fail();
  const runs = plain.report.runs as { ideas: { history: { state: string; knownAt: number }[] }[] }[];
  const at = runs.flatMap((x) => x.ideas).map((i) => i.history.find((h) => h.state === 'ACTIONABLE')?.knownAt).find((x) => x !== undefined)!;
  const s = { startMs: at - 10 * 60_000, endMs: at + 2 * 60_000, trainMs: 5 * 60_000, testMs: 6 * 60_000, embargoMs: 0, mode: 'ANCHORED' as const };
  const r = runWalkForwardReplay({ config, csv, spec: s });
  if (r.status !== 'OK') return assert.fail(JSON.stringify(r));
  const f = (r.report.folds as { test: { byState: Record<string, number> } }[])[0]!;
  assert.ok(Object.values(f.test.byState).reduce((a, b) => a + b, 0) >= 1);
  // The same instant one minute outside the test window is not in it.
  const shifted = runWalkForwardReplay({ config, csv, spec: { ...s, startMs: at - 10 * 60_000 + 7 * 60_000, endMs: at + 9 * 60_000, trainMs: 5 * 60_000, testMs: 4 * 60_000 } });
  if (shifted.status !== 'OK') return assert.fail(JSON.stringify(shifted));
  const sf = (shifted.report.folds as { fold: { testStartMs: number }; test: { byState: Record<string, number> } }[])[0]!;
  assert.ok(sf.fold.testStartMs > at);
  assert.ok((shifted.report.outsideEveryTestWindow as number) >= 1);
});

test('a test window is half-open: an idea ACTIONABLE exactly at its end is outside it', () => {
  const plain = runSetupReplay({ config, csv });
  if (plain.status !== 'OK') return assert.fail();
  const runs = plain.report.runs as { ideas: { history: { state: string; knownAt: number }[] }[] }[];
  const at = runs.flatMap((x) => x.ideas).map((i) => i.history.find((h) => h.state === 'ACTIONABLE')?.knownAt).find((x) => x !== undefined)!;
  const mk = (end: number) => runWalkForwardReplay({ config, csv, spec: { startMs: end - 11 * 60_000, endMs: end, trainMs: 5 * 60_000, testMs: 6 * 60_000, embargoMs: 0, mode: 'ROLLING' } });
  const atEnd = mk(at); const past = mk(at + 1);
  if (atEnd.status !== 'OK' || past.status !== 'OK') return assert.fail();
  assert.equal((atEnd.report.outsideEveryTestWindow as number) - (past.report.outsideEveryTestWindow as number), 1);
});

test('bad specs and a too-short span are refused', () => {
  assert.equal(runWalkForwardReplay({ config, csv, spec: { ...spec, embargoMs: -1 } }).status, 'REFUSED');
  assert.match(JSON.stringify(runWalkForwardReplay({ config, csv, spec: { ...spec, endMs: spec.startMs + 2 * D } })), /too short/);
  assert.equal(runWalkForwardReplay({ config: { ...config, costs: undefined }, csv, spec }).status, 'REFUSED');
});

test('the grid runner reports every cell in plan order under the plan rules', () => {
  const HOLD = read('SYNTHETIC_SPY_1m.csv');
  const plan = {
    version: 'prereg/1', id: 'PR-904', status: 'FROZEN', frozenAt: '2026-11-17',
    question: 'TEST ONLY: walk-forward counts across the expiry window grid?',
    grid: { expiryBars: [20, 30] }, primaryMetric: 'STATE_COUNTS', selectionRule: 'REPORT_ALL_CELLS', minDecided: 30,
    datasets: [{ id: 's', sha256: sha(csv.SPY) }, { id: 'q', sha256: sha(csv.QQQ) }], holdout: [{ id: 'h', sha256: sha(HOLD) }], dataExaminedBeforeFreeze: false,
  };
  const r = runWalkForwardGrid({ plan, config, csv, spec, nowMs: NOW });
  assert.equal(r.status, 'OK'); if (r.status !== 'OK') return;
  assert.deepEqual((r.report.cells as { params: unknown }[]).map((c) => c.params), [{ expiryBars: 20 }, { expiryBars: 30 }]);
  assert.equal(runWalkForwardGrid({ plan: { ...plan, status: 'DRAFT', frozenAt: null }, config, csv, spec, nowMs: NOW }).status, 'REFUSED');
  assert.equal(runWalkForwardGrid({ plan, config, csv: { ...csv, X: HOLD }, spec, nowMs: NOW }).status, 'REFUSED');
});
