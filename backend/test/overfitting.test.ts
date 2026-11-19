/**
 * PBO by CSCV and the Probabilistic/Deflated Sharpe Ratios against hand-worked
 * values and values from an independent implementation (Python's
 * statistics.NormalDist and a brute-force CSCV, run once and pasted here).
 * The CRAN `pbo` vignette comparison the plan asks for was NOT made: CRAN is
 * refused by this environment's network policy.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pboCscv, probabilisticSharpe, deflatedSharpe, expectedMaxSharpe, normalCdf, normalInv } from '../src/research/overfitting';

const near = (a: number, b: number, tol: number) => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b}`);

test('normal CDF and its inverse', () => {
  near(normalCdf(0), 0.5, 2e-7);
  near(normalCdf(1.959963984540054), 0.975, 2e-7);
  near(normalCdf(-1), 0.15865525393145707, 2e-7);
  near(normalInv(0.975), 1.959963984540054, 1e-6);
  near(normalInv(0.001), -3.090232306167813, 1e-6);
  near(normalInv(0.999), 3.090232306167813, 1e-6);
  assert.throws(() => normalInv(0));
  assert.throws(() => normalInv(1));
});

test('PBO hand-worked: a column best in sample and worst out of sample every time is 1; a dominant column is 0', () => {
  const anti = pboCscv([[1, 0], [0, 1]], 2);
  assert.equal(anti.status, 'OK'); if (anti.status === 'OK') { assert.equal(anti.pbo, 1); assert.equal(anti.combinations, 2); }
  const dom = pboCscv([[1, 0], [1, 0]], 2);
  assert.equal(dom.status, 'OK'); if (dom.status === 'OK') assert.equal(dom.pbo, 0);
});

test('PBO matches an independent brute force on a 6x3 matrix, and lambda = 0 counts as overfit', () => {
  const M = [[3, 1, 2], [-1, 2, 0], [2, 0, 1], [0, 1, 3], [1, 3, -2], [2, -1, 1]];
  const r = pboCscv(M, 6);
  assert.equal(r.status, 'OK'); if (r.status !== 'OK') return;
  assert.equal(r.combinations, 20);
  assert.equal(r.pbo, 0.9);
  assert.equal(r.lambdas.filter((l) => l === 0).length, 2);
  near(r.lambdas[0]!, 0.510825623766, 1e-9);
  near(r.lambdas[19]!, 1.098612288668, 1e-9);
});

test('PBO on an 8x4 matrix with S=4 matches the brute force', () => {
  const M = Array.from({ length: 8 }, (_, i) => Array.from({ length: 4 }, (_, j) => ((i * 7 + j * 13) % 11) - 5 + (i < 4 ? 0.3 * j : -0.3 * j)));
  const r = pboCscv(M, 4);
  assert.equal(r.status, 'OK'); if (r.status === 'OK') { assert.equal(r.pbo, 1); assert.equal(r.combinations, 6); }
});

test('PBO refuses rather than drops: odd S, a remainder, ragged rows, one column, non-finite values', () => {
  const ok = [[1, 0], [0, 1], [1, 1], [0, 0]];
  assert.equal(pboCscv(ok, 3).status, 'REFUSED');
  assert.equal(pboCscv([...ok, [1, 1]], 4).status, 'REFUSED');
  assert.equal(pboCscv([[1, 0], [1]], 2).status, 'REFUSED');
  assert.equal(pboCscv([[1], [0]], 2).status, 'REFUSED');
  assert.equal(pboCscv([[1, NaN], [0, 1]], 2).status, 'REFUSED');
  assert.equal(pboCscv([], 2).status, 'REFUSED');
});

test('PSR hand-worked: SR 0.1, T 101, normal returns, benchmark 0', () => {
  const r = probabilisticSharpe({ sr: 0.1, T: 101, skew: 0, kurtosis: 3 }, 0);
  assert.equal(r.status, 'OK'); if (r.status === 'OK') near(r.value, 0.8407413278013518, 3e-7);
  const s = probabilisticSharpe({ sr: 0.08, T: 252, skew: -0.5, kurtosis: 5 }, 0.02);
  assert.equal(s.status, 'OK'); if (s.status === 'OK') near(s.value, 0.8236239301179653, 3e-7);
});

test('DSR: the expected maximum of 100 trials and the deflated ratio', () => {
  const star = expectedMaxSharpe(100, 0.0025);
  assert.equal(star.status, 'OK'); if (star.status === 'OK') near(star.value, 0.12653014466008425, 1e-6);
  const d = deflatedSharpe({ sr: 0.12, T: 1000, skew: -0.3, kurtosis: 4 }, 100, 0.0025);
  assert.equal(d.status, 'OK'); if (d.status === 'OK') near(d.value, 0.4200633228736651, 5e-6);
});

test('Sharpe inputs are refused rather than guessed', () => {
  assert.equal(probabilisticSharpe({ sr: 0.1, T: 1, skew: 0, kurtosis: 3 }, 0).status, 'REFUSED');
  assert.equal(probabilisticSharpe({ sr: 0.1, T: 50, skew: 0, kurtosis: 0.5 }, 0).status, 'REFUSED');
  assert.equal(probabilisticSharpe({ sr: NaN, T: 50, skew: 0, kurtosis: 3 }, 0).status, 'REFUSED');
  assert.equal(expectedMaxSharpe(1, 0.01).status, 'REFUSED');
  assert.equal(expectedMaxSharpe(10, -1).status, 'REFUSED');
});
