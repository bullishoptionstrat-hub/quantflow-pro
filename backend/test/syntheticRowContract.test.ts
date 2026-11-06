/**
 * The Supabase row always carries `synthetic`, and only an explicit `false`
 * is real. `signal_history.synthetic` defaulted to false, and JSON drops an
 * undefined key, so a record that lost its flag would have been stored as a
 * real signal. Measured on a disposable PostgreSQL 16: an insert omitting
 * the column stores `f`. The schema half is
 * supabase/migrations/20261028152742_synthetic_no_default.sql, applied to
 * production on 2026-10-28 under that version. It sat in docs/proposals/ with a
 * test asserting it was NOT a migration for a week after it was applied: the
 * repo described a default production no longer had, and gate-proofs.sql's
 * inserts, which relied on that default, would have proved nothing there.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { toRow } from '../src/persistence/supabaseStore';
import type { SignalRecord } from '../src/persistence/types';

const base = {
  signalKey: 'k', contentHash: 'k', engineId: 'e', kind: 'BLOCK', underlying: 'SPY', side: 'BUY',
  totalPremium: 1, totalSize: 1, iso: false, score: 1, scoreBreakdown: {}, legs: [],
  firstEventAt: 1, lastEventAt: 1, decisionAt: 1, decisionBasis: 'OBSERVED', latencyMs: 0,
  source: 'simulation', datasetId: 'SIMULATION', rightsClass: 'PERMITTED', recordedAt: 1,
} as unknown as SignalRecord;

test('a record missing the flag is written as synthetic, never omitted', () => {
  for (const v of [undefined, null, 'false', 0, true]) {
    const row = JSON.parse(JSON.stringify(toRow({ ...base, synthetic: v as any })));
    assert.equal(row.synthetic, true, `synthetic=${String(v)}`);
  }
});

test('only an explicit false is real', () => {
  assert.equal(toRow({ ...base, synthetic: false }).synthetic, false);
});

const SUPABASE = join(__dirname, '../../supabase');

test('the default is dropped by a migration carrying production\'s version, and nowhere else', () => {
  const p = join(SUPABASE, 'migrations/20261028152742_synthetic_no_default.sql');
  assert.match(readFileSync(p, 'utf8'), /^alter table public\.signal_history alter column synthetic drop default;$/m);
  // One home. A proposal copy beside an applied migration is the drift this replaced.
  assert.equal(existsSync(join(__dirname, '../../docs/proposals/20261028_synthetic_no_default.sql')), false);
});

test('every gate-proof insert into signal_history names synthetic, except the one proving it must', () => {
  // With no default, an insert omitting the column is refused by NOT NULL. A
  // gate that expects a CHECK refusal would then "pass" for the wrong reason,
  // and the one that must be ACCEPTED (G1c) would fail and take every outcome
  // gate after it down on the foreign key.
  const sql = readFileSync(join(SUPABASE, 'gate-proofs.sql'), 'utf8');
  const inserts = [...sql.matchAll(/insert into public\.signal_history \(([^)]*)\)\s*values\s*\(\s*'([^']+)'/g)];
  assert.ok(inserts.length >= 6, `found ${inserts.length} inserts`);
  const omitting = inserts.filter((m) => !/\bsynthetic\b/.test(m[1]!)).map((m) => m[2]);
  assert.deepEqual(omitting, ['g1-nosyn'], 'only the deliberate no-default probe may omit it');
});

test('the in-memory store applies the same rule, so both stores count alike', async () => {
  const { InMemorySignalStore } = await import('../src/persistence/memoryStore');
  const store = new InMemorySignalStore();
  const T = Date.UTC(2026, 0, 2);
  for (const [i, v] of [undefined, null, false].entries()) {
    await store.writeSignal({ ...base, signalKey: `k${i}`, contentHash: `k${i}`, firstEventAt: T, lastEventAt: T, decisionAt: T, synthetic: v as any });
  }
  assert.deepEqual(await store.countSignals(), { total: 3, synthetic: 2, real: 1 });
});
