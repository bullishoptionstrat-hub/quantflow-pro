/**
 * The Supabase row always carries `synthetic`, and only an explicit `false`
 * is real. `signal_history.synthetic` defaults to false, and JSON drops an
 * undefined key, so a record that lost its flag would otherwise be stored as
 * a real signal. Measured on a disposable PostgreSQL 16: an insert omitting
 * the column stores `f`. The schema half is
 * docs/proposals/20261028_synthetic_no_default.sql (not applied).
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

test('the schema proposal drops the default and is not an applied migration', () => {
  const p = join(__dirname, '../../docs/proposals/20261028_synthetic_no_default.sql');
  assert.match(readFileSync(p, 'utf8'), /alter column synthetic drop default/);
  assert.equal(existsSync(join(__dirname, '../../supabase/migrations/20261028_synthetic_no_default.sql')), false);
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
