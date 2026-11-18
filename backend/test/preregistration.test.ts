import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  MAX_GRID_CELLS, preregistrationTemplate, validatePreregistration,
} from '../src/research/preregistration';
import { MIN_PUBLISHABLE_SAMPLE } from '../src/persistence/types';

const NOW = Date.parse('2026-11-18T12:00:00Z');
const H = (c: string) => c.repeat(64);

function valid(): Record<string, unknown> {
  return {
    version: 'prereg/1', id: 'PR-001', status: 'FROZEN', frozenAt: '2026-11-17',
    question: 'How do ACTIONABLE counts move with the expiry window and the displacement window?',
    grid: { expiryBars: [20, 30, 40], displacementWindowBars: [3, 5, 8] },
    primaryMetric: 'STATE_COUNTS', selectionRule: 'REPORT_ALL_CELLS', minDecided: 30,
    datasets: [{ id: 'spy-2026q1', sha256: H('a') }], holdout: [{ id: 'spy-2026q2', sha256: H('b') }],
    dataExaminedBeforeFreeze: false,
  };
}
const reasons = (p: unknown) => {
  const v = validatePreregistration(p, NOW);
  return v.status === 'REFUSED' ? v.reasons.join(' | ') : '';
};

test('a complete frozen plan is VALID with its cell count and a stable hash', () => {
  const v = validatePreregistration(valid(), NOW);
  assert.equal(v.status, 'VALID');
  if (v.status !== 'VALID') return;
  assert.equal(v.cells, 9);
  assert.equal(v.frozen, true);
  const reordered = Object.fromEntries(Object.entries(valid()).reverse());
  const w = validatePreregistration(reordered, NOW);
  assert.equal(w.status === 'VALID' && w.preregistrationHash, v.preregistrationHash, 'key order does not change the hash');
  const changed = validatePreregistration({ ...valid(), minDecided: 31 }, NOW);
  assert.notEqual(changed.status === 'VALID' && changed.preregistrationHash, v.preregistrationHash);
});

test('the blank template is refused, and the committed TEMPLATE.json is the code\'s template', () => {
  assert.equal(validatePreregistration(preregistrationTemplate(), NOW).status, 'REFUSED');
  const file = JSON.parse(readFileSync(join(__dirname, '../../research/preregistrations/TEMPLATE.json'), 'utf8'));
  assert.deepEqual(file, preregistrationTemplate());
});

test('grid axes: real parameter, at least two values, includes the default, passes the parameter rules', () => {
  assert.match(reasons({ ...valid(), grid: { notAParam: [1, 2] } }), /not a setup parameter/);
  assert.match(reasons({ ...valid(), grid: { expiryBars: [30] } }), /at least two values/);
  assert.match(reasons({ ...valid(), grid: { expiryBars: [20, 40] } }), /shipped default 30/);
  assert.match(reasons({ ...valid(), grid: { minNetR: [1.5, 2] } }), /minNetR must be/);
  assert.match(reasons({ ...valid(), grid: { expiryBars: [30, 30, 40] } }), /repeats a value/);
  assert.match(reasons({ ...valid(), grid: {} }), /at least one parameter/);
});

test('the cell count is capped', () => {
  const many = (d: number) => Array.from({ length: 15 }, (_, i) => d + i);
  const v = reasons({ ...valid(), grid: { expiryBars: many(30), displacementWindowBars: many(5) } });
  assert.match(v, new RegExp(`225 cells; the limit is ${MAX_GRID_CELLS}`));
  const edge = { ...valid(), grid: { expiryBars: Array.from({ length: 10 }, (_, i) => 30 + i), displacementWindowBars: Array.from({ length: 20 }, (_, i) => 5 + i) } };
  assert.equal(validatePreregistration(edge, NOW).status, 'VALID', 'exactly the limit is allowed');
});

test('counts only, every cell reported, sample floor', () => {
  assert.match(reasons({ ...valid(), primaryMetric: 'HIT_RATE' }), /counts only/);
  assert.match(reasons({ ...valid(), selectionRule: 'BEST_CELL' }), /REPORT_ALL_CELLS/);
  assert.match(reasons({ ...valid(), minDecided: MIN_PUBLISHABLE_SAMPLE - 1 }), /minDecided/);
  assert.equal(validatePreregistration({ ...valid(), minDecided: MIN_PUBLISHABLE_SAMPLE }, NOW).status, 'VALID');
});

test('datasets are named by hash and the holdout is disjoint', () => {
  assert.match(reasons({ ...valid(), datasets: [] }), /datasets must be a non-empty/);
  assert.match(reasons({ ...valid(), datasets: [{ id: 'x', sha256: 'abc' }] }), /64 lowercase hex/);
  assert.match(reasons({ ...valid(), holdout: [{ id: 'other', sha256: H('a') }] }), /also an analysis dataset/);
  assert.match(reasons({ ...valid(), holdout: [{ id: 'spy-2026q1', sha256: H('c') }] }), /also an analysis dataset/);
});

test('freezing: real past date, data unexamined; a draft has no date', () => {
  assert.match(reasons({ ...valid(), frozenAt: '2026-02-30' }), /real YYYY-MM-DD/);
  assert.match(reasons({ ...valid(), frozenAt: '2026-11-19' }), /in the future/);
  assert.equal(validatePreregistration({ ...valid(), frozenAt: '2026-11-18' }, NOW).status, 'VALID');
  assert.match(reasons({ ...valid(), dataExaminedBeforeFreeze: true }), /cannot be FROZEN/);
  assert.match(reasons({ ...valid(), dataExaminedBeforeFreeze: null }), /answered true or false/);
  assert.match(reasons({ ...valid(), status: 'DRAFT' }), /DRAFT plan has frozenAt null/);
  const draft = validatePreregistration({ ...valid(), status: 'DRAFT', frozenAt: null, dataExaminedBeforeFreeze: true }, NOW);
  assert.equal(draft.status === 'VALID' && draft.frozen, false);
});

test('shape: unknown fields, bad id, short question, wrong version, non-object', () => {
  assert.match(reasons({ ...valid(), bestCell: 'x' }), /unknown field bestCell/);
  assert.match(reasons({ ...valid(), id: 'PR-000' }), /id must/);
  assert.match(reasons({ ...valid(), question: 'short' }), /question/);
  assert.match(reasons({ ...valid(), version: 'prereg/0' }), /version/);
  assert.match(reasons([]), /not an object/);
  assert.match(reasons(null), /not an object/);
});
