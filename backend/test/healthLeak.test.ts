/**
 * `/api/health` is served unauthenticated, so every string it returns is
 * public. The existing code already learned this once with `sourceErrors`,
 * which is why `describeHttpError` exists. The signal-history block must obey
 * the same rule: counters are fine, raw error messages are not — a Supabase
 * client failure can carry the project URL and other connection detail.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getSignalHistoryStatus } from '../src/ingestion/index';
import { initPersistence, getRecorder, __resetPersistenceForTests } from '../src/persistence';

test('the health projection carries counters but never a raw error message', async (t) => {
  __resetPersistenceForTests();
  t.after(() => __resetPersistenceForTests());

  initPersistence({} as NodeJS.ProcessEnv);
  const recorder = getRecorder()!;

  // Force a recorder error: an inverted timeline throws inside record().
  const t0 = Date.parse('2026-08-29T14:30:00.000Z');
  const res = await recorder.record(
    {
      id: 'sig_1_x', kind: 'SWEEP', ts: t0 + 900, lastTs: t0,
      receivedAt: t0, emittedAt: t0, underlying: 'SPY', side: 'BUY',
      legs: [{
        contract: {
          symbol: 'SPY260919C00550000', underlying: 'SPY',
          right: 'C', strike: 550, expiry: '2026-09-19',
        },
        side: 'BUY', totalSize: 1, totalPremium: 1, vwap: 1,
        prints: 1, exchanges: ['CBOE'],
      }],
      totalPremium: 1, totalSize: 1, iso: false, score: 1,
      scoreBreakdown: {}, printIds: ['p1'], synthetic: false,
    },
    { source: 'tradier', sources: ['tradier'], synthetic: false },
  );
  assert.equal(res.status, 'ERROR');
  assert.ok(recorder.getStats().lastError, 'the recorder retained the detail internally');

  const health = getSignalHistoryStatus();

  // The counters survive — they are the operationally useful part.
  assert.equal(health.recorder!.errors, 1);
  assert.equal(health.recorder!.seen, 1);

  // The detail does not.
  assert.equal('lastError' in health.recorder!, false, 'recorder.lastError must not be public');
  assert.equal(health.errorsSuppressed, true, 'but the operator is told something failed');

  // Belt and braces: nothing anywhere in the serialised block leaks it.
  assert.equal(JSON.stringify(health).includes('inverted timeline'), false);
});

test('the health projection still reports store durability and the mode in force', () => {
  __resetPersistenceForTests();
  initPersistence({} as NodeJS.ProcessEnv);
  const h = getSignalHistoryStatus();

  assert.equal(h.store, 'memory');
  assert.equal(h.durable, false);
  assert.match(h.reason, /LOST on every restart/);
  assert.equal(h.businessMode, 'PRIVATE_RESEARCH');
  assert.ok(h.rights.datasets.length > 0);
  __resetPersistenceForTests();
});
