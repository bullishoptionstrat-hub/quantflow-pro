/**
 * The table that exists to stop a flattering hit rate, and had never had a row.
 *
 * `collection_gaps` shipped with three CHECK constraints, a `GapKind` union
 * carrying a paragraph on why its members are different facts, and
 * `recordGap`/`listGaps` in both stores. `grep -rn recordGap src/` found the
 * two implementations and **no caller**. So the machinery built to mark the
 * windows where nothing was observed had marked none, and a track record
 * computed over such a window would read an outage as a quiet tape — which is
 * exactly the bias `types.ts` says the table exists to expose:
 *
 *   "Outages cluster in volatile sessions ... Silently dropping them removes
 *    the hard cases and makes any hit rate computed over the window
 *    flattering."
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CoverageRecorder, classifyWindow, summariseCoverage, type CoverageSample,
} from '../src/persistence/coverage';
import { InMemorySignalStore } from '../src/persistence/memoryStore';

const up = (recorded: number): CoverageSample =>
  ({ collecting: true, reason: 'tradier connected', recorded });
const down = (recorded = 0): CoverageSample =>
  ({ collecting: false, reason: 'no recordable source connected (tradier=disabled)', recorded });

test('not collecting and collecting-nothing are different facts', () => {
  // The whole reason the union has two members. One is an absence of data;
  // the other is data — the tape really was quiet and a backtest may use it.
  assert.equal(classifyWindow(down(), 0)!.kind, 'NOT_OBSERVED');
  assert.equal(classifyWindow(up(0), 0)!.kind, 'OBSERVED_EMPTY');
  assert.equal(classifyWindow(up(5), 0), null, 'a productive window is not a gap');
});

test('MARKET_CLOSED is never emitted, and the reason is the failure direction', () => {
  // The union offers it and this module refuses it. Deciding a window was
  // benignly shut needs a holiday calendar this codebase does not have, and
  // CLAUDE.md already records what happens without one — a green MARKET OPEN
  // dot on Thanksgiving. Mislabelling a real outage as a closure turns missing
  // data into data nobody expected, which is the flattering direction.
  const samples = [down(), up(0), up(3), down(7)];
  for (const s of samples) {
    assert.notEqual(classifyWindow(s, 0)?.kind, 'MARKET_CLOSED');
  }
  const src = readFileSync(join(__dirname, '..', 'src', 'persistence', 'coverage.ts'), 'utf8');
  assert.ok(!/kind:\s*'MARKET_CLOSED'/.test(src),
    'coverage.ts must not construct a MARKET_CLOSED verdict');
});

test('the first tick establishes a baseline and writes nothing', () => {
  // There is no window before the first tick. Inventing one dates the gap to
  // whatever the previous value of `lastTickAt` was — the epoch.
  const c = new CoverageRecorder('run1');
  assert.equal(c.tick(down(), 1_000), null);
  assert.equal(c.getOpenGap(), null);
});

test('a continuing outage is one row, extended, not one row per tick', () => {
  // A 60s tick writing a row per tick is 1,440 rows a day and a table nobody
  // reads. `recordGap` upserts on id, so the same id replaces.
  const c = new CoverageRecorder('run1');
  c.tick(down(), 1_000);
  const a = c.tick(down(), 2_000)!;
  const b = c.tick(down(), 3_000)!;
  const d = c.tick(down(), 4_000)!;
  assert.equal(a.id, b.id);
  assert.equal(b.id, d.id);
  assert.equal(d.startedAt, 1_000, 'the window still starts where it started');
  assert.equal(d.endedAt, 4_000, 'and its end advances');
});

test('a change of kind closes one gap and opens another', () => {
  const c = new CoverageRecorder('run1');
  c.tick(down(), 1_000);
  const notObserved = c.tick(down(), 2_000)!;
  const empty = c.tick(up(0), 3_000)!;
  assert.equal(notObserved.kind, 'NOT_OBSERVED');
  assert.equal(empty.kind, 'OBSERVED_EMPTY');
  assert.notEqual(notObserved.id, empty.id);
  assert.equal(empty.startedAt, 2_000, 'the new window starts where the old ended');
});

test('a productive window closes the open gap', () => {
  const c = new CoverageRecorder('run1');
  c.tick(down(), 0);
  c.tick(down(), 1_000);
  assert.ok(c.getOpenGap());
  assert.equal(c.tick(up(4), 2_000), null);
  assert.equal(c.getOpenGap(), null);
  // And a later outage is a new row, not a resumption of the old one.
  const next = c.tick(down(4), 3_000)!;
  assert.equal(next.startedAt, 2_000);
});

test('every reason survives the store guard', async () => {
  // `recordGap` refuses a reason under 10 characters, because it is read
  // months later by someone deciding whether a window is usable. A recorder
  // that emits rows the store rejects would fail silently — the write is
  // fire-and-forget.
  const store = new InMemorySignalStore();
  const c = new CoverageRecorder('run1');
  c.tick(down(), 0);
  for (const [sample, at] of [[down(), 1_000], [up(0), 2_000]] as const) {
    const gap = c.tick(sample, at);
    if (gap) await store.recordGap(gap);   // throws if the reason is too thin
  }
  assert.equal((await store.listGaps(0)).length, 2);
});

test('an extended gap is one row in memory, as it is in Postgres', async () => {
  // `supabaseStore.recordGap` upserts on id; `memoryStore` pushed. The two
  // stores disagreed about the same call, so an open gap re-recorded each tick
  // was one row in Postgres and one per tick in memory — and the tests, which
  // drive the in-memory store, would not have seen the difference.
  const store = new InMemorySignalStore();
  const c = new CoverageRecorder('run1');
  c.tick(down(), 0);
  for (const at of [1_000, 2_000, 3_000, 4_000]) {
    const gap = c.tick(down(), at);
    if (gap) await store.recordGap(gap);
  }
  const gaps = await store.listGaps(0);
  assert.equal(gaps.length, 1, 'one contiguous outage is one row');
  assert.equal(gaps[0]!.endedAt, 4_000, 'carrying the latest extent');
});

test('the summary keeps the two kinds apart', () => {
  // Same reason the union does. Pooling them would let an hour of downtime and
  // an hour of quiet tape report as the same two hours of "gap".
  const s = summariseCoverage([
    { id: 'a', kind: 'NOT_OBSERVED', startedAt: 0, endedAt: 60_000, reason: 'x'.repeat(10) },
    { id: 'b', kind: 'OBSERVED_EMPTY', startedAt: 60_000, endedAt: 240_000, reason: 'x'.repeat(10) },
  ]);
  assert.equal(s.gaps, 2);
  assert.equal(s.notObservedMs, 60_000);
  assert.equal(s.observedEmptyMs, 180_000);
});

test('coverage counts the same sources the doctor calls recordable', () => {
  // A source that can be recorded but is not counted here makes a productive
  // window look like an outage; one counted here but not recordable does the
  // reverse. Both write a false row into a table read months later.
  const index = readFileSync(join(__dirname, '..', 'src', 'ingestion', 'index.ts'), 'utf8');
  const doctor = readFileSync(
    join(__dirname, '..', 'tools', 'collection', 'doctor.ts'), 'utf8');
  // Anchored on the declaration, not the first mention: in `index.ts` the
  // constant is *used* inside `sampleCoverage()` above the line that declares
  // it, and slicing from there returned an empty list that deep-equal happily
  // compared against another empty list. A guard that reads nothing passes.
  const listOf = (src: string, name: string) => {
    const at = src.indexOf(`const ${name} = [`);
    assert.ok(at > 0, `${name} declaration not found`);
    const body = src.slice(at, src.indexOf(']', at));
    const found = [...body.matchAll(/'([a-z]+)'/g)].map((m) => m[1]).sort();
    assert.ok(found.length > 0, `${name} parsed as empty — the anchor is wrong`);
    return found;
  };
  assert.deepEqual(
    listOf(index, 'RECORDABLE_FOR_COVERAGE'),
    listOf(doctor, 'RECORDABLE_SOURCES'),
  );
});
