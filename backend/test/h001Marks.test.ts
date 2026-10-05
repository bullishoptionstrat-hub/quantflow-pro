/**
 * H-001-v2 §C as code (`research/h001Marks.ts`): the two prices a return is
 * measured between.
 *
 * Every case here is a way for a backtest to see a price a trader could not
 * have had, or to report a return from a mark the rule refuses. Each is built
 * so the wrong rule would produce a DIFFERENT, plausible number — a test that
 * only checks "a number came out" passes for every one of these defects.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  h001Return, markAt, H001_ENTRY_LATENCY_MS, H001_ENTRY_MAX_AGE_MS, H001_HORIZON_MS,
} from '../src/research/h001Marks';
import type { UnderlyingQuote } from '../src/research/h001Marks';
import * as eligibility from '../src/research/h001Eligibility';

const D = Date.parse('2026-03-10T15:00:00.000Z'); // a decision at 11:00 ET
const T_ENTRY = D + H001_ENTRY_LATENCY_MS;
const T_EXIT = T_ENTRY + H001_HORIZON_MS;

const q = (eventTime: number, bid: number | null, ask: number | null, availableAt = eventTime + 5): UnderlyingQuote =>
  ({ provider: 'p', eventTime, availableAt, bid, ask });

const ok = (r: ReturnType<typeof h001Return>) => {
  assert.equal(r.status, 'OK', JSON.stringify(r));
  return r as Extract<typeof r, { status: 'OK' }>;
};

test('§C constants are the frozen ones, and the eligibility window reads the same copy', () => {
  assert.equal(H001_ENTRY_LATENCY_MS, 1_000);
  assert.equal(H001_ENTRY_MAX_AGE_MS, 2_000);
  assert.equal(H001_HORIZON_MS, 900_000);
  // One home: the eligibility module re-exports these, it does not redefine them.
  assert.equal(eligibility.H001_ENTRY_LATENCY_MS, H001_ENTRY_LATENCY_MS);
  assert.equal(eligibility.H001_HORIZON_MS, H001_HORIZON_MS);
});

test('the return is 10,000 × ln(exit mid / entry mid), in basis points', () => {
  const r = ok(h001Return(D, [q(D - 500, 549.99, 550.01), q(T_EXIT - 100, 550.54, 550.56)]));
  assert.equal(r.entry.midpoint, 550);
  assert.equal(r.exit.midpoint, 550.55);
  assert.ok(Math.abs(r.returnBp - 10_000 * Math.log(550.55 / 550)) < 1e-9);
  assert.ok(Math.abs(r.returnBp - 9.995) < 0.01, 'about 10 bp');
  assert.equal(r.exitAgeMs, 100);
});

test('the entry quote must be KNOWN by t_entry, not merely stamped before it', () => {
  // Stamped before t_entry, arrived after it: no live book held it at t_entry.
  const fresher = q(T_ENTRY - 100, 551.99, 552.01, T_ENTRY + 400);
  const older = q(T_ENTRY - 1_500, 549.99, 550.01, T_ENTRY - 1_400);
  const r = ok(h001Return(D, [older, fresher, q(T_EXIT, 550, 550.02)]));
  assert.equal(r.entry.midpoint, 550, 'the quote a trader had, not the fresher one that had not arrived');
  // With only the late-arriving quote there is no entry at all.
  assert.equal(h001Return(D, [fresher, q(T_EXIT, 550, 550.02)]).status, 'NO_ENTRY_MARK');
});

test('an entry quote older than 2 s is refused, and exactly 2 s is not', () => {
  const at = (age: number) => h001Return(D, [q(T_ENTRY - age, 549.99, 550.01, T_ENTRY - age), q(T_EXIT, 550, 550.02)]);
  assert.equal(at(H001_ENTRY_MAX_AGE_MS).status, 'OK');
  const stale = at(H001_ENTRY_MAX_AGE_MS + 1);
  assert.equal(stale.status, 'NO_ENTRY_MARK');
  assert.equal(stale.status === 'NO_ENTRY_MARK' && stale.entry.refusal, 'STALE');
});

test('the exit is measured on the final tape: a late-arriving quote stamped before t_exit counts', () => {
  const lateArrival = q(T_EXIT - 50, 551.09, 551.11, T_EXIT + 60_000);
  const r = ok(h001Return(D, [q(D, 549.99, 550.01), q(T_EXIT - 5_000, 550.99, 551.01), lateArrival]));
  assert.equal(r.exit.midpoint, 551.1);
  // And a quote stamped AFTER t_exit never does, however early it is known.
  const after = q(T_EXIT + 1, 560, 560.02, T_EXIT - 1);
  assert.equal(ok(h001Return(D, [q(D, 549.99, 550.01), q(T_EXIT - 5_000, 550.99, 551.01), after])).exit.midpoint, 551);
});

test('the latest quote is the book: a one-sided or crossed one refuses the mark, never falls back', () => {
  const clean = q(T_ENTRY - 800, 549.99, 550.01);
  for (const [bid, ask] of [[null, 550.01], [549.99, null], [550.02, 550.01]] as const) {
    const r = h001Return(D, [clean, q(T_ENTRY - 100, bid, ask), q(T_EXIT, 550, 550.02)]);
    assert.equal(r.status, 'NO_ENTRY_MARK', `bid ${bid} ask ${ask}`);
    assert.equal(r.status === 'NO_ENTRY_MARK' && r.entry.refusal, 'NO_MIDPOINT');
  }
  // A broken book beside a clean one at the same instant is not resolved by
  // keeping the clean one: which of them the market showed is not known.
  const mixed = h001Return(D, [q(T_ENTRY - 100, 549.99, 550.01), q(T_ENTRY - 100, null, 550.01), q(T_EXIT, 550, 550.02)]);
  assert.equal(mixed.status === 'NO_ENTRY_MARK' && mixed.entry.refusal, 'NO_MIDPOINT');
  // A locked book has a midpoint and is kept.
  assert.equal(ok(h001Return(D, [q(T_ENTRY - 100, 550, 550), q(T_EXIT, 550, 550.02)])).entry.midpoint, 550);
  // The exit obeys the same rule.
  const r = h001Return(D, [clean, q(T_EXIT - 10, 550, 550.02), q(T_EXIT - 1, null, 550.02)]);
  assert.equal(r.status, 'NO_EXIT_MARK');
});

test('books disagreeing at the latest instant are AMBIGUOUS; agreeing ones are one book', () => {
  const twin = (bid: number) => q(T_ENTRY - 100, bid, bid + 0.02);
  const amb = h001Return(D, [twin(549.99), twin(550.09), q(T_EXIT, 550, 550.02)]);
  assert.equal(amb.status === 'NO_ENTRY_MARK' && amb.entry.refusal, 'AMBIGUOUS');
  assert.equal(h001Return(D, [twin(549.99), twin(549.99), q(T_EXIT, 550, 550.02)]).status, 'OK');
});

test('no quote at all is NO_QUOTE, and entry is checked before exit', () => {
  const none = h001Return(D, []);
  assert.equal(none.status === 'NO_ENTRY_MARK' && none.entry.refusal, 'NO_QUOTE');
  const noExit = markAt([q(T_EXIT + 10, 550, 550.02)], T_EXIT, { requireAvailableBy: false, maxAgeMs: null });
  assert.equal(!noExit.ok && noExit.refusal, 'NO_QUOTE');
});

test('the exit age is reported, because §C does not bound it', () => {
  // A feed that went quiet after the entry: the exit mark is 15 minutes old.
  const r = ok(h001Return(D, [q(T_ENTRY - 10, 549.99, 550.01)]));
  assert.equal(r.exitAgeMs, H001_HORIZON_MS + 10, 'the rule as frozen lets this through, and says how old it was');
  assert.equal(r.returnBp, 0, 'which is how a stale exit reads: a flat return');
});

test('one clock domain: quotes from two providers are refused outright', () => {
  assert.throws(() => h001Return(D, [q(D, 549.99, 550.01), { ...q(T_EXIT, 550, 550.02), provider: 'other' }]), RangeError);
  assert.throws(() => h001Return(Number.NaN, []), RangeError);
});
