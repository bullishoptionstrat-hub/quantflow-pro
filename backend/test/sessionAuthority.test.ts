/**
 * Four session questions, four answers — and a proof that they disagree.
 *
 * The audit of 2026-09-27 found that F-18 had centralised the right thing and
 * named it wrongly: one verdict answered "is the US options market open", and
 * that question has no single answer. These tests are about the separation
 * more than the tables: each asserts a moment where two authorities give
 * DIFFERENT answers, because a split that never disagrees would be one answer
 * with four names.
 *
 *   INV-SESSION-001  feed availability is not product tradability
 *   INV-SESSION-002  product tradability is not research eligibility
 *   INV-SESSION-003  provider session evidence outranks clock inference
 *   INV-CONTRACT-001 last trading time is product- and effective-date-specific
 *
 * Every table behind these answers is UNVERIFIED or SEARCH_ONLY (the primary
 * sources were unreachable on 2026-09-27). What is tested is the behaviour the
 * tables drive — including that anything they do not establish comes out
 * UNKNOWN rather than as a plausible default.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { feedSessionAt, FEED_WINDOW_RULES } from '../src/market/feedSessions';
import { productSessionAt, PRODUCT_SESSION_RULES } from '../src/market/productSessions';
import { contractLifecycle, contractSessionAt, CONTRACT_LIFECYCLE_RULES } from '../src/market/contractLifecycle';
import { H001_V2_SESSION_RULE, researchEligibility } from '../src/market/researchEligibility';
import { addDays, instantEt, minutesEt } from '../src/market/civil';
import { readSessionEvidence } from '../src/events/session';
import { marketSessionAt } from '../src/market/session';

/** 2026-09-24 is a Thursday, EDT (UTC-4). */
const et = (date: string, hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  const v = instantEt(date, h!, m!);
  assert.ok(v !== null, `${date} ${hhmm} ET does not exist`);
  return v;
};

// ─── Civil ───────────────────────────────────────────────────────────────────

test('civil: wall-clock instants round-trip across both US offsets', () => {
  assert.equal(new Date(et('2026-09-24', '16:00')).toISOString(), '2026-09-24T20:00:00.000Z');
  assert.equal(new Date(et('2026-12-24', '13:00')).toISOString(), '2026-12-24T18:00:00.000Z');
  assert.equal(instantEt('2026-03-08', 2, 30), null, 'a wall-clock time the DST jump skips does not exist');
  assert.equal(minutesEt(et('2026-11-01', '01:30')), 90);
  assert.equal(addDays('2026-02-28', 1), '2026-03-01');
  assert.equal(addDays('2026-02-30', 1), null, 'a date that does not round-trip was never a date');
});

// ─── Feed window ─────────────────────────────────────────────────────────────

test('feed: the OPRA window is effective-dated and nothing before it is assumed', () => {
  assert.equal(feedSessionAt('OPRA', et('2026-09-24', '07:29')).state, 'OUTSIDE_FEED_WINDOW');
  assert.equal(feedSessionAt('OPRA', et('2026-09-24', '07:30')).state, 'SUPPORTED');
  assert.equal(feedSessionAt('OPRA', et('2026-09-24', '16:59')).state, 'SUPPORTED');
  assert.equal(feedSessionAt('OPRA', et('2026-09-24', '17:00')).state, 'OUTSIDE_FEED_WINDOW');
  assert.equal(feedSessionAt('OPRA', et('2026-09-18', '08:00')).state, 'UNKNOWN', 'no window is recorded before 2026-09-21');
  assert.equal(feedSessionAt('OPRA', et('2026-09-26', '10:00')).state, 'UNKNOWN', 'a Saturday is not assumed to be outside the window');
  assert.equal(feedSessionAt('OPRA', et('2026-11-27', '12:00')).state, 'SUPPORTED', 'inside the early-close day\'s own hours');
  assert.equal(feedSessionAt('OPRA', et('2026-11-27', '14:00')).state, 'UNKNOWN', 'the window on a half day is not established');
  assert.equal(feedSessionAt('OPRA', Date.parse('2027-02-02T15:00:00Z')).state, 'UNKNOWN', 'past the calendar coverage');
  for (const r of FEED_WINDOW_RULES) {
    assert.equal(r.readAt, null, 'no feed rule has been read in a primary document yet; one that claims so must say when');
    assert.notEqual(r.status, 'PRIMARY_VERIFIED');
  }
});

// ─── Product sessions ────────────────────────────────────────────────────────

test('product: SPX trades in sessions an equity calendar cannot see', () => {
  const sun = productSessionAt('SPX', et('2026-09-27', '21:00'));
  assert.deepEqual([sun.state, sun.sessionClass, sun.tradeDate], ['OPEN', 'GLOBAL', '2026-09-28'],
    'Sunday evening is Monday\'s global session');
  assert.equal(productSessionAt('SPX', et('2026-09-25', '21:00')).state, 'CLOSED', 'no global session on a Friday night');
  assert.equal(productSessionAt('SPX', et('2026-11-25', '21:00')).state, 'CLOSED', 'the evening before Thanksgiving opens nothing');
  assert.deepEqual([productSessionAt('SPX', et('2026-09-28', '03:00')).sessionClass], ['GLOBAL']);
  assert.equal(productSessionAt('SPX', et('2026-09-28', '09:27')).state, 'CLOSED', 'between global and regular');
  assert.equal(productSessionAt('SPXW', et('2026-09-28', '16:10')).sessionClass, 'REGULAR', 'SPX runs to 16:15');
  assert.equal(productSessionAt('SPX', et('2026-09-28', '16:30')).sessionClass, 'CURB');
  assert.equal(productSessionAt('SPX', et('2026-09-28', '17:30')).state, 'CLOSED');
});

test('product: what a rule does not establish is UNKNOWN, never CLOSED and never OPEN', () => {
  assert.equal(productSessionAt('SPY', et('2026-09-24', '15:00')).state, 'OPEN');
  assert.equal(productSessionAt('SPY', et('2026-09-24', '16:10')).state, 'UNKNOWN', 'sources conflict on 16:15');
  assert.equal(productSessionAt('SPY', et('2026-09-24', '07:45')).state, 'UNKNOWN', 'extended sessions for SPY are not established');
  assert.equal(productSessionAt('SPY', et('2026-09-26', '11:00')).state, 'CLOSED', 'no session on a Saturday');
  assert.equal(productSessionAt('SPY', et('2026-11-26', '11:00')).state, 'CLOSED', 'Thanksgiving');
  assert.equal(productSessionAt('SPY', et('2026-11-27', '14:00')).state, 'UNKNOWN', 'after the half-day close');
  assert.equal(productSessionAt('ZZZZ', et('2026-09-24', '11:00')).state, 'UNKNOWN', 'an unregistered product');
  assert.equal(productSessionAt('SPXO', et('2026-10-01', '11:00')).state, 'UNKNOWN', 'SPXO before it is effective');
  assert.equal(productSessionAt('SPXO', et('2026-11-10', '11:00')).state, 'OPEN', 'SPXO once effective');
  for (const r of PRODUCT_SESSION_RULES) assert.notEqual(r.status, 'PRIMARY_VERIFIED');
});

// ─── Contract lifecycle ──────────────────────────────────────────────────────

test('lifecycle: AM-settled SPX stops the business day before; PM SPXW trades on the day', () => {
  const am = contractLifecycle('SPX', '2026-10-16');
  assert.equal(am.settlementStyle, 'AM');
  assert.equal(am.lastTradingDate, '2026-10-15');
  assert.equal(am.state, 'KNOWN');
  assert.equal(new Date(am.lastTradingInstantMs!).toISOString(), '2026-10-15T20:15:00.000Z');

  const pm = contractLifecycle('SPXW', '2026-10-16');
  assert.equal(pm.settlementStyle, 'PM');
  assert.equal(pm.lastTradingDate, '2026-10-16');
  assert.equal(new Date(pm.lastTradingInstantMs!).toISOString(), '2026-10-16T20:00:00.000Z');

  // The same instant, two contracts on the same index, two different answers.
  const friday10 = et('2026-10-16', '10:00');
  assert.equal(contractSessionAt('SPX', '2026-10-16', friday10).state, 'LAST_TRADING_DAY_ENDED');
  assert.equal(contractSessionAt('SPXW', '2026-10-16', friday10).state, 'OPEN');
  assert.equal(contractSessionAt('SPXW', '2026-10-16', et('2026-10-16', '16:05')).state, 'LAST_TRADING_DAY_ENDED');
  assert.equal(contractSessionAt('SPXW', '2026-10-16', et('2026-10-15', '16:05')).state, 'OPEN',
    'a non-expiring day of an SPXW series still runs to 16:15');
});

test('lifecycle: a holiday shift is followed through the calendar, and a closed-day expiry is refused', () => {
  // The third Friday of June 2026 is Juneteenth, so the monthly lists on the
  // Thursday and — being AM-settled — stops trading on the Wednesday.
  const shifted = contractLifecycle('SPX', '2026-06-18');
  assert.equal(shifted.lastTradingDate, '2026-06-17');
  const onHoliday = contractLifecycle('SPX', '2026-06-19');
  assert.equal(onHoliday.state, 'UNKNOWN');
  assert.match(onHoliday.reasons.join(' '), /no contract settles on a day without a session/);
});

test('lifecycle: a half day, a new family, an unknown product and an uncovered date all fail honestly', () => {
  const half = contractLifecycle('SPXW', '2026-11-27');
  assert.equal(half.state, 'DATE_ONLY');
  assert.equal(half.lastTradingInstantMs, null, 'neither 16:00 nor 13:00 is assumed on a half day');

  assert.equal(contractLifecycle('SPXO', '2026-11-04').state, 'UNKNOWN', 'SPXO series cannot predate the family');
  const spxo = contractLifecycle('SPXO', '2026-11-18');
  assert.equal(spxo.settlementStyle, 'AM');
  assert.equal(spxo.lastTradingDate, '2026-11-17');
  assert.equal(spxo.state, 'DATE_ONLY');

  for (const [root, expiry] of [['ZZZZ', '2026-10-16'], ['SPXW', '2027-03-19'], ['XSP', '2026-10-16'], ['SPX', 'not-a-date']] as const) {
    const life = contractLifecycle(root, expiry);
    assert.equal(life.state, 'UNKNOWN', `${root} ${expiry}`);
    assert.equal(life.lastTradingInstantMs, null, `${root} ${expiry}: no fabricated 16:00`);
    assert.equal(contractSessionAt(root, expiry, et('2026-09-24', '11:00')).state, 'UNKNOWN');
  }

  const spy = contractLifecycle('SPY', '2026-10-16');
  assert.deepEqual([spy.settlementStyle, spy.state, spy.lastTradingDate], ['PHYSICAL', 'DATE_ONLY', '2026-10-16']);
  assert.equal(contractSessionAt('SPY', '2026-10-16', et('2026-10-16', '15:00')).state, 'OPEN');
  assert.equal(contractSessionAt('SPY', '2026-10-16', et('2026-10-16', '16:05')).state, 'UNKNOWN',
    'the expiration-day close is contested, so after 16:00 nothing is claimed');
  for (const r of CONTRACT_LIFECYCLE_RULES) assert.notEqual(r.status, 'PRIMARY_VERIFIED');
});

// ─── The authorities disagree, which is the point ────────────────────────────

test('INV-SESSION-001: the feed window and the product session answer differently', () => {
  // 07:45: OPRA's stated window is open; SPY's session is not established.
  assert.equal(feedSessionAt('OPRA', et('2026-09-24', '07:45')).state, 'SUPPORTED');
  assert.equal(productSessionAt('SPY', et('2026-09-24', '07:45')).state, 'UNKNOWN');
  // 21:00: SPX is in its global session outside OPRA's stated window.
  assert.equal(productSessionAt('SPX', et('2026-09-24', '21:00')).state, 'OPEN');
  assert.equal(feedSessionAt('OPRA', et('2026-09-24', '21:00')).state, 'OUTSIDE_FEED_WINDOW');
});

test('INV-SESSION-002 / 003: a tradable product is not an eligible observation, and evidence beats the clock', () => {
  const curb = et('2026-09-24', '16:30');
  assert.equal(productSessionAt('SPX', curb).sessionClass, 'CURB');
  const eth = readSessionEvidence(1);
  assert.equal(researchEligibility(eth, curb, H001_V2_SESSION_RULE).eligibility, 'EXCLUDED');
  // Inside regular hours, the identifier still decides.
  const tenAm = et('2026-09-24', '10:00');
  assert.equal(researchEligibility(eth, tenAm, H001_V2_SESSION_RULE).eligibility, 'EXCLUDED');
  // No evidence at all: the clock may say REGULAR inside RTH, labelled as inference…
  const none = readSessionEvidence(null);
  const inferred = researchEligibility(none, tenAm, H001_V2_SESSION_RULE);
  assert.deepEqual([inferred.eligibility, inferred.basis], ['INCLUDED', 'CLOCK_INFERENCE']);
  // …and a rule may forbid even that.
  const strict = { ...H001_V2_SESSION_RULE, id: 'strict', clockInference: 'NEVER' as const };
  assert.equal(researchEligibility(none, tenAm, strict).eligibility, 'UNKNOWN');
  assert.ok(Object.isFrozen(H001_V2_SESSION_RULE), 'the preregistered rule cannot be edited at runtime');
});

test('the exchange-session verdict names its authority, so nothing renders it as "the market"', () => {
  const s = marketSessionAt(et('2026-09-24', '10:00'));
  assert.equal(s.authority, 'EXCHANGE_REGULAR_SESSION');
  assert.equal(s.state, 'OPEN');
});
