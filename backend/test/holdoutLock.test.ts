/** A holdout is read once per frozen plan; a second read is refused. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { readHoldoutOnce } from '../src/research/holdoutLock';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const A = 'analysis bytes\n';
const H = 'holdout bytes\n';
const NOW = Date.parse('2026-11-18T12:00:00Z');
function plan(over: Record<string, unknown> = {}) {
  return {
    version: 'prereg/1', id: 'PR-902', status: 'FROZEN', frozenAt: '2026-11-17',
    question: 'TEST ONLY: does the holdout lock refuse a second read?',
    grid: { expiryBars: [20, 30] }, primaryMetric: 'STATE_COUNTS', selectionRule: 'REPORT_ALL_CELLS', minDecided: 30,
    datasets: [{ id: 'a', sha256: sha(A) }], holdout: [{ id: 'h', sha256: sha(H) }], dataExaminedBeforeFreeze: false, ...over,
  };
}
const dir = () => mkdtempSync(join(tmpdir(), 'holdout-'));

test('first read returns the text and records it; the second is refused and names the first', () => {
  const d = dir();
  const r1 = readHoldoutOnce({ plan: plan(), text: H, lockDir: d, nowMs: NOW });
  assert.equal(r1.status, 'READ');
  if (r1.status === 'READ') { assert.equal(r1.text, H); assert.equal(r1.record.datasetId, 'h'); }
  const r2 = readHoldoutOnce({ plan: plan(), text: H, lockDir: d, nowMs: NOW + 1000 });
  assert.equal(r2.status, 'REFUSED');
  if (r2.status === 'REFUSED') { assert.match(r2.reasons.join(), /already read/); assert.equal(r2.priorRead?.readAt, new Date(NOW).toISOString()); }
  assert.equal(readdirSync(d).length, 1);
});

test('a different plan is a different hash and gets its own read', () => {
  const d = dir();
  assert.equal(readHoldoutOnce({ plan: plan(), text: H, lockDir: d, nowMs: NOW }).status, 'READ');
  assert.equal(readHoldoutOnce({ plan: plan({ id: 'PR-903' }), text: H, lockDir: d, nowMs: NOW }).status, 'READ');
});

test('refused before any claim: DRAFT plan, invalid plan, analysis data, unknown data', () => {
  const d = dir();
  assert.match(JSON.stringify(readHoldoutOnce({ plan: plan({ status: 'DRAFT', frozenAt: null }), text: H, lockDir: d, nowMs: NOW })), /FROZEN/);
  assert.equal(readHoldoutOnce({ plan: plan({ selectionRule: 'BEST' }), text: H, lockDir: d, nowMs: NOW }).status, 'REFUSED');
  assert.match(JSON.stringify(readHoldoutOnce({ plan: plan(), text: A, lockDir: d, nowMs: NOW })), /analysis dataset a/);
  assert.match(JSON.stringify(readHoldoutOnce({ plan: plan(), text: 'x', lockDir: d, nowMs: NOW })), /not a holdout/);
  assert.equal(readdirSync(d).length, 0);
});

test('a missing lock directory is a refusal, not a read', () => {
  const r = readHoldoutOnce({ plan: plan(), text: H, lockDir: join(dir(), 'nope'), nowMs: NOW });
  assert.equal(r.status, 'REFUSED');
});
