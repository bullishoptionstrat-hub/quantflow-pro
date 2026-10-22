/**
 * ROADMAP 5.2 — "overnight" is derived from the published session calendar,
 * not from a clock, and a window the buffer could not fully see says so.
 *
 * The cases are chosen where a clock-only rule ("since yesterday at 16:00")
 * would be wrong: a Monday, the day after a holiday, a half day, a DST change
 * inside the window, and the edge of the calendar's coverage.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { instantEt } from '../src/market/civil';
import { overnightWindowAt, previousCloseBefore, selectWindow } from '../src/market/overnight';

const et = (date: string, hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  const v = instantEt(date, h!, m!);
  assert.ok(v !== null, `${date} ${hhmm} ET does not exist`);
  return v;
};
const iso = (date: string, hhmm: string) => new Date(et(date, hhmm)).toISOString();

test('before the open: from the previous close to now', () => {
  const now = et('2026-09-24', '08:00');
  const w = overnightWindowAt(now);
  assert.equal(w.state, 'ESTABLISHED');
  assert.equal(w.authority, 'EXCHANGE_REGULAR_SESSION');
  assert.equal(w.from, iso('2026-09-23', '16:00'));
  assert.equal(w.to, new Date(now).toISOString());
  assert.equal(w.closedBySessionOpen, false);
});

test('during RTH: the overnight is closed at today\'s published open', () => {
  const w = overnightWindowAt(et('2026-09-24', '11:00'));
  assert.equal(w.from, iso('2026-09-23', '16:00'));
  assert.equal(w.to, iso('2026-09-24', '09:30'));
  assert.equal(w.closedBySessionOpen, true);
});

test('after the close: a new overnight starts at today\'s close', () => {
  const now = et('2026-09-24', '17:00');
  const w = overnightWindowAt(now);
  assert.equal(w.from, iso('2026-09-24', '16:00'));
  assert.equal(w.to, new Date(now).toISOString());
  assert.equal(w.closedBySessionOpen, false);
});

test('exactly at the close: the new overnight has begun, not the old one', () => {
  const w = overnightWindowAt(et('2026-09-24', '16:00'));
  assert.equal(w.from, iso('2026-09-24', '16:00'));
});

test('a Monday reaches back over the weekend to Friday\'s close, and says so', () => {
  const w = overnightWindowAt(et('2026-09-28', '08:00'));
  assert.equal(w.from, iso('2026-09-25', '16:00'));
  assert.match(w.basis, /2026-09-27/);
  assert.match(w.basis, /2026-09-26/);
});

test('the day after a holiday reaches past the holiday too', () => {
  // Labor Day 2026-09-07 is a Monday; the previous session is Friday 09-04.
  const w = overnightWindowAt(et('2026-09-08', '08:00'));
  assert.equal(w.from, iso('2026-09-04', '16:00'));
  assert.match(w.basis, /2026-09-07/);
});

test('a half day closes at 13:00, and the overnight starts there', () => {
  const w = overnightWindowAt(et('2026-11-28', '10:00'));
  assert.equal(w.from, iso('2026-11-27', '13:00'));
  assert.equal(w.from, '2026-11-27T18:00:00.000Z');
});

test('a DST change inside the window is placed by the zone, not by an offset', () => {
  // Friday 2026-10-30 closes in EDT; Monday 2026-11-02 is EST.
  const w = overnightWindowAt(et('2026-11-02', '08:00'));
  assert.equal(w.from, '2026-10-30T20:00:00.000Z');
});

test('a walk that reaches past the calendar is UNKNOWN, never stretched', () => {
  // 2026-01-01 is a holiday and 2025-12-31 is outside COVERAGE.
  const w = overnightWindowAt(et('2026-01-02', '08:00'));
  assert.equal(w.state, 'UNKNOWN');
  assert.equal(w.from, null);
  assert.equal(w.to, null);
  assert.match(w.basis, /2025-12-31/);

  const lookup = previousCloseBefore('2026-01-02');
  assert.equal(lookup.ok, false);
});

test('a date outside coverage is UNKNOWN', () => {
  const w = overnightWindowAt(Date.parse('2027-01-05T13:00:00Z'));
  assert.equal(w.state, 'UNKNOWN');
});

test('the module never reads the clock — the instant is always given', () => {
  const src = readFileSync(join(__dirname, '../src/market/overnight.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(src, /Date\.now\s*\(/);
  assert.doesNotMatch(src, /new Date\(\s*\)/);
});

// ─── selectWindow ───────────────────────────────────────────────────────────

const window = overnightWindowAt(et('2026-09-24', '08:00'));
const ev = (date: string, hhmm: string, synthetic?: boolean) =>
  ({ created_at: iso(date, hhmm), synthetic });

test('selection keeps only events inside the window, and counts the non-observed ones', () => {
  const events = [
    ev('2026-09-24', '07:45', true),
    ev('2026-09-24', '07:40', false),
    ev('2026-09-23', '17:00'),
    ev('2026-09-23', '15:59'), // before the close: not overnight
  ];
  const s = selectWindow(window, events, 500, et('2026-09-23', '12:00'));
  assert.equal(s.count, 3);
  assert.equal(s.synthetic, 1);
  assert.equal(s.coverage.complete, true);
  assert.equal(s.coverage.oldestBufferedAt, iso('2026-09-23', '15:59'));
});

test('a process that started inside the window cannot call it complete', () => {
  const s = selectWindow(window, [ev('2026-09-24', '07:45')], 500, et('2026-09-24', '06:00'));
  assert.equal(s.count, 1);
  assert.equal(s.coverage.complete, false);
  assert.match(s.coverage.basis, /started after the window opened/);
});

test('a full buffer cannot call it complete, whatever the start time', () => {
  const events = Array.from({ length: 3 }, () => ev('2026-09-24', '07:45'));
  const s = selectWindow(window, events, 3, et('2026-09-20', '12:00'));
  assert.equal(s.coverage.complete, false);
  assert.match(s.coverage.basis, /cap of 3/);
});

test('an UNKNOWN window selects nothing and is never complete', () => {
  const unknown = overnightWindowAt(et('2026-01-02', '08:00'));
  const s = selectWindow(unknown, [ev('2026-01-02', '07:00')], 500, 0);
  assert.equal(s.count, 0);
  assert.deepEqual(s.data, []);
  assert.equal(s.coverage.complete, false);
});

test('the route is wired to the window and to the real buffer cap', () => {
  const src = readFileSync(join(__dirname, '../src/routes/flow.ts'), 'utf8');
  assert.match(src, /router\.get\('\/overnight'/);
  assert.match(src, /selectWindow\(overnightWindowAt\(now\), getRecentFlow\(\), MAX_FLOW_EVENTS/);
});
