/**
 * H-001-v2 §L as code (`research/h001Eligibility.ts`).
 *
 * The rules were frozen before any data existed, so these tests are built the
 * same way: from the hypothesis text, one rule at a time, each broken on a
 * candidate that otherwise passes, and each asserted to fail ITS rule and no
 * other. A test that only checked "the bad one is excluded" would pass just as
 * happily if the wrong rule had excluded it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTradeEvent } from '../src/events/build';
import type { RawTradeRecord } from '../src/events/build';
import type { TradeReportEvent } from '../src/events/types';
import { EventLog } from '../src/events/eventLog';
import { reviseSignal } from '../src/events/signalRevision';
import type { SignalRevision } from '../src/events/signalRevision';
import { h001Eligibility, H001_PREMIUM_FLOOR } from '../src/research/h001Eligibility';
import type { H001Candidate, H001Rule } from '../src/research/h001Eligibility';
import type { DatasetRightsManifest, RightsFact } from '../src/provenance/researchManifest';

const TODAY = '2026-09-27';
const CTX = { mode: 'PRIVATE_RESEARCH' as const, today: TODAY };
// 2026-03-10 is a Tuesday in EDT: 14:00Z is 10:00 ET, inside regular hours.
const T0 = Date.parse('2026-03-10T14:00:00.000Z');

function rec(over: Partial<RawTradeRecord> = {}): RawTradeRecord {
  return {
    provider: 'hypothetical', datasetId: 'HYPOTHETICAL.OPRA', sequenceScope: 'line-1:2026-03-10',
    providerSequence: '100', eventTime: T0, providerReceiveTime: T0 + 3,
    instrument: { underlying: 'SPY', expiry: '2026-03-20', strike: 570, right: 'C' },
    venue: 'C', rawSessionIdentifier: 0, rawRecordRef: 'raw/2026-03-10/line-1#100',
    synthetic: false, replay: true, price: 2.5, size: 400, ...over,
  };
}
const trade = (over: Partial<RawTradeRecord> = {}) => buildTradeEvent(rec(over)) as TradeReportEvent;

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

/** A real FINAL revision, derived the way the study will derive one. */
function finalRevisionOf(evidence: readonly TradeReportEvent[], decidedAt: number): SignalRevision {
  const log = new EventLog();
  for (const e of evidence) log.append(e);
  return reviseSignal(
    { signalId: 's1', evidenceEventIds: evidence.map((e) => e.eventId), decidedAt, underlying: 'SPY',
      firstEventAt: evidence[0]!.eventTime, lastEventAt: evidence[evidence.length - 1]!.eventTime },
    log.finalCorrected(),
    { finalityHorizonMs: 60_000, clusterGapMs: 500 },
  );
}

function candidate(over: Partial<H001Candidate> = {}, evidenceOver: Partial<RawTradeRecord> = {}): H001Candidate {
  const evidence = over.evidence ?? [trade(evidenceOver)];
  const decisionAt = over.decisionAt ?? T0 + 1_000;
  return {
    signalId: 's1', underlying: 'SPY', legs: [{ right: 'C', side: 'BUY' }], side: 'BUY',
    totalPremium: 100_000, decisionAt, synthetic: false, evidence,
    finalRevision: finalRevisionOf(evidence, decisionAt), manifest: MANIFEST,
    marks: { entry: true, exit: true }, ...over,
  };
}

const failing = (c: H001Candidate) =>
  [...new Set(h001Eligibility(c, CTX).findings.map((f) => `${f.outcome}:${f.rule}`))].sort();

test('a candidate meeting every §L rule is included, in the group its side names', () => {
  const a = h001Eligibility(candidate(), CTX);
  assert.deepEqual(a.findings, []);
  assert.equal(a.verdict, 'INCLUDED');
  assert.equal(a.group, 'A');
  const b = h001Eligibility(candidate({ side: 'SELL', legs: [{ right: 'C', side: 'SELL' }] }), CTX);
  assert.equal(b.verdict, 'INCLUDED');
  assert.equal(b.group, 'B');
});

test('each rule, broken alone, fails exactly itself', () => {
  const cases: Array<[H001Rule, H001Candidate]> = [
    ['underlying', candidate({ underlying: 'QQQ' })],
    ['single-leg-call', candidate({ legs: [{ right: 'C', side: 'BUY' }, { right: 'P', side: 'BUY' }] })],
    ['single-leg-call', candidate({ legs: [{ right: 'P', side: 'BUY' }] })],
    // BUY_LEAN is never pooled (§I), however close to BUY it looks.
    ['side', candidate({ side: 'BUY_LEAN', legs: [{ right: 'C', side: 'BUY_LEAN' }] })],
    ['side', candidate({ side: 'AMBIGUOUS', legs: [{ right: 'C', side: 'AMBIGUOUS' }] })],
    ['premium', candidate({ totalPremium: H001_PREMIUM_FLOOR - 1 })],
    ['detector-admission', candidate({}, { rawMessageType: 'SPRD' })],
    ['session', candidate({}, { rawSessionIdentifier: 1 })],
    // Expired the business day before: its last trading moment has passed.
    ['contract-lifecycle', candidate({}, { instrument: { underlying: 'SPY', expiry: '2026-03-09', strike: 570, right: 'C' } })],
    ['availability-basis', candidate({}, { providerReceiveTime: undefined })],
    ['synthetic', candidate({ synthetic: true })],
    // The signal can claim to be real while a print it was built from is not.
    ['synthetic', candidate({}, { synthetic: true })],
    ['rights', candidate({ manifest: null })],
    ['marks', candidate({ marks: { entry: true, exit: false } })],
  ];
  for (const [rule, c] of cases) {
    assert.deepEqual(failing(c), [`FAIL:${rule}`], `breaking ${rule}`);
    assert.equal(h001Eligibility(c, CTX).verdict, 'EXCLUDED');
    assert.equal(h001Eligibility(c, CTX).group, null, 'an excluded candidate is in no group');
  }
  assert.equal(H001_PREMIUM_FLOOR, 50_000, '§L froze the floor at $50,000');
  assert.deepEqual(failing(candidate({ totalPremium: H001_PREMIUM_FLOOR })), [], 'the floor is inclusive');
});

test('the final-tape rule reads the revision, and a cancelled signal is out', () => {
  const t = trade();
  const log = new EventLog();
  log.append(t);
  log.append(buildTradeEvent(rec({ providerSequence: '101', rawMessageType: 'CNCL', eventTime: T0 + 500, providerReceiveTime: T0 + 503 })));
  const invalidated = reviseSignal(
    { signalId: 's1', evidenceEventIds: [t.eventId], decidedAt: T0 + 1_000, underlying: 'SPY', firstEventAt: T0, lastEventAt: T0 },
    log.finalCorrected(), { finalityHorizonMs: 60_000, clusterGapMs: 500 });
  assert.equal(invalidated.status, 'INVALIDATED_BY_CORRECTION');
  assert.deepEqual(failing(candidate({ evidence: [t], finalRevision: invalidated })), ['FAIL:final-tape']);
});

/** A candidate decided at `iso`, from one print a second earlier. */
function decidedAt(iso: string, expiry = '2026-12-18'): H001Candidate {
  const ms = Date.parse(iso);
  const ev = [trade({ eventTime: ms - 1_000, providerReceiveTime: ms - 997, instrument: { underlying: 'SPY', expiry, strike: 570, right: 'C' } })];
  return candidate({ decisionAt: ms, evidence: ev, finalRevision: finalRevisionOf(ev, ms) });
}

test('the decision window is the calendar\'s, with room for the one-second latency and the M15 exit', () => {
  // 15:44:59 ET decides; the exit at 16:00:00 is inside the session.
  assert.deepEqual(failing(decidedAt('2026-03-10T19:44:59.000Z')), []);
  // 15:45:00 ET exits at 16:00:01 — past the close the rule exists to respect.
  assert.deepEqual(failing(decidedAt('2026-03-10T19:45:00.000Z')), ['FAIL:decision-window']);
  // Decided one second after the open, from a print stamped at the open.
  assert.deepEqual(failing(decidedAt('2026-03-10T13:30:01.000Z')), [], 'the open itself is inside');
  // Before the open the print's own session is unknown by clock inference too,
  // so the window is not the only finding; it must still be one of them.
  const early = h001Eligibility(decidedAt('2026-03-10T13:29:59.000Z'), CTX);
  assert.equal(early.verdict, 'EXCLUDED');
  assert.ok(early.findings.some((f) => f.rule === 'decision-window' && f.outcome === 'FAIL'));
  // A half day closes at 13:00, so the bound moves to 12:45 with no special case.
  assert.deepEqual(failing(decidedAt('2026-11-27T17:44:59.000Z')), [], '12:44:59 ET on the day after Thanksgiving');
  assert.deepEqual(failing(decidedAt('2026-11-27T17:45:00.000Z')), ['FAIL:decision-window']);
});

test('what cannot be established is UNKNOWN — out of the sample, and counted apart from a failure', () => {
  // An identifier the reader cannot interpret: the clock is not allowed to overrule it.
  const unreadable = candidate({}, { rawSessionIdentifier: 7 });
  assert.deepEqual(failing(unreadable), ['UNKNOWN:session']);
  assert.equal(h001Eligibility(unreadable, CTX).verdict, 'UNKNOWN');
  assert.equal(h001Eligibility(unreadable, CTX).group, null);

  // An as-known revision where §J needs the final tape.
  const asKnown = candidate();
  const r = { ...asKnown.finalRevision, evaluatedAt: T0 + 5_000 };
  assert.deepEqual(failing({ ...asKnown, finalRevision: r }), ['UNKNOWN:final-tape']);

  // Past the calendar's coverage: no session can be read, so none is assumed.
  const v = h001Eligibility(decidedAt('2027-03-09T15:00:00.000Z', '2027-03-19'), CTX);
  assert.equal(v.verdict, 'UNKNOWN');
  assert.ok(v.findings.every((f) => f.outcome === 'UNKNOWN'));
  assert.ok(v.findings.some((f) => f.rule === 'decision-window'));

  // A contract "expiring" on a holiday has no lifecycle anyone can state
  // (2026-06-19 is Juneteenth); the print's session is fine, its contract is not known.
  const holidayExpiry = candidate({}, { instrument: { underlying: 'SPY', expiry: '2026-06-19', strike: 570, right: 'C' } });
  assert.deepEqual(failing(holidayExpiry), ['UNKNOWN:contract-lifecycle']);

  // A definite failure beside an unknown is EXCLUDED: one known reason is enough.
  assert.equal(h001Eligibility({ ...unreadable, underlying: 'QQQ' }, CTX).verdict, 'EXCLUDED');
});

test('every failing rule is reported, not only the first', () => {
  const c = candidate({ underlying: 'QQQ', totalPremium: 10, synthetic: true, manifest: null }, { providerReceiveTime: undefined });
  assert.deepEqual(failing(c), ['FAIL:availability-basis', 'FAIL:premium', 'FAIL:rights', 'FAIL:synthetic', 'FAIL:underlying']);
});

test('the rights rule is the import rule, including the business mode', () => {
  const v = h001Eligibility(candidate(), { mode: 'PUBLIC_COMMERCIAL', today: TODAY });
  assert.deepEqual(v.findings.map((f) => f.rule), ['rights']);
  assert.match(v.findings[0]!.why, /read for PRIVATE_RESEARCH/);
});

test('a single-leg signal whose evidence spans contracts, or includes a put, is refused', () => {
  const two = [trade(), trade({ providerSequence: '101', instrument: { underlying: 'SPY', expiry: '2026-03-20', strike: 575, right: 'C' } })];
  assert.deepEqual(failing(candidate({ evidence: two, finalRevision: finalRevisionOf(two, T0 + 1_000) })), ['FAIL:single-leg-call']);
});
