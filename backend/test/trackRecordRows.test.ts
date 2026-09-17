/**
 * What an "M15 hit rate" was actually measured over.
 *
 * Every platform in this category publishes a hit rate under a horizon label.
 * None publishes the interval the rate was measured across — and on a mark
 * source that refreshes more slowly than the horizon is long, those differ.
 * The Twelve Data free tier paces this deployment's REST rotation to ~19
 * minutes, so a row filed under `M15` is routinely measured over half an hour
 * or more. The rate is not wrong; the label is narrower than the thing it
 * names, and pooling intervals of different lengths under one label is the
 * category's characteristic lie arrived at honestly.
 *
 * So the interval is published beside the rate. These tests hold that
 * disclosure in place, and hold the two stores to one copy of it: the row and
 * note logic had already drifted, and the note that went missing was in the
 * store that actually answers the endpoint.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  emptyTally, tallyOutcome, tallyToRows, reportNotes, median,
} from '../src/persistence/trackRecordRows';
import { MIN_PUBLISHABLE_SAMPLE, nominalHorizonMs } from '../src/persistence/types';

const M15 = nominalHorizonMs('M15')!;

/** A graded bucket whose rows were each measured over `intervalMs`. */
function bucket(horizon: string, n: number, intervalMs: number, opts: {
  hits?: number; undated?: number; spread?: number;
} = {}) {
  const t = emptyTally('SWEEP', horizon);
  const hits = opts.hits ?? n;
  for (let i = 0; i < n; i++) {
    const dated = i >= (opts.undated ?? 0);
    const span = intervalMs + (opts.spread ? (i % 2 === 0 ? -opts.spread : opts.spread) : 0);
    tallyOutcome(t, {
      label: i < hits ? 'POSITIVE' : 'NEGATIVE',
      excursion: i < hits ? 0.01 : -0.01,
      entryMarkAt: dated ? 1_000_000 : undefined,
      exitMarkAt: dated ? 1_000_000 + span : undefined,
    });
  }
  return t;
}

test('the interval a bucket was measured over is published beside its rate', () => {
  const [row] = tallyToRows([bucket('M15', MIN_PUBLISHABLE_SAMPLE, 32 * 60_000, { spread: 60_000 })]);
  assert.equal(row!.horizon, 'M15');
  assert.equal(typeof row!.hitRate, 'number', 'the sample is large enough to publish');

  const mi = row!.measuredInterval!;
  assert.ok(mi, 'a graded row must be able to say what it measured');
  assert.equal(mi.n, MIN_PUBLISHABLE_SAMPLE);
  assert.equal(mi.nominalMs, M15, 'the horizon length travels with it, so no arithmetic is needed');
  assert.equal(mi.medianMs, 32 * 60_000);
  assert.equal(mi.minMs, 31 * 60_000);
  assert.equal(mi.maxMs, 33 * 60_000);
  assert.ok(mi.medianMs! > mi.nominalMs!, 'this is the case the disclosure exists for');
});

test('a row measured longer than its label says so, in the notes', () => {
  const rows = tallyToRows([bucket('M15', MIN_PUBLISHABLE_SAMPLE, 32 * 60_000)]);
  const notes = reportNotes(rows, { synthetic: 0, eventTimeOnlyBasis: 0, rightsRefused: 0 });
  const note = notes.find((n) => /longer interval than the horizon/.test(n));
  assert.ok(note, 'the mismatch must be stated, not left for the reader to compute');
  assert.match(note, /SWEEP\/M15/);
  assert.match(note, /median 32min/);
  assert.match(note, /against 15min nominal/);
  assert.match(note, /not a rate for the interval its label names/);
});

test('a row measured inside its horizon says nothing, because there is nothing to say', () => {
  // The disclosure must not fire on the honest case, or it becomes noise and
  // stops being read — which is how a warning that matters gets ignored.
  const rows = tallyToRows([bucket('M15', MIN_PUBLISHABLE_SAMPLE, M15)]);
  const notes = reportNotes(rows, { synthetic: 0, eventTimeOnlyBasis: 0, rightsRefused: 0 });
  assert.ok(!notes.some((n) => /longer interval than the horizon/.test(n)));
});

test('graded rows with no stamps stay in the rate and are named separately', () => {
  // Dropping them from the rate would silently change which sample the rate
  // describes — the opposite of the disclosure this module is for. Counting
  // them into the interval figures would invent an interval they never had.
  const rows = tallyToRows([bucket('M15', MIN_PUBLISHABLE_SAMPLE, 20 * 60_000, { undated: 4 })]);
  const mi = rows[0]!.measuredInterval!;
  assert.equal(mi.nUndated, 4);
  assert.equal(mi.n, MIN_PUBLISHABLE_SAMPLE - 4, 'only dated rows reach the interval');
  assert.equal(rows[0]!.nGraded, MIN_PUBLISHABLE_SAMPLE, 'all of them still reach the rate');

  const notes = reportNotes(rows, { synthetic: 0, eventTimeOnlyBasis: 0, rightsRefused: 0 });
  const note = notes.find((n) => /carry no mark stamps/.test(n));
  assert.ok(note);
  assert.match(note, /^4 graded outcome/);
  assert.match(note, /counted in the rates and excluded from the interval figures/);
});

test('a suppressed rate still says what its sample measured', () => {
  // The n=30 floor is about not publishing a *rate* on thin evidence. The
  // evidence's shape is not the thing being withheld, and a reader deciding
  // whether to keep waiting is better off knowing the intervals already look
  // twice the horizon.
  const [row] = tallyToRows([bucket('M15', 4, 30 * 60_000)]);
  assert.equal(row!.suppressionReason, 'INSUFFICIENT_SAMPLE');
  assert.equal(row!.hitRate, undefined, 'still no rate');
  assert.equal(row!.measuredInterval!.medianMs, 30 * 60_000);
});

test('an interval with nothing in it is absent, not zero', () => {
  const t = emptyTally('SWEEP', 'M15');
  tallyOutcome(t, { label: 'POSITIVE', excursion: 0.01 }); // graded, no stamps
  const [row] = tallyToRows([t]);
  const mi = row!.measuredInterval!;
  assert.equal(mi.n, 0);
  assert.equal(mi.nUndated, 1);
  assert.equal(mi.medianMs, undefined, 'a zero here would read as "measured over no time"');
  assert.equal(mi.minMs, undefined);
  assert.equal(mi.maxMs, undefined);
});

test('an ungraded bucket has no interval at all', () => {
  const t = emptyTally('SWEEP', 'M15');
  tallyOutcome(t, { label: 'UNGRADED' });
  const [row] = tallyToRows([t]);
  assert.equal(row!.nUngraded, 1);
  assert.equal(row!.measuredInterval, undefined, 'nothing was measured, so there is no interval');
});

test('EXPIRY has no nominal length, and none is invented for it', () => {
  const [row] = tallyToRows([bucket('EXPIRY', 5, 3 * 24 * 60 * 60_000)]);
  const mi = row!.measuredInterval!;
  assert.equal(mi.nominalMs, undefined, 'EXPIRY is not a fixed offset from the decision');
  assert.ok(mi.medianMs! > 0, 'the measured interval is still real and still reported');

  const notes = reportNotes([row!], { synthetic: 0, eventTimeOnlyBasis: 0, rightsRefused: 0 });
  assert.ok(!notes.some((n) => /longer interval than the horizon/.test(n)),
    'with no nominal there is no mismatch to claim');
});

test('median is the median, including across an even sample', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  assert.equal(median([7]), 7);
});

// ─── One copy, because the two had already drifted ──────────────────────────

test('a store-specific note survives the shared note list', () => {
  // Collapsing the two copies dropped one: the memory store's eviction warning,
  // which exists because its 50,000-signal cap means a rate can describe a
  // retained window rather than the whole record. The Supabase store has no cap
  // and the claim would be false there, so it cannot join the shared list — it
  // comes through the store channel and lands last.
  const rows = tallyToRows([bucket('M15', MIN_PUBLISHABLE_SAMPLE, M15)]);
  const mine = '1234 oldest signal(s) have been evicted from this in-memory store';
  const notes = reportNotes(
    rows, { synthetic: 2, eventTimeOnlyBasis: 0, rightsRefused: 0 }, [mine]);
  assert.ok(notes.includes(mine), 'a store-specific note must reach the reader');
  assert.equal(notes[notes.length - 1], mine, 'and it lands after the shared prose');
  assert.ok(notes.some((n) => /synthetic signal\(s\) were excluded/.test(n)),
    'without displacing any of it');
});

test('the memory store still warns when it has evicted signals', () => {
  const src = readFileSync(
    join(__dirname, '..', 'src', 'persistence', 'memoryStore.ts'), 'utf8');
  assert.match(src, /this\.evicted > 0/,
    'the eviction warning was dropped by the refactor that shared these notes');
  assert.match(src, /reportNotes\(rows, excluded, storeNotes\)/,
    'and it must reach the reader through the store channel');
});

test('neither store builds its own rows or its own prose', () => {
  // `memoryStore` and `supabaseStore` each had a full copy of the bucket→row
  // mapping and the note list. They differed: the Supabase copy warned that
  // the M15/H1/D1 rows for one kind are three readings of the SAME signals,
  // and the memory copy did not — and `storeKind` is `memory` here, so the
  // store that has never run was the honest one.
  //
  // Ledger line 74 wrote a test to hold two copies of grading logic in
  // agreement rather than permit a third. One copy is the better version of
  // that move: there is nothing left to hold in agreement.
  for (const f of ['memoryStore.ts', 'supabaseStore.ts']) {
    const src = readFileSync(join(__dirname, '..', 'src', 'persistence', f), 'utf8');
    assert.match(src, /tallyToRows\(/, `${f} must build rows through the shared module`);
    assert.match(src, /reportNotes\(/, `${f} must take its notes from the shared module`);
    assert.ok(!/suppressionReason\s*=/.test(src),
      `${f} must not re-implement the sample-size gate`);
    // Matched on the note's own imperative rather than on a phrase a comment
    // might reasonably use, so the guard tracks the prose and not the prose
    // *about* the prose.
    assert.ok(!/Do not multiply them/.test(src),
      `${f} must not carry its own copy of a note — that is the drift this closes`);
    assert.ok(!/function median\(/.test(src),
      `${f} must not keep its own median`);
  }
});

test('an unknown horizon has no nominal length, and is not a number anyway', () => {
  // The reason the table keeps its narrow type: a row's horizon arrives as a
  // string from a bucket key or a database column, and a lookup that answered
  // `number` for anything would put a `undefined` where a duration is expected.
  assert.equal(nominalHorizonMs('EXPIRY'), undefined);
  assert.equal(nominalHorizonMs('nonsense'), undefined);
  assert.equal(nominalHorizonMs('M15'), 15 * 60_000);

  // `in` walks the prototype chain, so the first version of this lookup
  // answered `Object.prototype.toString` — a **function** — through a
  // signature promising `number | undefined`. Measured, not reasoned about:
  // 'toString', 'constructor' and 'hasOwnProperty' all came back as functions,
  // and a function reaching `nominalMs` publishes `NaN` in a note. It is the
  // precise defect the comment on that function claims to avoid, introduced by
  // the commit that wrote the comment.
  for (const inherited of ['toString', 'constructor', 'hasOwnProperty', 'valueOf', '__proto__']) {
    const v = nominalHorizonMs(inherited);
    assert.equal(v, undefined, `${inherited} must not resolve through the prototype`);
    assert.notEqual(typeof v, 'function', `${inherited} must never return a function`);
  }
});

test('a bucket larger than the argument limit still reports min and max', () => {
  // `Math.min(...xs)` passes every element as an argument. The in-memory store
  // caps at 50,000 signals but the Supabase table it exists to be replaced by
  // does not, so a long-accumulated bucket would have thrown a RangeError and
  // turned the whole endpoint into a 500 — at exactly the point where the
  // track record finally had enough sample to be worth reading.
  const t = emptyTally('SWEEP', 'D1');
  const n = 200_000;
  for (let i = 0; i < n; i++) {
    tallyOutcome(t, {
      label: 'POSITIVE', excursion: 0.01,
      entryMarkAt: 0, exitMarkAt: 1_000 + (i % 7),
    });
  }
  const [row] = tallyToRows([t]);
  const mi = row!.measuredInterval!;
  assert.equal(mi.n, n);
  assert.equal(mi.minMs, 1_000);
  assert.equal(mi.maxMs, 1_006);
});

test('one table of horizon lengths, not two', () => {
  // `HORIZON_OFFSETS_MS` in the grader and a second table here would be free to
  // disagree about how long an hour is, and the disagreement would show up as
  // a disclosure note that fires or does not fire for the wrong reason.
  const grader = readFileSync(
    join(__dirname, '..', 'src', 'persistence', 'grader.ts'), 'utf8');
  assert.match(grader, /HORIZON_OFFSETS_MS\s*=\s*HORIZON_NOMINAL_MS;/,
    'the grader must re-export the shared table rather than declare its own');
  // And re-export it *without* a cast. Widening the table to keyof-string so
  // that row code could index it would have made a typo typecheck as a number
  // and return undefined; the widening belongs in `nominalHorizonMs`, whose
  // return type admits it.
  assert.ok(!/HORIZON_NOMINAL_MS as Record/.test(grader),
    'a cast here would assert a key-safety the widened table no longer gives');
  assert.ok(!/M15:\s*15\s*\*\s*60_000/.test(grader),
    'the literal offsets must live in exactly one place');
});
