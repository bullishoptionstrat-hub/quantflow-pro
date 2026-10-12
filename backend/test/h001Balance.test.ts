/**
 * H-001-v2 §G's trailing-volatility balance diagnostic (`research/h001Balance.ts`).
 *
 * The realised volatility is checked against a midpoint path whose minute
 * returns are known in advance; the standardized difference against numbers
 * worked by hand, chosen so the 1/k control weights (V4) give a different
 * answer from an unweighted pool — a weighting that silently fell away would
 * otherwise pass.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { trailingRv, smdOfPairs, h001VolBalance, H001_RV_WINDOW_MS, H001_RV_STEP_MS, H001_SMD_FLAG } from '../src/research/h001Balance';
import type { UnderlyingQuote } from '../src/research/h001Marks';
import type { AMatch, Control } from '../src/research/h001Controls';

const DAY = '2026-03-10'; // EDT: 14:00Z is 10:00 ET
const ET = (h: number, m: number, s = 0) =>
  Date.parse(`${DAY}T${String(h + 4).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.000Z`);

/** Minute returns, in bp, cycled; the midpoint is constant within each minute. */
const PATTERN = [3, -2, 5, 0, -4, 1.5, 2, -6];
function path(): { quotes: UnderlyingQuote[]; midAtMinute: (t: number) => number } {
  const open = ET(9, 30);
  const mids: number[] = [550];
  for (let k = 1; k <= 120; k++) mids.push(mids[k - 1]! * Math.exp(PATTERN[k % PATTERN.length]! / 10_000));
  const midAtMinute = (t: number) => mids[Math.floor((t - open) / 60_000)]!;
  const quotes: UnderlyingQuote[] = [];
  for (let t = open; t < open + 120 * 60_000; t += 1_000) {
    const mid = midAtMinute(t);
    quotes.push({ provider: 'p', eventTime: t, availableAt: t, bid: mid - 0.01, ask: mid + 0.01 });
  }
  return { quotes, midAtMinute };
}

test('the frozen numbers: 30 minutes, one-minute steps, |SMD| > 0.1', () => {
  assert.equal(H001_RV_WINDOW_MS, 30 * 60_000);
  assert.equal(H001_RV_STEP_MS, 60_000);
  assert.equal(H001_SMD_FLAG, 0.1);
});

test('V1: realised volatility is √Σr² of the thirty one-minute midpoint returns ending at t_entry', () => {
  const { quotes, midAtMinute } = path();
  const anchor = ET(10, 29, 59); // t_entry = 10:30:00, a minute boundary
  const end = anchor + 1_000;
  let ss = 0;
  for (let k = 1; k <= 30; k++) {
    const r = 10_000 * Math.log(midAtMinute(end - (30 - k) * 60_000) / midAtMinute(end - (31 - k) * 60_000));
    ss += r * r;
  }
  const rv = trailingRv(anchor, quotes);
  assert.ok(rv.ok);
  assert.ok(Math.abs(rv.rvBp - Math.sqrt(ss)) < 1e-6, `${rv.rvBp} vs ${Math.sqrt(ss)}`);
  assert.ok(rv.rvBp > 10, 'a real dispersion, not a zero from a misread grid');
});

test('V2: a quote stamped before a grid instant but known after it is not used', () => {
  // No quote stamped exactly at the 10:10 mark, so the latest STAMPED by it is
  // a wild book from 100 ms before, delivered 100 ms after; the latest KNOWN
  // by it is the 10:09:59 quote, one second old.
  const quotes = path().quotes.filter((q) => q.eventTime !== ET(10, 10, 0));
  const anchor = ET(10, 29, 59);
  const clean = trailingRv(anchor, quotes);
  const late: UnderlyingQuote = { provider: 'p', eventTime: ET(10, 9, 59) + 900, availableAt: ET(10, 10, 0) + 100, bid: 600, ask: 600.02 };
  const withLate = trailingRv(anchor, [...quotes, late]);
  assert.ok(clean.ok);
  assert.deepEqual(withLate, clean);
});

test('V2, V3: a stale or missing mark makes the unit unmeasurable, never filled', () => {
  const { quotes } = path();
  const anchor = ET(10, 29, 59);
  // A five-second outage ending at the 10:10 mark: the latest known quote is 6 s old.
  const outage = quotes.filter((q) => !(q.eventTime > ET(10, 9, 54) && q.eventTime <= ET(10, 10, 0)));
  const r = trailingRv(anchor, outage);
  assert.equal(r.ok, false);
  assert.match((r as { why: string }).why, /STALE/);
});

test('V3: a window reaching before the regular open is unmeasurable, even with pre-market quotes present', () => {
  const { quotes } = path();
  // Pre-market quotes from 08:00, so a window from 09:10 has every mark it asks for.
  const pre: UnderlyingQuote[] = [];
  for (let t = ET(8, 0); t < ET(9, 30); t += 1_000) pre.push({ provider: 'p', eventTime: t, availableAt: t, bid: 549.99, ask: 550.01 });
  const early = trailingRv(ET(9, 40), [...pre, ...quotes]);
  assert.equal(early.ok, false);
  assert.match((early as { why: string }).why, /before the regular open/);
  // The first measurable instant: t_entry exactly 30 minutes after the open.
  assert.equal(trailingRv(ET(9, 59, 59), [...pre, ...quotes]).ok, true);
  assert.equal(trailingRv(ET(9, 59, 58), [...pre, ...quotes]).ok, false);
  // A Saturday has no session the calendar can open, quotes or not.
  const sat = Date.parse('2026-03-14T15:00:00.000Z');
  const satQuotes = [...pre, ...quotes].map((q) => ({ ...q, eventTime: q.eventTime + 4 * 86_400_000, availableAt: q.availableAt + 4 * 86_400_000 }));
  const r = trailingRv(sat, satQuotes);
  assert.equal(r.ok, false);
  assert.match((r as { why: string }).why, /cannot place/);
});

test('V4, V5: each A weight 1, each of its k controls 1/k — worked by hand', () => {
  // A = 10, 14, 12: mean 12, var 4.
  // C weighted: (8+12)/2 = 10, 9, (10+10+13)/3 = 11 → mean 10;
  //   var = (½·4 + ½·4 + 1·1 + ⅓·(0+0+9)) / (3 − 1) = 4.
  // SMD = (12 − 10) / √((4 + 4)/2) = 1. Unweighted, the C mean would be 10.33.
  const r = smdOfPairs([{ a: 10, c: [8, 12] }, { a: 14, c: [9] }, { a: 12, c: [10, 10, 13] }]);
  assert.ok(Math.abs(r.meanABp! - 12) < 1e-12);
  assert.ok(Math.abs(r.meanCBp! - 10) < 1e-12);
  assert.ok(Math.abs(r.sdCBp! - 2) < 1e-12);
  assert.ok(Math.abs(r.smd! - 1) < 1e-12);
  assert.equal(r.flagged, true);
  assert.equal(r.n.pairs, 3);
  assert.equal(r.n.controls, 6);
  assert.equal(r.decides, false);
});

test('V5: imbalance in either direction is flagged, and a small one is not', () => {
  // A = 8, 12 (mean 10, var 8); C = 10, 14 (mean 12, var 8): SMD = −2/√8.
  const below = smdOfPairs([{ a: 8, c: [10] }, { a: 12, c: [14] }]);
  assert.ok(Math.abs(below.smd! + 2 / Math.sqrt(8)) < 1e-12);
  assert.equal(below.flagged, true);
  const small = smdOfPairs([{ a: 10, c: [10.1] }, { a: 12, c: [12.1] }]);
  assert.ok(Math.abs(small.smd!) < H001_SMD_FLAG);
  assert.equal(small.flagged, false);
});

test('too few pairs, or no spread, gives no SMD — and says why', () => {
  const one = smdOfPairs([{ a: 10, c: [9] }], { unmeasuredA: 2, noMeasuredControl: 1, unmeasuredControls: 0 });
  assert.equal(one.smd, null);
  assert.equal(one.flagged, null);
  assert.ok(one.reasons.some((s) => s.includes('2 matched A')));
  assert.ok(one.reasons.some((s) => s.includes('at least two')));
  const flat = smdOfPairs([{ a: 10, c: [10] }, { a: 10, c: [10] }]);
  assert.equal(flat.smd, null);
  assert.ok(flat.reasons.some((s) => s.includes('zero spread')));
  assert.throws(() => smdOfPairs([{ a: 1, c: [] }, { a: 2, c: [1] }]), RangeError);
});

test('V4: each unit is measured from its own anchor, and an unmeasurable one is counted on its side', () => {
  const { quotes } = path();
  const ctl = (anchor: number): Control => ({ eventId: `c${anchor}`, key: null as never, anchor, returnBp: 0 });
  const match = (id: string, anchor: number, controls: Control[]): AMatch => ({
    metaEventId: id, date: DAY, anchor, status: 'MATCHED', key: null, why: null, returnBp: 0,
    controls, controlMeanBp: 0, differenceBp: 0,
  });
  const r = h001VolBalance([
    // A measurable; one control ten minutes after the open (window before the first quote), one fine.
    match('A:1', ET(10, 29, 59), [ctl(ET(9, 40)), ctl(ET(10, 45))]),
    match('A:2', ET(10, 50), [ctl(ET(10, 55))]),
    // A itself ten minutes after the open: out, with its controls.
    match('A:3', ET(9, 40), [ctl(ET(10, 20))]),
    // Every control unmeasurable: out.
    match('A:4', ET(11, 0), [ctl(ET(9, 41)), ctl(ET(9, 42))]),
    { ...match('A:5', ET(11, 5), []), status: 'NO_MATCH' },
  ], quotes);
  assert.deepEqual(r.n, { pairs: 2, controls: 2, unmeasuredA: 1, noMeasuredControl: 1, unmeasuredControls: 1 });
  assert.ok(r.smd !== null);
  assert.throws(() => h001VolBalance([match('A:x', ET(10, 30), [])], quotes), RangeError);
});

test('the diagnostic decides nothing: the verdict module never reads it', () => {
  const src = readFileSync(join(__dirname, '../src/research/h001Verdict.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(src, /h001Balance|VolBalance|smdOfPairs/);
});
