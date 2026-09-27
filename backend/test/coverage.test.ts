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
  CoverageRecorder, CoverageLedger, classifyWindow, summariseCoverage,
  type CoverageSample, type Window,
} from '../src/persistence/coverage';
import { InMemorySignalStore } from '../src/persistence/memoryStore';

const up = (recorded: number): CoverageSample =>
  ({ collecting: true, reason: 'tradier connected', recorded });
const down = (recorded = 0): CoverageSample =>
  ({ collecting: false, reason: 'no recordable source connected (tradier=disabled)', recorded });

/**
 * Windows named by the market clock, so every assertion below says which
 * session it is about rather than leaving it to an epoch offset.
 *
 * 2026 dates, because that is the calendar's `COVERAGE`. September is EDT
 * (UTC-4), so 16:00Z is midday in New York.
 */
const at = (iso: string) => Date.parse(iso);
const win = (startIso: string, endIso: string): Window =>
  ({ startMs: at(startIso), endMs: at(endIso) });

/** Wed 2026-09-16, midday ET. A plain regular session. */
const REGULAR_MIDDAY = win('2026-09-16T16:00:00Z', '2026-09-16T16:01:00Z');
/** Sat 2026-09-26. */
const SATURDAY = win('2026-09-26T16:00:00Z', '2026-09-26T16:01:00Z');
/** Thu 2026-11-26, Thanksgiving. */
const THANKSGIVING = win('2026-11-26T16:00:00Z', '2026-11-26T16:01:00Z');

test('not collecting and collecting-nothing are different facts', () => {
  // The whole reason the union has two members. One is an absence of data;
  // the other is data — the tape really was quiet and a backtest may use it.
  assert.equal(classifyWindow(down(), 0, REGULAR_MIDDAY)!.kind, 'NOT_OBSERVED');
  assert.equal(classifyWindow(up(0), 0, REGULAR_MIDDAY)!.kind, 'OBSERVED_EMPTY');
  assert.equal(classifyWindow(up(5), 0, REGULAR_MIDDAY), null,
    'a productive window is not a gap');
});

test('a window wholly inside an established closure is MARKET_CLOSED', () => {
  // This module refused the verdict outright until the calendar existed. The
  // objection recorded in its docstring was to GUESSING a closure, not to the
  // verdict — so with a published holiday and a weekend it is now emitted, and
  // both collection states get it: a weekend is benign whether or not a
  // connector happened to be up.
  for (const w of [SATURDAY, THANKSGIVING]) {
    assert.equal(classifyWindow(down(), 0, w)!.kind, 'MARKET_CLOSED');
    assert.equal(classifyWindow(up(0), 0, w)!.kind, 'MARKET_CLOSED');
  }
  // And the row says what established it, because a reason read months later
  // by someone deciding whether a window is usable must name its basis.
  assert.match(classifyWindow(down(), 0, THANKSGIVING)!.reason, /exchange holiday/);
  assert.match(classifyWindow(down(), 0, SATURDAY)!.reason, /Saturday/);
});

test('a window that touches one open session is still an outage', () => {
  // THE case this rule exists for. Friday 16:00 to Monday 09:30 spans a
  // weekend *and two open sessions*, and calling it benign would convert a
  // real outage into data nobody expected — the flattering direction.
  const fridayToMonday = win('2026-09-25T20:00:00Z', '2026-09-28T13:30:00Z');
  assert.equal(classifyWindow(down(), 0, fridayToMonday)!.kind, 'NOT_OBSERVED');

  // Saturday into Monday morning: the weekend is not enough.
  const satToMonday = win('2026-09-26T16:00:00Z', '2026-09-28T13:30:00Z');
  assert.equal(classifyWindow(down(), 0, satToMonday)!.kind, 'NOT_OBSERVED');

  // But the whole weekend and nothing else is.
  const wholeWeekend = win('2026-09-26T04:00:00Z', '2026-09-27T23:00:00Z');
  assert.equal(classifyWindow(down(), 0, wholeWeekend)!.kind, 'MARKET_CLOSED');
});

test('a date the calendar cannot answer for is NOT a closure', () => {
  // The load-bearing assertion. `sessionOn` answers UNKNOWN past its COVERAGE
  // bound, and a caller reading "not open" out of "cannot say" is exactly how
  // a MARKET_CLOSED row gets written over a real outage. 2027-11-25 would be
  // Thanksgiving if the table were extrapolated. It is not extrapolated.
  const beyond = win('2027-11-25T16:00:00Z', '2027-11-25T16:01:00Z');
  assert.equal(classifyWindow(down(), 0, beyond)!.kind, 'NOT_OBSERVED');
  assert.equal(classifyWindow(up(0), 0, beyond)!.kind, 'OBSERVED_EMPTY');

  // Same for a Saturday beyond the bound: a weekend is arithmetic, but the
  // calendar refuses to answer at all outside its coverage, and this module
  // takes the refusal rather than reaching past it.
  const satBeyond = win('2027-11-27T16:00:00Z', '2027-11-27T16:01:00Z');
  assert.equal(classifyWindow(down(), 0, satBeyond)!.kind, 'NOT_OBSERVED');

  // And the epoch, which every recorder test below uses.
  assert.equal(classifyWindow(down(), 0, { startMs: 0, endMs: 60_000 })!.kind,
    'NOT_OBSERVED');
});

test('the rule is day-granular, and an overnight weekday stays an outage', () => {
  // 02:00 on a Tuesday is a shut market and this reports NOT_OBSERVED anyway.
  // Deciding otherwise needs session OPEN times, which the calendar does not
  // publish — so the honest answer overstates the gap, which costs a reader's
  // time rather than the record's honesty.
  const tuesdayNight = win('2026-09-22T06:00:00Z', '2026-09-22T06:01:00Z');
  assert.equal(classifyWindow(down(), 0, tuesdayNight)!.kind, 'NOT_OBSERVED');
});

test('a productive window is not relabelled a closure', () => {
  // Signals arriving during a window mean it was not a gap at all, so the
  // calendar must not be able to write a row over it. The backend simulates
  // prints on a keyless deployment, which is one way this really happens.
  assert.equal(classifyWindow(up(5), 0, SATURDAY), null);
  assert.equal(classifyWindow(up(5), 0, THANKSGIVING), null);
});

test('MARKET_CLOSED is only reachable through the calendar', () => {
  // The verdict was banned outright before; banning it now would refuse a fact
  // that can be established. What must not come back is a closure decided in
  // this file — a weekday check, a clock, an `isMarketOpen`-shaped guess. So
  // the guard is that every construction of the verdict sits downstream of
  // `closureThroughout`, which is the only thing here that can say a date was
  // published shut.
  const src = readFileSync(join(__dirname, '..', 'src', 'persistence', 'coverage.ts'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

  const constructions = [...code.matchAll(/kind:\s*'MARKET_CLOSED'/g)];
  assert.ok(constructions.length > 0, 'the verdict is emitted somewhere');
  for (const m of constructions) {
    const before = code.slice(0, m.index);
    assert.match(before.slice(-600), /closure\.closed/,
      'every MARKET_CLOSED must be guarded by closureThroughout()\'s verdict, ' +
      'never by a weekday-and-clock check decided in this file');
  }
  assert.match(code, /from '\.\.\/flow-engine\/calendar'/,
    'and the calendar is the only source of that fact');
  assert.ok(!/getDay\(\)|getUTCDay\(\)/.test(code),
    'coverage.ts must not decide a weekend itself — that is the calendar\'s job, ' +
    'and a second copy is how a green MARKET OPEN dot appeared on Thanksgiving');
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

test('every gap kind has a bucket, and the buckets reconcile', () => {
  // The summary reported two buckets against a three-member union. That was
  // harmless only while MARKET_CLOSED was unreachable — the moment it became
  // emittable, a closure's minutes would count in `gaps` and in neither
  // bucket: a breakdown that does not add up to the total beside it, which is
  // exactly what `scoreBreakdown`'s silent clamp cost this repo once.
  const row = (kind: 'NOT_OBSERVED' | 'OBSERVED_EMPTY' | 'MARKET_CLOSED',
               from: number, to: number) =>
    ({ id: kind + from, kind, startedAt: from, endedAt: to, reason: 'x'.repeat(10) });

  const s = summariseCoverage([
    row('NOT_OBSERVED', 0, 60_000),
    row('OBSERVED_EMPTY', 60_000, 240_000),
    row('MARKET_CLOSED', 240_000, 300_000),
  ]);
  assert.equal(s.marketClosedMs, 60_000, 'a closure is counted, not dropped');
  assert.equal(s.totalMs, 300_000);
  assert.equal(s.unclassifiedMs, 0,
    'the buckets account for every minute in the rows');
  assert.equal(s.notObservedMs + s.observedEmptyMs + s.marketClosedMs, s.totalMs);

  // And `totalMs` is computed from the rows, not from the buckets, so a kind
  // added to the union and forgotten here surfaces as a residual rather than
  // being absorbed into a bucket that happens to be summed last.
  const src = readFileSync(join(__dirname, '..', 'src', 'persistence', 'coverage.ts'), 'utf8');
  assert.match(src, /const totalMs = gaps\.reduce/,
    'totalMs must not be the sum of the buckets, or the residual is always 0');
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

// ─── The ledger, and the fact that something reads it ────────────────────────

const gapRow = (
  id: string,
  kind: 'NOT_OBSERVED' | 'OBSERVED_EMPTY' | 'MARKET_CLOSED',
  from: number, to: number,
) => ({ id, kind, startedAt: from, endedAt: to, reason: 'x'.repeat(10) });

test('an extending gap is one row in the ledger, not one per tick', () => {
  // `recordGap` upserts on id, so the recorder re-records the same open window
  // every tick. A ledger that appended would report a 4-minute outage as ten
  // minutes and climbing — the opposite of the flattering direction, and still
  // a wrong number.
  const l = new CoverageLedger();
  l.note(gapRow('g1', 'NOT_OBSERVED', 0, 60_000));
  l.note(gapRow('g1', 'NOT_OBSERVED', 0, 120_000));
  l.note(gapRow('g1', 'NOT_OBSERVED', 0, 180_000));
  const s = l.summary();
  assert.equal(s.gaps, 1, 'three recordings of one window are one row');
  assert.equal(s.notObservedMs, 180_000, 'carrying the latest extent');
  assert.equal(s.rowsEvicted, 0);
});

test('the ledger keeps the three kinds apart and reconciles', () => {
  const l = new CoverageLedger();
  l.note(gapRow('a', 'NOT_OBSERVED', 0, 60_000));
  l.note(gapRow('b', 'OBSERVED_EMPTY', 60_000, 240_000));
  l.note(gapRow('c', 'MARKET_CLOSED', 240_000, 300_000));
  const s = l.summary();
  assert.deepEqual(
    [s.gaps, s.notObservedMs, s.observedEmptyMs, s.marketClosedMs, s.unclassifiedMs],
    [3, 60_000, 180_000, 60_000, 0],
  );
});

test('an evicted row is counted, and an open window is not the one evicted', () => {
  // `rowsEvicted` non-zero means the totals are over a retained subset rather
  // than the record — the note `memoryStore.trackRecord()` carries. And a
  // re-recorded window moves to the end of the insertion order, so the gap
  // still being extended is the last thing evicted rather than the first: it
  // was inserted earliest and is the row most likely to matter.
  const l = new CoverageLedger(3);
  l.note(gapRow('open', 'NOT_OBSERVED', 0, 60_000));
  for (const i of [1, 2, 3]) {
    l.note(gapRow('open', 'NOT_OBSERVED', 0, 60_000 * (i + 1)));   // still extending
    l.note(gapRow(`x${i}`, 'OBSERVED_EMPTY', 1_000_000 * i, 1_000_000 * i + 60_000));
  }
  const s = l.summary();
  assert.equal(s.gaps, 3, 'bounded');
  assert.ok(s.rowsEvicted > 0, 'and it says how many it dropped');
  assert.ok(s.notObservedMs > 0, 'the window still being extended survived');
});

test('the health payload actually reads the ledger', () => {
  // `summariseCoverage` shipped exported, tested, and called by nothing — the
  // fourth time this module has produced correct code with no caller
  // (`recordGap` had no writer, `listUngraded` no caller, `sourceNotes` no
  // reader). Every test above would pass in exactly that state. This is the
  // one that would not.
  const src = readFileSync(join(__dirname, '..', 'src', 'ingestion', 'index.ts'), 'utf8');
  assert.match(src, /new CoverageLedger\(/, 'a ledger exists in the running process');
  assert.match(src, /summary:\s*gapLedger\.summary\(\)/,
    '/api/health publishes its totals');

  // And it is fed from all three writers: the rows read at boot, the recovered
  // window, and every gap the tick loop writes. Missing any one makes the
  // totals quietly wrong rather than absent.
  const boot = src.indexOf('const gaps = await store.listGaps(0);');
  assert.ok(boot > 0 && /noteGap\(g\)/.test(src.slice(boot, boot + 400)),
    'the rows read at boot are counted');
  const recovered = src.indexOf('recoverMissedWindow(');
  assert.ok(recovered > 0 && /noteGap\(missed\)/.test(src.slice(recovered, recovered + 600)),
    'the recovered window is counted');
  const tick = src.indexOf('coverage?.tick(');
  assert.ok(tick > 0 && /noteGap\(gap\)/.test(src.slice(tick, tick + 600)),
    'every gap the tick loop writes is counted');

  // One store read feeds both consumers. A second query for the same rows is a
  // second chance for the recovery window and the summary to disagree about
  // which rows exist.
  assert.equal((src.match(/store\.listGaps\(/g) ?? []).length, 1,
    'the gap rows are read exactly once at boot');
});
