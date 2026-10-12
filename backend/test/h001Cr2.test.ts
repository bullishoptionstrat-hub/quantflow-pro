/**
 * H-001-v2 §D's CR2 cross-check (`research/h001Cr2.ts`).
 *
 * The closed form in that module is a derivation, so it is checked three ways
 * that do not share it: two textbook identities (singleton days give s²/N;
 * equal days give G/(G−1)·CR0), and a brute-force evaluation of the general
 * matrix formula — A_g = (I − H_gg)^(-1/2) by eigendecomposition, the
 * Bell–McCaffrey degrees of freedom from the explicit residual-maker — on an
 * unbalanced sample. If any of the three disagrees, the formula is wrong.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { h001Cr2Interval, studentTCdf, studentTQuantile, regularizedBeta } from '../src/research/h001Cr2';
import type { Observation } from '../src/research/h001Verdict';

const close = (a: number, b: number, tol: number, what: string) =>
  assert.ok(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `${what}: ${a} vs ${b}`);

const day = (i: number) => `2026-01-${String(5 + i).padStart(2, '0')}`;

test('Student t quantiles match the published table, including df = 1 and large df', () => {
  // Two-sided 95% critical values (0.975 quantiles), from standard tables.
  const table: Array<[number, number]> = [
    [1, 12.7062047], [2, 4.30265273], [5, 2.57058184], [10, 2.22813885],
    [30, 2.04227246], [120, 1.97993040], [1e6, 1.95996635],
  ];
  for (const [df, t] of table) close(studentTQuantile(0.975, df), t, 1e-7, `t(0.975, ${df})`);
  close(studentTQuantile(0.95, 10), 1.81246112, 1e-7, 't(0.95, 10)');
  assert.equal(studentTQuantile(0.5, 7), 0);
  close(studentTQuantile(0.025, 10), -2.22813885, 1e-7, 'lower tail is the mirror');
  // Non-integer df: the quantile inverts the CDF, and sits between its neighbours.
  const q = studentTQuantile(0.975, 7.4);
  close(studentTCdf(q, 7.4), 0.975, 1e-10, 'CDF(quantile) round trip');
  assert.ok(q < studentTQuantile(0.975, 7) && q > studentTQuantile(0.975, 8));
  close(regularizedBeta(0.3, 2, 3), 0.3483, 1e-12, 'I_0.3(2,3) closed form');
  assert.throws(() => studentTQuantile(0.975, 0), RangeError);
  assert.throws(() => studentTQuantile(1, 5), RangeError);
});

test('singleton days: CR2 is s²/N and the degrees of freedom are N − 1', () => {
  const xs = [1.5, -2, 0.25, 3, -0.75, 4, 2.2];
  const obs = xs.map((v, i) => ({ date: day(i), valueBp: v }));
  const r = h001Cr2Interval(obs);
  const N = xs.length;
  const mean = xs.reduce((a, b) => a + b, 0) / N;
  const s2 = xs.reduce((a, x) => a + (x - mean) ** 2, 0) / (N - 1);
  close(r.estimateBp!, mean, 1e-12, 'estimate');
  close(r.seBp!, Math.sqrt(s2 / N), 1e-12, 'se = s/√N');
  close(r.df!, N - 1, 1e-12, 'df');
  const t = studentTQuantile(0.975, N - 1);
  close(r.ci95!.lo, mean - t * Math.sqrt(s2 / N), 1e-12, 'lo');
  close(r.ci95!.hi, mean + t * Math.sqrt(s2 / N), 1e-12, 'hi');
});

test('equal-sized days: CR2 is G/(G−1) × CR0 and the degrees of freedom are G − 1', () => {
  const G = 6;
  const per = 4;
  const obs: Observation[] = [];
  for (let g = 0; g < G; g++) for (let k = 0; k < per; k++) obs.push({ date: day(g), valueBp: Math.sin(g * 7 + k * 3) * 5 + g });
  const r = h001Cr2Interval(obs);
  const N = obs.length;
  const mean = obs.reduce((a, o) => a + o.valueBp, 0) / N;
  let cr0 = 0;
  for (let g = 0; g < G; g++) {
    const s = obs.filter((o) => o.date === day(g)).reduce((a, o) => a + o.valueBp - mean, 0);
    cr0 += s * s;
  }
  cr0 /= N * N;
  close(r.seBp! ** 2, (G / (G - 1)) * cr0, 1e-12, 'V');
  close(r.df!, G - 1, 1e-12, 'df');
});

// ─── Brute force: the general CR2 formula with explicit matrices ────────────

type M = number[][];
const zeros = (r: number, c: number): M => Array.from({ length: r }, () => new Array<number>(c).fill(0));
const mul = (a: M, b: M): M => a.map((row) => b[0]!.map((_, j) => row.reduce((s, x, k) => s + x * b[k]![j]!, 0)));
const tr = (a: M) => a.reduce((s, row, i) => s + row[i]!, 0);

/** Symmetric eigendecomposition by cyclic Jacobi rotations. */
function jacobi(a0: M): { values: number[]; vectors: M } {
  const n = a0.length;
  const a = a0.map((r) => [...r]);
  const v = zeros(n, n);
  for (let i = 0; i < n; i++) v[i]![i] = 1;
  for (let sweep = 0; sweep < 100; sweep++) {
    let off = 0;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) off += a[i]![j]! ** 2;
    if (off < 1e-24) break;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) {
      if (Math.abs(a[p]![q]!) < 1e-300) continue;
      const theta = (a[q]![q]! - a[p]![p]!) / (2 * a[p]![q]!);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1);
      const s = t * c;
      for (let k = 0; k < n; k++) {
        const akp = a[k]![p]!; const akq = a[k]![q]!;
        a[k]![p] = c * akp - s * akq; a[k]![q] = s * akp + c * akq;
      }
      for (let k = 0; k < n; k++) {
        const apk = a[p]![k]!; const aqk = a[q]![k]!;
        a[p]![k] = c * apk - s * aqk; a[q]![k] = s * apk + c * aqk;
      }
      for (let k = 0; k < n; k++) {
        const vkp = v[k]![p]!; const vkq = v[k]![q]!;
        v[k]![p] = c * vkp - s * vkq; v[k]![q] = s * vkp + c * vkq;
      }
    }
  }
  return { values: a.map((r, i) => r[i]!), vectors: v };
}

function invSqrt(a: M): M {
  const { values, vectors } = jacobi(a);
  const n = a.length;
  const out = zeros(n, n);
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    let s = 0;
    for (let k = 0; k < n; k++) s += vectors[i]![k]! * vectors[j]![k]! / Math.sqrt(values[k]!);
    out[i]![j] = s;
  }
  return out;
}

test('unbalanced days: the closed form equals the general matrix formula, variance and df', () => {
  const sizes = [1, 5, 2, 7, 3];
  const obs: Observation[] = [];
  sizes.forEach((n, g) => { for (let k = 0; k < n; k++) obs.push({ date: day(g), valueBp: Math.cos(g * 2.3 + k * 1.7) * 4 + 0.5 * g }); });
  const N = obs.length;
  const y = obs.map((o) => o.valueBp);
  const mean = y.reduce((a, b) => a + b, 0) / N;
  const e = y.map((v) => v - mean);

  // Residual maker M = I − 11'/N; cluster blocks of H are J/N.
  const Mres = zeros(N, N);
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) Mres[i]![j] = (i === j ? 1 : 0) - 1 / N;
  let V = 0;
  const cols: number[][] = []; // the vectors g_g = M a_g with V = Σ (g_g' y)²
  let start = 0;
  for (const n of sizes) {
    const block = zeros(n, n);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) block[i]![j] = (i === j ? 1 : 0) - 1 / N;
    const A = invSqrt(block);
    // a_g = (1/N) · A_g' 1_g, embedded at the cluster's rows.
    const a = new Array<number>(N).fill(0);
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) a[start + j]! += A[i]![j]! / N;
    const term = a.reduce((s, x, i) => s + x * e[i]!, 0);
    V += term * term;
    cols.push(Mres.map((row) => row.reduce((s, x, k) => s + x * a[k]!, 0)));
    start += n;
  }
  const Q: M = cols.map((gi) => cols.map((gj) => gi.reduce((s, x, k) => s + x * gj[k]!, 0)));
  const dfBrute = tr(Q) ** 2 / tr(mul(Q, Q));

  const r = h001Cr2Interval(obs);
  close(r.seBp! ** 2, V, 1e-10, 'V');
  close(r.df!, dfBrute, 1e-10, 'df');
  assert.ok(r.df! < sizes.length - 1, 'unequal days cost degrees of freedom below G − 1');
});

test('fewer than two days gives no interval, and the order of input does not matter', () => {
  assert.deepEqual(h001Cr2Interval([]), { estimateBp: null, seBp: null, df: null, ci95: null, n: { observations: 0, days: 0 }, decides: false });
  const one = h001Cr2Interval([{ date: day(0), valueBp: 1 }, { date: day(0), valueBp: 3 }]);
  assert.equal(one.estimateBp, 2);
  assert.equal(one.ci95, null);
  // 0.1 + 0.2 + 0.3 and 0.3 + 0.2 + 0.1 differ in the last bit, so a sum taken
  // in input order would make the reported bytes depend on the listing.
  assert.notEqual(0.1 + 0.2 + 0.3, 0.3 + 0.2 + 0.1);
  const obs = [0.1, 0.2, 0.3, 0].map((v, i) => ({ date: day(i < 3 ? 0 : 1), valueBp: v }));
  assert.deepEqual(h001Cr2Interval([...obs].reverse()), h001Cr2Interval(obs));
  assert.throws(() => h001Cr2Interval([{ date: day(0), valueBp: NaN }, { date: day(1), valueBp: 1 }]), RangeError);
});

test('the cross-check decides nothing: the verdict module never reads it', () => {
  // Comments stripped first: R5 names this module in prose, and a scan that
  // matches its own explanation is the mistake the CSV guard made.
  const src = readFileSync(join(__dirname, '../src/research/h001Verdict.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(src, /h001Cr2|Cr2Interval/);
  assert.equal(h001Cr2Interval([{ date: day(0), valueBp: 1 }, { date: day(1), valueBp: 2 }]).decides, false);
});
