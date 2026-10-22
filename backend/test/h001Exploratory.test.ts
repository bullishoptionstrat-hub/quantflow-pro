/**
 * H-001-v2 §K's exploratory endpoints (`research/h001Exploratory.ts`).
 *
 * The rules here are readings, so each test is built where a different reading
 * would give a different, plausible number: an exit read off the wrong
 * session, a weekend measured as a day, an unmeasurable control quietly
 * replaced, a horizon length that disagrees with the track record's.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HORIZON_NOMINAL_MS } from '../src/persistence/types';
import { h001Return, h001ReturnOver, quoteBook, H001_HORIZON_MS } from '../src/research/h001Marks';
import type { UnderlyingQuote } from '../src/research/h001Marks';
import { h001Exploratory, regularSessionAt, H001_EXPLORATORY_HORIZON_MS } from '../src/research/h001Exploratory';
import type { AMatch, Control, MatchKey } from '../src/research/h001Controls';
import { h001SecondaryInterval } from '../src/research/h001Verdict';

// EDT throughout (DST began 2026-03-08): ET hour h is UTC h + 4.
const at = (day: string, h: number, m: number, s = 0, ms = 0) =>
  Date.parse(`${day}T${String(h + 4).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}Z`);
const TUE = '2026-03-10';
const WED = '2026-03-11';
const THU = '2026-03-12';
const FRI = '2026-03-13';

/** One quote a second, 09:30–16:00 ET, on the days given; a midpoint that wanders so returns differ. */
function tape(days: readonly string[], skip: (t: number) => boolean = () => false): UnderlyingQuote[] {
  const out: UnderlyingQuote[] = [];
  days.forEach((day, k) => {
    const open = at(day, 9, 30);
    for (let t = open; t <= at(day, 16, 0); t += 1_000) {
      if (skip(t)) continue;
      const mid = Math.round((550 + 2 * k + 0.6 * Math.sin((t - open) / 83_000) + 0.2 * Math.sin((t - open) / 9_000)) * 100) / 100;
      out.push({ provider: 'p', eventTime: t, availableAt: t + 5, bid: mid - 0.01, ask: mid + 0.01 });
    }
  });
  return out;
}

const KEY: MatchKey = { date: TUE, hourEt: 10, dte: '8-30', moneyness: '0.995-1.005', premium: '100k-250k' };
const control = (id: string, anchor: number): Control => ({ eventId: id, key: KEY, anchor, returnBp: 0 });
const match = (id: string, date: string, anchor: number, controls: Control[], status: AMatch['status'] = 'MATCHED'): AMatch =>
  ({ metaEventId: id, date, anchor, status, key: KEY, why: null, returnBp: 0, controls, controlMeanBp: 0, differenceBp: 0 });

/**
 *   m1  Tue 10:05, three controls; the third's H1 exit lands on a one-sided book.
 *   m2  Tue 15:30: its H1 exit is after the close; its D1 exit is Wednesday's.
 *   m3  Wed 10:05: its D1 exit is Thursday — a session, with no Thursday quotes.
 *   m4  Fri 10:05: its D1 exit is Saturday.
 *   m5  Tue 14:58, one control whose H1 exit is half a second past the close.
 *   m6  Tue 14:58:30, only that control.
 *   m7  unmatched: never part of Δ_AC.
 */
function fixture(thursdayQuotes = false) {
  const m1c3Exit = at(TUE, 10, 30) + 1_000 + 3_600_000;
  const quotes = tape(thursdayQuotes ? [TUE, WED, THU, FRI] : [TUE, WED, FRI]);
  // A one-sided book at m1's third control's H1 exit, beside the regular quote
  // stamped the same instant: which of the two the market showed is unknown,
  // so §C's exit rule refuses the mark rather than keep the clean one.
  quotes.push({ provider: 'p', eventTime: m1c3Exit, availableAt: m1c3Exit + 4, bid: null, ask: 551 });
  const late = control('c-late', at(TUE, 14, 59, 59, 500));
  const matches = [
    match('m1', TUE, at(TUE, 10, 5), [control('c11', at(TUE, 10, 20)), control('c12', at(TUE, 10, 25)), control('c13', at(TUE, 10, 30))]),
    match('m2', TUE, at(TUE, 15, 30), [control('c21', at(TUE, 15, 10)), control('c22', at(TUE, 15, 20))]),
    match('m3', WED, at(WED, 10, 5), [control('c31', at(WED, 10, 20))]),
    match('m4', FRI, at(FRI, 10, 5), [control('c41', at(FRI, 10, 20))]),
    match('m5', TUE, at(TUE, 14, 58), [late, control('c52', at(TUE, 14, 30))]),
    match('m6', TUE, at(TUE, 14, 58, 30), [late]),
    match('m7', TUE, at(TUE, 10, 50), [], 'NO_MATCH'),
  ];
  return { quotes, matches };
}

const byId = <T extends { metaEventId: string }>(rows: readonly T[]) => new Map(rows.map((r) => [r.metaEventId, r]));

test('K1: H1 and D1 are the track record\'s horizons, and the study\'s M15 is the track record\'s M15', () => {
  assert.equal(H001_EXPLORATORY_HORIZON_MS.H1, HORIZON_NOMINAL_MS.H1);
  assert.equal(H001_EXPLORATORY_HORIZON_MS.D1, HORIZON_NOMINAL_MS.D1);
  assert.equal(H001_EXPLORATORY_HORIZON_MS.H1, 3_600_000);
  assert.equal(H001_EXPLORATORY_HORIZON_MS.D1, 86_400_000);
  // Two homes for "15 minutes", held to agreement rather than left to drift.
  assert.equal(H001_HORIZON_MS, HORIZON_NOMINAL_MS.M15);
});

test('h001ReturnOver is §C at any horizon, and h001Return is it at M15', () => {
  const { quotes } = fixture();
  for (const a of [at(TUE, 10, 5), at(TUE, 13, 0, 0, 250), at(WED, 11, 11, 11), at(FRI, 15, 44, 59)]) {
    assert.deepEqual(h001Return(a, quotes), h001ReturnOver(a, quotes, H001_HORIZON_MS));
    const r = h001ReturnOver(a, quotes, 3_600_000);
    assert.equal(r.status === 'OK' || r.status === 'NO_EXIT_MARK' ? r.entry.at : NaN, a + 1_000, 'the entry is §C\'s');
    if (r.status === 'OK') assert.equal(r.exit.at, a + 1_000 + 3_600_000);
  }
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => h001ReturnOver(at(TUE, 10, 5), quotes, bad), RangeError, String(bad));
  }
});

test('K2: an exit is measured only inside its date\'s published regular session', () => {
  assert.equal(regularSessionAt(at(TUE, 10, 0)).ok, true);
  assert.equal(regularSessionAt(at(TUE, 9, 30)).ok, true, 'the open is inside');
  assert.equal(regularSessionAt(at(TUE, 16, 0)).ok, true, 'the close is inside');
  const no = (t: number, why: RegExp) => {
    const r = regularSessionAt(t);
    assert.equal(r.ok, false, String(why));
    assert.match(r.ok ? '' : r.why, why);
  };
  no(at(TUE, 16, 0, 0, 1), /after the regular close/);
  no(at(TUE, 9, 29, 59), /before the regular open/);
  no(at('2026-03-14', 10, 0), /Saturday/);
  no(Date.parse('2026-11-26T15:00:00Z'), /holiday|Thanksgiving/i);
  // A published 13:00 close (EST: ET hour h is UTC h + 5).
  assert.equal(regularSessionAt(Date.parse('2026-11-27T18:00:00Z')).ok, true);
  no(Date.parse('2026-11-27T18:00:01Z'), /after the regular close/);
  no(Date.parse('2027-03-10T15:00:00Z'), /coverage/);
});

test('H1: measured on the primary\'s units; a unit past the close or on a broken book is counted, never replaced', () => {
  const { quotes, matches } = fixture();
  const e = h001Exploratory(matches, quotes, 'H1', { replicates: 500 });
  assert.equal(e.horizon, 'H1');
  assert.equal(e.horizonMs, 3_600_000);
  assert.equal(e.considered, 6, 'an unmatched A meta-event is not part of Δ_AC');
  const rows = byId(e.rows);
  assert.equal(rows.has('m7'), false);
  assert.deepEqual([...rows.values()].map((r) => `${r.metaEventId}:${r.status}`), [
    'm1:MEASURED', 'm2:A_UNMEASURED', 'm3:MEASURED', 'm4:MEASURED', 'm5:MEASURED', 'm6:NO_CONTROL_MEASURED',
  ]);
  assert.equal(rows.get('m2')!.refusal, 'OUTSIDE_SESSION');
  assert.deepEqual([rows.get('m1')!.controlsMeasured, rows.get('m1')!.controlsRefused], [2, 1]);
  assert.deepEqual([rows.get('m5')!.controlsMeasured, rows.get('m5')!.controlsRefused], [1, 1]);
  assert.deepEqual(e.refused, {
    aMetaEvents: { OUTSIDE_SESSION: 1, NO_MARK: 0, EXIT_FROM_EARLIER_SESSION: 0 },
    controls: { OUTSIDE_SESSION: 2, NO_MARK: 1, EXIT_FROM_EARLIER_SESSION: 0 },
  });
  // Each difference is r_A − the mean over the controls that measured — m5's
  // mean is its one surviving control, not a mean padded by the refused one.
  const ret = (t: number) => { const r = h001ReturnOver(t, quotes, 3_600_000); assert.equal(r.status, 'OK'); return r.status === 'OK' ? r.returnBp : NaN; };
  const m5 = rows.get('m5')!;
  assert.ok(Math.abs(m5.differenceBp! - (ret(at(TUE, 14, 58)) - ret(at(TUE, 14, 30)))) < 1e-12);
  const m1 = rows.get('m1')!;
  assert.ok(Math.abs(m1.controlMeanBp! - (ret(at(TUE, 10, 20)) + ret(at(TUE, 10, 25))) / 2) < 1e-12);
  assert.deepEqual(e.differences, e.rows.filter((r) => r.status === 'MEASURED').map((r) => ({ date: r.date, valueBp: r.differenceBp })));
  const interval = h001SecondaryInterval(e.differences, { replicates: 500 });
  assert.equal(e.estimateBp, interval.estimateBp);
  assert.deepEqual(e.ci95, interval.ci95);
  assert.deepEqual(e.n, { observations: 4, days: 3 });
});

test('D1: a weekend exit is not a day, and a quote from an earlier session never stands in for the exit', () => {
  const { quotes, matches } = fixture();
  const e = h001Exploratory(matches, quotes, 'D1', { replicates: 500 });
  const rows = byId(e.rows);
  assert.deepEqual([...rows.values()].map((r) => `${r.metaEventId}:${r.status}:${r.refusal}`), [
    'm1:MEASURED:null', 'm2:MEASURED:null', 'm3:A_UNMEASURED:EXIT_FROM_EARLIER_SESSION',
    'm4:A_UNMEASURED:OUTSIDE_SESSION', 'm5:MEASURED:null', 'm6:MEASURED:null',
  ]);
  // m2's H1 exit was after the close; its D1 exit is Wednesday 15:30, inside.
  assert.equal(rows.get('m2')!.controlsMeasured, 2);
  // The late control's D1 exit is Wednesday 15:00:00.5 — inside, unlike its H1 exit.
  assert.equal(rows.get('m6')!.controlsMeasured, 1);
  assert.deepEqual(e.refused.aMetaEvents, { OUTSIDE_SESSION: 1, NO_MARK: 0, EXIT_FROM_EARLIER_SESSION: 1 });
  // The premise of m3: Thursday is a session, the exit mark exists, and it is Wednesday's close.
  const r3 = h001ReturnOver(at(WED, 10, 5), quotes, 86_400_000);
  assert.equal(r3.status, 'OK', 'an unbounded exit rule would have measured it');
  assert.ok(r3.status === 'OK' && r3.exit.quote.eventTime <= at(WED, 16, 0));
  // With Thursday's quotes present the same unit is measured: the refusal was K3's, nothing else.
  const withThursday = h001Exploratory(fixture(true).matches, fixture(true).quotes, 'D1', { replicates: 200 });
  assert.equal(byId(withThursday.rows).get('m3')!.status, 'MEASURED');
});

test('the oldest exit quote used is reported, as §C reports exitAgeMs at M15', () => {
  // A 60-second gap before m2's second control's D1 exit (Wednesday 15:20:01).
  const { matches } = fixture();
  const quotes = tape([TUE, WED, FRI], (t) => t > at(WED, 15, 19) && t <= at(WED, 15, 20, 1));
  const e = h001Exploratory(matches, quotes, 'D1', { replicates: 100 });
  // Recomputed independently: a unit's exit age counts when its exit is in a
  // session and its exit quote is from that session; a control counts only
  // when its A meta-event was measured.
  const ageOf = (t: number): number | null => {
    const r = h001ReturnOver(t, quotes, 86_400_000);
    const s = regularSessionAt(t + 1_000 + 86_400_000);
    return r.status === 'OK' && s.ok && r.exit.quote.eventTime >= s.open ? r.exitAgeMs : null;
  };
  const ages: number[] = [];
  for (const m of matches.filter((x) => x.status === 'MATCHED')) {
    const a = ageOf(m.anchor);
    if (a === null) continue;
    ages.push(a);
    for (const c of m.controls) { const x = ageOf(c.anchor); if (x !== null) ages.push(x); }
  }
  assert.equal(e.maxExitAgeMs, Math.max(...ages));
  assert.ok(e.maxExitAgeMs! >= 60_000, 'the fixture reaches the gap');
});

test('exploratory endpoints decide nothing and say so; D1 states the dependence it does not correct', () => {
  const { quotes, matches } = fixture();
  for (const h of ['H1', 'D1'] as const) {
    const e = h001Exploratory(matches, quotes, h, { replicates: 100 });
    assert.equal(e.decides, false);
    assert.ok(e.notes.some((n) => /exploratory/.test(n) && /supports no claim/.test(n)), h);
    assert.equal(e.notes.some((n) => /narrower than its dependence warrants/.test(n)), h === 'D1', h);
    assert.equal(Object.keys(e).some((k) => /verdict/i.test(k)), false, 'no field that reads as a decision');
  }
  // The verdict module never reads them.
  const verdict = readFileSync(join(__dirname, '../src/research/h001Verdict.ts'), 'utf8');
  assert.ok(!/h001Exploratory/.test(verdict));
  // M15 is the primary's, not an exploratory horizon.
  assert.throws(() => h001Exploratory(matches, quotes, 'M15' as never), RangeError);
});

test('the endpoint is the same whether it reads the quotes or a book of them', () => {
  const { quotes, matches } = fixture();
  assert.deepEqual(h001Exploratory(matches, quoteBook(quotes), 'D1', { replicates: 100 }), h001Exploratory(matches, quotes, 'D1', { replicates: 100 }));
});
