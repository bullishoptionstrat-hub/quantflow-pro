/**
 * H-001-v2 end to end (`research/h001Analysis.ts`): two sessions of tape,
 * quotes and candidate signals in, the study's report out.
 *
 * Each module was already tested alone. What these cases hold is the wiring —
 * the places a composer can be wrong while every part it calls is right: a
 * meta-event that mixes groups, an absorbed signal's own print drawn as a
 * control, marks taken from the wrong instant, an order-dependent answer, a
 * report that is silent about what it did not compute.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildTradeEvent } from '../src/events/build';
import type { RawTradeRecord } from '../src/events/build';
import type { MarketEvent, TradeReportEvent } from '../src/events/types';
import { EventLog } from '../src/events/eventLog';
import { reviseSignal } from '../src/events/signalRevision';
import type { DatasetRightsManifest, RightsFact } from '../src/provenance/researchManifest';
import type { UnderlyingQuote } from '../src/research/h001Marks';
import { h001Return } from '../src/research/h001Marks';
import { runH001Analysis, analyseH001, H001_ABSENT, H001_SENSITIVITY_PREMIUM_FLOOR } from '../src/research/h001Analysis';
import { h001Cr2Interval } from '../src/research/h001Cr2';
import { h001VolBalance } from '../src/research/h001Balance';
import type { H001Signal } from '../src/research/h001Analysis';

// Two EDT weekdays: 14:00Z is 10:00 ET.
const DAYS = ['2026-03-10', '2026-03-11'] as const;
const ET = (day: string, h: number, m: number, s = 0) =>
  Date.parse(`${day}T${String(h + 4).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.000Z`);

/** One quote a second, 09:30–16:00 ET, a midpoint near 550 that wanders differently each day. */
const QUOTES: UnderlyingQuote[] = [];
DAYS.forEach((day, k) => {
  const open = ET(day, 9, 30);
  for (let t = open; t <= ET(day, 16, 0); t += 1_000) {
    const mid = Math.round((550 + 0.5 * Math.sin((t - open) / (90_000 + k * 17_000)) + 0.2 * Math.sin((t - open) / 11_000)) * 100) / 100;
    // A 20-second outage around 13:00: a signal decided at 13:00 has no entry mark (§C's 2 s bound).
    if (t > ET(day, 12, 59, 50) && t < ET(day, 13, 0, 10)) continue;
    QUOTES.push({ provider: 'p', eventTime: t, availableAt: t + 5, bid: mid - 0.01, ask: mid + 0.01 });
  }
});

const fact = (quote: string): RightsFact => ({
  status: 'PERMITTED', quote, document: 'https://example.test/hypothetical-terms', readAt: '2026-09-20',
  evidence: 'PROVIDER_VERIFIED', note: 'a test manifest — no real vendor is described',
});
const MANIFEST: DatasetRightsManifest = {
  schema: 'quantflow-dataset-rights-v1', provider: 'hypothetical', dataset: 'HYPOTHETICAL.OPRA',
  subscriptionTier: 'test', intendedDeploymentMode: 'PRIVATE_RESEARCH',
  rights: {
    fetch: fact('(test) fetch'), persistRaw: fact('(test) raw'), persistNormalized: fact('(test) normalised'),
    researchUse: fact('(test) research'), modelTraining: fact('(test) training'), export: fact('(test) export'),
    redistribution: { ...fact('(test)'), status: 'PROHIBITED' }, retention: fact('(test) retention'),
  },
  sourceDocuments: ['https://example.test/hypothetical-terms'], verifiedAt: '2026-09-20',
};
const CTX = { mode: 'PRIVATE_RESEARCH' as const, today: '2026-09-27' };

let seq = 1;
function trade(day: string, eventTime: number, over: Partial<RawTradeRecord> = {}): TradeReportEvent {
  return buildTradeEvent({
    provider: 'hypothetical', datasetId: 'HYPOTHETICAL.OPRA', sequenceScope: `line-1:${day}`,
    providerSequence: String(seq++), eventTime, providerReceiveTime: eventTime + 3,
    instrument: { underlying: 'SPY', expiry: '2026-03-20', strike: 552, right: 'C' },
    venue: 'C', rawSessionIdentifier: 0, rawRecordRef: `raw/${day}#${seq}`,
    synthetic: false, replay: true, price: 3, size: 400, ...over,
  }) as TradeReportEvent;
}

interface Built { signal: H001Signal; evidence: TradeReportEvent[] }

/** A signal formed from one print a second before its decision; the default is an A candidate (SPY call, BUY, $120k). */
function signal(id: string, day: string, h: number, m: number, over: Partial<H001Signal> = {}, rec: Partial<RawTradeRecord> = {}): Built {
  const decisionAt = ET(day, h, m);
  const evidence = [trade(day, decisionAt - 1_000, rec)];
  return { evidence, signal: {
    signalId: id, underlying: 'SPY', legs: [{ right: 'C', side: 'BUY' }], side: 'BUY',
    totalPremium: 120_000, decisionAt, synthetic: false, evidence, manifest: MANIFEST,
    finalRevision: null as never, ...over,
  } };
}

/** Every signal's evidence, plus the C controls, on one FINAL_CORRECTED tape; revisions read from that tape. */
function assemble(built: Built[], controls: TradeReportEvent[]) {
  const log = new EventLog();
  const all: MarketEvent[] = [...built.flatMap((b) => b.evidence), ...controls];
  for (const e of all) log.append(e);
  const tape = log.finalCorrected();
  const signals = built.map((b) => ({
    ...b.signal,
    finalRevision: reviseSignal(
      { signalId: b.signal.signalId, evidenceEventIds: b.evidence.map((e) => e.eventId), decidedAt: b.signal.decisionAt,
        underlying: 'SPY', firstEventAt: b.evidence[0]!.eventTime, lastEventAt: b.evidence[b.evidence.length - 1]!.eventTime },
      tape, { finalityHorizonMs: 60_000, clusterGapMs: 500 }),
  }));
  return { tape, signals };
}

function fixture(extra: (day: string) => Built[] = () => []) {
  const built: Built[] = [];
  const controls: TradeReportEvent[] = [];
  for (const day of DAYS) {
    built.push(
      signal(`${day}-a1`, day, 10, 5),
      // 7 minutes later: absorbed into a1's meta-event (§B), and its print has a1's match key.
      signal(`${day}-a2`, day, 10, 12),
      // A B signal inside a1's window: its own group's meta-event, never a1's (X1).
      signal(`${day}-b1`, day, 10, 8, { side: 'SELL', legs: [{ right: 'C', side: 'SELL' }] }),
      // An 11:00-hour A meta-event with no control in its hour: unmatched, counted.
      signal(`${day}-a3`, day, 11, 30),
      // Out on one rule each.
      signal(`${day}-lean`, day, 10, 40, { side: 'BUY_LEAN', legs: [{ right: 'C', side: 'BUY_LEAN' }] }),
      signal(`${day}-put`, day, 10, 45, { legs: [{ right: 'P', side: 'BUY' }] }, { instrument: { underlying: 'SPY', expiry: '2026-03-20', strike: 552, right: 'P' } }),
      signal(`${day}-late`, day, 15, 50),
      // X3: marks are the signal's own — this one decides inside the quote outage.
      signal(`${day}-gap`, day, 13, 0),
      ...extra(day),
    );
    // Six genuine controls in the 10:00 hour with a1's key.
    for (let i = 0; i < 6; i++) controls.push(trade(day, ET(day, 10, 20 + i * 5)));
  }
  return { built, controls, ...assemble(built, controls) };
}

const run = (over: Partial<Parameters<typeof runH001Analysis>[0]> = {}) => {
  const f = fixture();
  return { f, report: runH001Analysis({ signals: f.signals, tape: f.tape, quotes: QUOTES, ctx: CTX, truthSetAvailable: false, replicates: 400, ...over }) };
};

test('§L: every candidate is accounted for, and each exclusion names its rule', () => {
  const { report } = run();
  const e = report.eligibility;
  assert.equal(e.considered, 16);
  assert.deepEqual(e.included, { A: 6, B: 2 });
  assert.equal(e.excluded, 8);
  assert.equal(e.unknown, 0);
  assert.deepEqual(e.byRule, {
    side: { fail: 2, unknown: 0 },
    'single-leg-call': { fail: 2, unknown: 0 },
    'decision-window': { fail: 2, unknown: 0 },
    marks: { fail: 2, unknown: 0 },
  });
});

test('§B per group: an absorbed A signal joins its meta-event; a B signal inside the window does not (X1, X2)', () => {
  const { report } = run();
  const ids = report.metaEvents.map((m) => `${m.group}:${m.signalIds.join('+')}`).sort();
  assert.deepEqual(ids, [
    'A:2026-03-10-a1+2026-03-10-a2', 'A:2026-03-10-a3',
    'A:2026-03-11-a1+2026-03-11-a2', 'A:2026-03-11-a3',
    'B:2026-03-10-b1', 'B:2026-03-11-b1',
  ]);
  for (const m of report.metaEvents) {
    const r = h001Return(m.startsAt, QUOTES);
    assert.equal(r.status, 'OK');
    assert.equal(m.returnBp, r.status === 'OK' ? r.returnBp : NaN, 'measured from the first signal (§B)');
  }
});

test('X5: the evidence of every absorbed signal is out of the control pool, not only the first one\'s', () => {
  const { f, report } = run();
  // Six genuine controls a day, plus the BUY_LEAN signal's print: it is in no
  // meta-event, and §G draws C from "any side classification". a2's print has
  // the same key too, and would make it eight a day.
  assert.equal(report.controls.poolSize, 14);
  const members = new Set(report.metaEvents.flatMap((m) => m.signalIds));
  const evidence = new Set(f.built.filter((b) => members.has(b.signal.signalId)).flatMap((b) => b.evidence.map((e) => e.eventId)));
  assert.equal(evidence.size, 8);
  for (const m of report.controls.matches) for (const c of m.controls) assert.ok(!evidence.has(c.eventId), c.eventId);
});

test('§G: the 10:00 meta-events match five controls; the 11:00 ones are unmatched and counted', () => {
  const { report } = run();
  const byId = new Map(report.controls.matches.map((m) => [m.metaEventId, m]));
  for (const day of DAYS) {
    assert.equal(byId.get(`A:${day}-a1`)!.status, 'MATCHED');
    assert.equal(byId.get(`A:${day}-a1`)!.controls.length, 5);
    assert.equal(byId.get(`A:${day}-a3`)!.status, 'NO_MATCH');
  }
  assert.equal(report.controls.unmatchedA, 2);
  assert.equal(report.primary.n.metaEvents, 2);
  assert.equal(report.primary.n.unmatched, 2);
  // Half the A meta-events unmatched is above §G's 20%: the study is DESCRIPTIVE, and says why.
  assert.equal(report.primary.verdict, 'DESCRIPTIVE');
  assert.ok(report.primary.reasons.some((r) => r.includes('no exact control match')), report.primary.reasons.join(' | '));
});

test('Δ_AB is built from the meta-event returns, and Δ_AD from one clock draw per A meta-event', () => {
  const { report } = run();
  const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
  const rA = report.metaEvents.filter((m) => m.group === 'A').map((m) => m.returnBp);
  const rB = report.metaEvents.filter((m) => m.group === 'B').map((m) => m.returnBp);
  assert.ok(Math.abs(report.primary.deltaAB.estimateBp! - (mean(rA) - mean(rB))) < 1e-9);
  assert.equal(report.clock.differences.length, 4, 'a one-second tape measures every clock time');
  assert.equal(report.clock.deltaAD.n.observations, 4);
  assert.equal(report.clock.deltaAD.n.days, 2);
  assert.ok(report.clock.deltaAD.ci95 !== null);
});

test('the CR2 cross-check is computed on the primary differences, and the verdict ignores it', () => {
  const { report } = run();
  assert.deepEqual(report.cr2, h001Cr2Interval(report.controls.matches
    .filter((m) => m.status === 'MATCHED').map((m) => ({ date: m.date, valueBp: m.differenceBp! }))));
  assert.equal(report.cr2.n.observations, report.primary.n.metaEvents);
  assert.ok(Math.abs(report.cr2.estimateBp! - report.primary.estimateBp!) < 1e-9, 'same estimand as the primary');
  assert.equal(report.cr2.decides, false);
  assert.ok(!report.absent.some((a) => a.item.includes('CR2')), 'computed, so no longer listed absent');
});

test('§I $100k floor: the pipeline re-run on the candidates that clear it, meta-events re-formed (S1, S2)', () => {
  assert.equal(H001_SENSITIVITY_PREMIUM_FLOOR, 100_000);
  // A $70k A signal at 10:02 opens the 10:00 window in the primary, absorbing
  // a1; under the floor it is gone and a1 opens the window itself.
  const f = fixture((day) => [signal(`${day}-small`, day, 10, 2, { totalPremium: 70_000 }, { price: 1.75 })]);
  const args = { tape: f.tape, quotes: QUOTES, ctx: CTX, truthSetAvailable: false, replicates: 400 };
  const report = runH001Analysis({ ...args, signals: f.signals });
  const sens = report.sensitivities.premiumFloor;
  assert.equal(sens.floor, 100_000);
  assert.equal(sens.belowFloor, 2);
  assert.deepEqual(report.eligibility.included, { A: 8, B: 2 }, 'the primary keeps them: §L\'s floor is $50k');
  assert.deepEqual(sens.included, { A: 6, B: 2 });
  const starts = report.metaEvents.filter((m) => m.group === 'A').map((m) => m.metaEventId);
  assert.ok(starts.includes('A:2026-03-10-small'), starts.join(' '));
  assert.ok(!starts.includes('A:2026-03-10-a1'), 'a1 is absorbed in the primary');

  // S2: each half is exactly the core pipeline on its own inputs.
  const kept = f.signals.filter((s) => s.totalPremium >= 100_000);
  const direct = analyseH001({ ...args, signals: kept });
  assert.deepEqual(sens.primary, direct.primary);
  assert.deepEqual(sens.cr2, direct.cr2);
  assert.deepEqual(sens.metaEvents, { A: 4, B: 2 });
  assert.equal(sens.unmatchedA, direct.controls.unmatchedA);
  assert.equal(sens.decides, false);
  const { sensitivities, ...rest } = report;
  void sensitivities;
  assert.deepEqual(rest, analyseH001({ ...args, signals: f.signals }), 'the primary is computed without reference to any sensitivity');
  assert.ok(!report.absent.some((a) => a.item.includes('$100k')), 'computed, so no longer listed absent');
});

test('§I $100k floor on a sample that already clears it: the sensitivity equals the primary', () => {
  // a3 at exactly $100,000: "≥ $100k" keeps the boundary, as §L's "≥ $50,000" does.
  const f = fixture();
  const signals = f.signals.map((s) => (s.signalId.endsWith('-a3') ? { ...s, totalPremium: 100_000 } : s));
  const report = runH001Analysis({ signals, tape: f.tape, quotes: QUOTES, ctx: CTX, truthSetAvailable: false, replicates: 400 });
  const sens = report.sensitivities.premiumFloor;
  assert.equal(sens.belowFloor, 0);
  assert.deepEqual(sens.primary, report.primary);
  assert.deepEqual(sens.cr2, report.cr2);
});

test('§G balance is computed on the matched set the verdict reads, from each unit\'s own anchor', () => {
  const { report } = run();
  assert.deepEqual(report.balance, h001VolBalance(report.controls.matches, QUOTES));
  // a1 on each day is matched with five controls; a3 is unmatched and out (V4).
  assert.equal(report.balance.n.pairs, 2);
  assert.equal(report.balance.n.controls, 10);
  assert.ok(report.balance.smd !== null, 'the fixture reaches a real SMD, not the null branch');
  const a1 = report.controls.matches.find((m) => m.metaEventId === 'A:2026-03-10-a1')!;
  assert.equal(a1.anchor, report.metaEvents.find((m) => m.metaEventId === a1.metaEventId)!.startsAt);
  assert.ok(a1.controls.every((c) => c.anchor !== a1.anchor), 'controls are measured from their own instants');
  assert.equal(report.balance.decides, false);
  assert.ok(!report.absent.some((a) => a.section === '§G'), 'computed, so no longer listed absent');
});

test('the answer is a function of the data, not of the order the signals were listed in', () => {
  const f = fixture();
  const args = { tape: f.tape, quotes: QUOTES, ctx: CTX, truthSetAvailable: false, replicates: 400 };
  const forward = runH001Analysis({ ...args, signals: f.signals });
  const reversed = runH001Analysis({ ...args, signals: [...f.signals].reverse() });
  const strip = (r: typeof forward) => JSON.stringify({ ...r, eligibility: { ...r.eligibility, rows: undefined } });
  assert.equal(strip(reversed), strip(forward));
  // Rows keep the caller's order, so the caller can join them back; the set is the same.
  const ids = (r: typeof forward) => r.eligibility.rows.map((x) => JSON.stringify(x)).sort();
  assert.deepEqual(ids(reversed), ids(forward));
});

test('the report lists what it did not compute, and the absent items decide nothing', () => {
  const { report } = run();
  assert.equal(report.absent, H001_ABSENT);
  const sections = report.absent.map((a) => a.section).join(' ');
  for (const s of ['§I', '§J', '§K']) assert.ok(sections.includes(s), s);
  assert.ok(report.absent.every((a) => !a.decides), 'an absent item that decides would make the verdict incomplete, not merely the report');
});

test('pipeline defects throw, and a rule §L owns stays §L\'s', () => {
  const f = fixture();
  const args = { tape: f.tape, quotes: QUOTES, ctx: CTX, truthSetAvailable: false, replicates: 50 };
  assert.throws(() => runH001Analysis({ ...args, signals: [...f.signals, f.signals[0]!] }), /listed twice/);
  // X4: evidence naming two contracts never reaches contractOf — §L owns that
  // rule and excludes it, so the composer's throw is a backstop, not a second rule.
  const first = f.signals[0]!;
  const other = trade(DAYS[0], first.decisionAt - 500, { instrument: { underlying: 'SPY', expiry: '2026-03-20', strike: 555, right: 'C' } });
  const r = runH001Analysis({ ...args, signals: [{ ...first, evidence: [...first.evidence, other] }] });
  assert.equal(r.eligibility.rows[0]!.verdict, 'EXCLUDED');
  assert.deepEqual(r.eligibility.rows[0]!.findings.map((x) => x.rule), ['single-leg-call']);
});

/**
 * One A signal a day and five controls known at the very instant it decided:
 * every matched difference is exactly zero, so the interval is [0, 0] and the
 * uncapped verdict is PRACTICALLY NEGLIGIBLE — a claim-bearing verdict, the
 * only kind §K's truth-set cap changes. Without it, a composer that dropped
 * the caller's truthSetAvailable for a constant would pass every case above,
 * because DESCRIPTIVE is never capped.
 */
function zeroFixture() {
  const built: Built[] = [];
  const controls: TradeReportEvent[] = [];
  for (const day of DAYS) {
    const b = signal(`${day}-z`, day, 10, 5);
    built.push(b);
    // providerReceiveTime is eventTime + 3, so availableAt is the A signal's decisionAt.
    for (let i = 0; i < 5; i++) controls.push(trade(day, b.signal.decisionAt - 3));
  }
  return assemble(built, controls);
}

test('§K: the caller\'s truth-set answer reaches the verdict, in both directions', () => {
  const f = zeroFixture();
  const at = (truthSetAvailable: boolean) =>
    runH001Analysis({ signals: f.signals, tape: f.tape, quotes: QUOTES, ctx: CTX, truthSetAvailable, replicates: 200 });
  const without = at(false);
  // The premise first: two matched meta-events, every difference exactly zero.
  assert.equal(without.primary.n.metaEvents, 2);
  for (const m of without.controls.matches) {
    assert.equal(m.status, 'MATCHED');
    assert.equal(m.controls.length, 5);
    assert.equal(m.differenceBp, 0);
  }
  assert.deepEqual(without.primary.ci95, { lo: 0, hi: 0 });
  assert.equal(without.primary.uncappedVerdict, 'PRACTICALLY NEGLIGIBLE');
  assert.equal(without.primary.verdict, 'INCONCLUSIVE');
  const withTruth = at(true);
  assert.equal(withTruth.primary.verdict, 'PRACTICALLY NEGLIGIBLE');
  assert.equal(withTruth.primary.uncappedVerdict, 'PRACTICALLY NEGLIGIBLE');
});

test('the composer indexes the quotes once and takes every mark from that index', () => {
  // The speed is the index's; a stray `input.quotes` below the book would put
  // a full scan back into that call path while every answer stayed the same.
  const src = readFileSync(join(__dirname, '../src/research/h001Analysis.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const body = src.slice(src.indexOf('export function analyseH001('));
  const fn = body.slice(0, body.indexOf('\n}\n'));
  assert.deepEqual(fn.match(/input\.quotes/g), ['input.quotes']);
  assert.match(fn, /const quotes = quoteBook\(input\.quotes\)/);
});
