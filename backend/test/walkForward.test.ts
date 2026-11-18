/**
 * Walk-forward folds never let a test window see training time, and the
 * Wilson interval matches hand-worked values.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { walkForwardFolds, walkForwardRefusals, wilsonInterval } from '../src/research/walkForward';

const D = 86_400_000;
const base = { startMs: 0, endMs: 100 * D, trainMs: 40 * D, testMs: 10 * D, embargoMs: 2 * D };

test('rolling folds: chronological, embargoed, non-overlapping, fixed train length', () => {
  const f = walkForwardFolds({ ...base, mode: 'ROLLING' });
  assert.equal(f.length, 5);
  for (const x of f) {
    assert.equal(x.trainEndMs - x.trainStartMs, 40 * D);
    assert.equal(x.testStartMs - x.trainEndMs, 2 * D);
    assert.ok(x.testEndMs <= 100 * D);
  }
  for (let i = 1; i < f.length; i++) assert.ok(f[i].testStartMs >= f[i - 1].testEndMs);
});

test('anchored folds all start at the data start', () => {
  const f = walkForwardFolds({ ...base, mode: 'ANCHORED' });
  assert.ok(f.length > 1);
  for (const x of f) assert.equal(x.trainStartMs, 0);
  assert.ok(f[1].trainEndMs > f[0].trainEndMs);
});

test('a span too short for one fold yields none, never a shortened one', () => {
  assert.deepEqual(walkForwardFolds({ ...base, endMs: 51 * D, mode: 'ROLLING' }), []);
  assert.equal(walkForwardFolds({ ...base, endMs: 52 * D, mode: 'ROLLING' }).length, 1);
});

test('bad specs are refused by name', () => {
  assert.ok(walkForwardRefusals({ ...base, embargoMs: -1, mode: 'ROLLING' }).some((r) => r.includes('embargoMs')));
  assert.ok(walkForwardRefusals({ ...base, trainMs: NaN, mode: 'ROLLING' }).some((r) => r.includes('trainMs')));
  assert.throws(() => walkForwardFolds({ ...base, endMs: 0, mode: 'ROLLING' }));
});

test('wilson interval: hand-worked values and no interval for n=0', () => {
  assert.equal(wilsonInterval(0, 0), null);
  const a = wilsonInterval(18, 30)!;
  assert.ok(Math.abs(a.low - 0.4232) < 1e-3 && Math.abs(a.high - 0.7541) < 1e-3, JSON.stringify(a));
  const z = wilsonInterval(0, 10)!;
  assert.equal(z.low, 0);
  assert.ok(Math.abs(z.high - 0.2775) < 1e-3);
  assert.throws(() => wilsonInterval(5, 3));
});
