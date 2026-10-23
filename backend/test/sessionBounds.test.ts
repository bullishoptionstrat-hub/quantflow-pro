/**
 * `regularSessionInstants` (market/session.ts): the one home for a market
 * date's regular-session bounds as instants. Four research modules each
 * carried their own copy of these steps until 2026-10-22.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { regularSessionInstants } from '../src/market/session';

test('a regular day, a half day, a closure and a date the calendar will not answer for', () => {
  // 2026-03-10 is EDT (UTC−4).
  assert.deepEqual(regularSessionInstants('2026-03-10'),
    { ok: true, open: Date.parse('2026-03-10T13:30:00Z'), close: Date.parse('2026-03-10T20:00:00Z') });
  // 2026-11-27 closes at 13:00, EST (UTC−5).
  assert.deepEqual(regularSessionInstants('2026-11-27'),
    { ok: true, open: Date.parse('2026-11-27T14:30:00Z'), close: Date.parse('2026-11-27T18:00:00Z') });
  for (const [date, unknown] of [['2026-03-14', false], ['2026-11-26', false], ['2027-03-10', true], ['not-a-date', true]] as const) {
    const r = regularSessionInstants(date);
    assert.equal(r.ok, false, date);
    assert.equal(!r.ok && r.unknown, unknown, `${date}: closed and cannot-say are different answers`);
    assert.ok(!r.ok && r.why.length > 0, date);
  }
});

test('no research module reads the calendar\'s hours directly: one home for session bounds', () => {
  const dir = join(__dirname, '../src/research');
  const offenders = readdirSync(dir).filter((f) => f.endsWith('.ts'))
    .filter((f) => /\bsessionOn\s*\(/.test(readFileSync(join(dir, f), 'utf8')));
  assert.deepEqual(offenders, []);
});
