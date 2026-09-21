/**
 * `SupabaseSignalStore.listUngraded`, against the wire shapes and the query
 * PostgREST actually runs.
 *
 * This method had no test of its own. It was inert for its whole life — called
 * by nothing in `src/` — so nothing cared. Startup recovery now depends on it
 * entirely: whatever it returns is the set of checkpoints a restart resumes,
 * and whatever it omits is lost for good.
 *
 * The PR that added recovery named this as its weakest-evidence part and
 * shipped it anyway. That is the exact pattern the ledger's last entry records
 * — "naming a risk is not covering it" — so this is the fixture that should
 * have come first.
 *
 * The in-memory store cannot stand in for it. That store walks every signal in
 * a Map and breaks at `limit`; this one issues a bounded `select` with an
 * `order` and a `limit`, joins a second query by hand, and filters afterwards.
 * They share an interface and no logic.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SupabaseSignalStore } from '../src/persistence/supabaseStore';
import { GRADED_HORIZONS } from '../src/persistence/types';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 8, 19, 12, 0, 0);

interface WireSignal { signal_key: string; decision_at: string; synthetic: boolean }

/**
 * A client that honours the parts of the query this method depends on:
 * `order`, `limit`, `gte` and the `in` join. A stub that ignored `limit` would
 * report success on exactly the bug below.
 */
function stubDb(signals: WireSignal[], outcomes: { signal_key: string }[]): {
  db: SupabaseClient; signalRowsFetched: () => number;
} {
  let fetched = 0;
  const make = (table: string) => {
    let lim = Infinity;
    let asc = true;
    let gte: string | undefined;
    let keys: string[] | undefined;
    const b: any = {
      select: () => b,
      eq: () => b,
      is: () => b,
      gte: (_col: string, v: string) => { gte = v; return b; },
      in: (_col: string, v: string[]) => { keys = v; return b; },
      order: (_col: string, o?: { ascending?: boolean }) => { asc = o?.ascending !== false; return b; },
      limit: (n: number) => { lim = n; return b; },
      then: (resolve: (r: unknown) => unknown, reject?: (e: unknown) => unknown) => {
        let reply: unknown;
        if (table === 'signal_history') {
          let rows = signals.filter((s) => !s.synthetic);
          if (gte !== undefined) rows = rows.filter((s) => s.decision_at >= gte!);
          rows = [...rows].sort((x, y) => (asc ? 1 : -1) *
            x.decision_at.localeCompare(y.decision_at));
          rows = rows.slice(0, lim);
          fetched += rows.length;
          reply = { data: rows, error: null };
        } else {
          const set = new Set(keys ?? []);
          reply = { data: outcomes.filter((o) => set.has(o.signal_key)), error: null };
        }
        return Promise.resolve(reply).then(resolve, reject);
      },
    };
    return b;
  };
  return {
    db: { from: (t: string) => make(t) } as unknown as SupabaseClient,
    signalRowsFetched: () => fetched,
  };
}

/** `graded` oldest signals fully graded, then `open` recent ungraded ones. */
function history(graded: number, open: number) {
  const signals: WireSignal[] = [];
  const outcomes: { signal_key: string }[] = [];
  for (let i = 0; i < graded; i++) {
    const key = `old-${String(i).padStart(6, '0')}`;
    // Spread across the past year, all far older than any live horizon.
    signals.push({
      signal_key: key,
      decision_at: new Date(NOW - 365 * DAY + i * 1000).toISOString(),
      synthetic: false,
    });
    for (const _h of GRADED_HORIZONS) outcomes.push({ signal_key: key });
  }
  for (let i = 0; i < open; i++) {
    signals.push({
      signal_key: `new-${String(i).padStart(6, '0')}`,
      // Minutes ago: checkpoints genuinely still pending.
      decision_at: new Date(NOW - (open - i) * 60_000).toISOString(),
      synthetic: false,
    });
  }
  return { signals, outcomes };
}

test('a long graded history does not hide the signals a restart must resume', async () => {
  // The defect: the scan took the OLDEST `limit * 4` real signals and filtered
  // afterwards. Once that prefix is fully graded — which it becomes, because
  // graded signals never leave the table — the filter removes every row and
  // this returns EMPTY, while recent ungraded signals sit past the window.
  //
  // Recovery would then resume nothing, on a deployment with a working
  // database and pending checkpoints, reporting `examined: 0` as though there
  // were none. That is the silent-loss failure recovery exists to end,
  // reintroduced one layer down.
  const { signals, outcomes } = history(2_000, 100);
  const { db } = stubDb(signals, outcomes);
  const store = new SupabaseSignalStore(db);

  const open = await store.listUngraded(500, NOW - 2 * DAY);
  assert.equal(open.length, 100,
    'every pending signal is offered to recovery, whatever the history behind it');
  assert.ok(open.every((r) => r.signalKey.startsWith('new-')));
});

test('the scan is bounded by the window, not by the size of the table', async () => {
  // The window is what makes the scan safe to run at boot: a deployment with a
  // year of history must not read a year of rows to find the last hour's.
  const { signals, outcomes } = history(50_000, 10);
  const { db, signalRowsFetched } = stubDb(signals, outcomes);
  const store = new SupabaseSignalStore(db);

  const open = await store.listUngraded(500, NOW - 2 * DAY);
  assert.equal(open.length, 10);
  assert.ok(signalRowsFetched() < 1_000,
    `scanned ${signalRowsFetched()} rows; the window should keep this near the ` +
    `number of recent signals, not near the size of the table`);
});

test('with no window every signal is still eligible', async () => {
  // The parameter is optional and the old behaviour is the default, because
  // the store should not invent a retention policy. The caller that has one —
  // the grader, which knows its own horizons — passes it.
  const { signals, outcomes } = history(3, 2);
  const { db } = stubDb(signals, outcomes);
  const store = new SupabaseSignalStore(db);

  const open = await store.listUngraded(500);
  assert.equal(open.length, 2, 'the three graded ones drain, the two open ones remain');
});

test('a signal graded at every horizon is excluded, and one short of it is not', async () => {
  const { db } = stubDb(
    [
      { signal_key: 'full', decision_at: new Date(NOW - 60_000).toISOString(), synthetic: false },
      { signal_key: 'partial', decision_at: new Date(NOW - 60_000).toISOString(), synthetic: false },
    ],
    [
      ...GRADED_HORIZONS.map(() => ({ signal_key: 'full' })),
      ...GRADED_HORIZONS.slice(1).map(() => ({ signal_key: 'partial' })),
    ],
  );
  const open = await new SupabaseSignalStore(db).listUngraded(500);
  assert.deepEqual(open.map((r) => r.signalKey), ['partial'],
    'the count is against the horizons the grader writes, not the union size');
});

test('synthetic signals are never offered for grading', async () => {
  const { db } = stubDb(
    [
      { signal_key: 'real', decision_at: new Date(NOW - 60_000).toISOString(), synthetic: false },
      { signal_key: 'sim', decision_at: new Date(NOW - 60_000).toISOString(), synthetic: true },
    ],
    [],
  );
  const open = await new SupabaseSignalStore(db).listUngraded(500);
  assert.deepEqual(open.map((r) => r.signalKey), ['real']);
});
