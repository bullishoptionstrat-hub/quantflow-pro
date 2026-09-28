/**
 * The historical path end to end: a provider-neutral source, the import, the
 * §17 small-sample gate, and the parity seam into the flow engine.
 *
 * Three claims, each with its counter-case:
 *
 *   1. The gate FAILS on everything this environment has — synthetic fixtures,
 *      UNVERIFIED semantics, a manifest that grants nothing. Asserted, so the
 *      gate cannot be weakened into passing on fixtures without a test saying so.
 *   2. The gate CAN pass. A hypothetical conforming source — non-synthetic,
 *      verified semantics, strict pre-trade quotes, definitions, reconciled
 *      counts, a manifest with the words that permit it — passes every check,
 *      and breaking any one property fails exactly its check. A gate nothing
 *      could ever pass would be a check with nothing to check.
 *   3. Parity: V2 events reach the engine through `ingestPrint`, the seam live
 *      prints use. A signal's evidence is only admitted events; a late report,
 *      a complex leg, an uninterpreted code and a cancel never appear in any
 *      `print_ids`; the side comes from the causal quote via the engine's own
 *      classifier; and a later cancel revises the signal the engine formed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildQuoteEvent, buildTradeEvent, MalformedRecordError } from '../src/events/build';
import type { RawQuoteRecord, RawTradeRecord } from '../src/events/build';
import { importHistorical, smallSampleGate } from '../src/events/importGate';
import type { GateCheck } from '../src/events/importGate';
import type {
  CapabilityClaim, HistoricalOptionsSource, HistoricalRequest, SourceCapabilities, SourceItem, TradeQuoteEvidence,
} from '../src/events/historical';
import type { QuoteEvent, TradeCancelEvent, TradeReportEvent } from '../src/events/types';
import { OPRA_LAST_SALE_CODES, OPRA_SESSION_ENCODING, codeTableOf } from '../src/events/semantics';
import type { ProviderSemantics } from '../src/events/semantics';
import { importPermitted, manifestProblems } from '../src/provenance/researchManifest';
import type { DatasetRightsManifest, RightsFact } from '../src/provenance/researchManifest';
import { detectorAdmission, toRawPrint } from '../src/events/detector';
import { causalQuoteFor } from '../src/events/causalQuote';
import { reviseSignal } from '../src/events/signalRevision';
import { EventLog } from '../src/events/eventLog';
import { ReorderBuffer } from '../src/events/reorder';
import { drainIdle, ingestPrint, resetDaily } from '../src/ingestion/flowEngineAdapter';

const TODAY = '2026-09-27';
const T0 = Date.parse('2026-09-24T14:00:00.000Z');
const SPY = { underlying: 'SPY', expiry: '2026-10-16', strike: 550, right: 'C' as const };
const REQ: HistoricalRequest = { underlying: 'SPY', from: '2026-09-24', to: '2026-09-24' };

const claim = (status: CapabilityClaim['status']): CapabilityClaim =>
  ({ status, evidence: 'SAMPLE_VERIFIED', note: 'test source' });

function caps(over: Partial<SourceCapabilities> = {}): SourceCapabilities {
  return {
    provider: 'hypothetical', datasetId: 'HYPOTHETICAL.OPRA',
    trades: claim('AVAILABLE'), quotes: claim('AVAILABLE'), tradeQuotes: claim('AVAILABLE'),
    quoteStrictlyBeforeTrade: claim('AVAILABLE'), instrumentDefinitions: claim('AVAILABLE'),
    eventTime: claim('AVAILABLE'), providerReceiveTime: claim('AVAILABLE'), sequence: claim('AVAILABLE'),
    saleConditions: claim('AVAILABLE'), sessionIdentifier: claim('AVAILABLE'), cancels: claim('AVAILABLE'),
    venue: claim('AVAILABLE'), ...over,
  };
}

/** Semantics with every row upgraded — only a test may pretend the reading was done. */
const VERIFIED: ProviderSemantics = {
  codes: codeTableOf(OPRA_LAST_SALE_CODES.map((r) => ({ ...r, status: 'PRIMARY_VERIFIED' as const }))),
  session: { ...OPRA_SESSION_ENCODING, status: 'PRIMARY_VERIFIED' },
};

async function* each<T>(xs: readonly T[]): AsyncIterable<T> { for (const x of xs) yield x; }

interface Spec {
  trades: RawTradeRecord[];
  /** `trade` is an index into `trades`, or a record the trade stream does not carry. */
  pairs?: Array<{ trade: number | RawTradeRecord; quote: RawQuoteRecord | null; relation: TradeQuoteEvidence['quoteRelation'] }>;
  malformed?: number;
  reportedCount?: number | null;
  semantics?: ProviderSemantics;
  capabilities?: SourceCapabilities;
}

function sourceOf(spec: Spec): HistoricalOptionsSource {
  const sem = spec.semantics ?? VERIFIED;
  const built = (): Array<SourceItem<TradeReportEvent | TradeCancelEvent>> => [
    ...spec.trades.map((r) => ({ ok: true as const, event: buildTradeEvent(r, sem) })),
    ...Array.from({ length: spec.malformed ?? 0 }, (_, i) => {
      try {
        buildTradeEvent({ ...spec.trades[0]!, instrument: { ...SPY, strike: 0 } }, sem);
        throw new Error('unreachable');
      } catch (e) {
        return { ok: false as const, reason: (e as MalformedRecordError).reason, rawRecordRef: `bad-${i}` };
      }
    }),
  ];
  return {
    capabilities: () => spec.capabilities ?? caps(),
    trades: () => each(built()),
    ...(spec.pairs ? {
      tradeQuotes: () => each(spec.pairs!.map((p) => ({
        ok: true as const,
        event: {
          trade: buildTradeEvent(typeof p.trade === 'number' ? spec.trades[p.trade]! : p.trade, sem),
          quote: p.quote === null ? null : buildQuoteEvent(p.quote, sem),
          quoteRelation: p.relation,
        },
      }))),
    } : {}),
    instrumentDefinitions: () => each([{ ok: true as const, event: { instrument: SPY, providerInstrumentId: '1', rawSymbol: 'SPY   261016C00550000', definedAt: T0 } }]),
    providerReportedCount: async () => spec.reportedCount === undefined ? null : spec.reportedCount,
  };
}

function rec(i: number, over: Partial<RawTradeRecord> = {}): RawTradeRecord {
  return {
    provider: 'hypothetical', datasetId: 'HYPOTHETICAL.OPRA', sequenceScope: 'line-1:2026-09-24',
    providerSequence: String(100 + i), eventTime: T0 + i * 1_000, providerReceiveTime: T0 + i * 1_000 + 3,
    instrument: SPY, venue: 'C', rawSessionIdentifier: 0, rawRecordRef: `raw/2026-09-24/line-1#${100 + i}`,
    synthetic: false, replay: true, price: 2 + i / 100, size: 5 + i, ...over,
  };
}
const quoteRec = (i: number, eventTime: number): RawQuoteRecord => ({
  provider: 'hypothetical', datasetId: 'HYPOTHETICAL.OPRA', sequenceScope: 'quotes-1:2026-09-24',
  providerSequence: String(500 + i), eventTime, providerReceiveTime: eventTime + 2, instrument: SPY, venue: 'C',
  rawSessionIdentifier: 0, rawRecordRef: `raw/2026-09-24/quotes-1#${500 + i}`, synthetic: false, replay: true,
  bid: 1.9 + i / 100, ask: 2.1 + i / 100, bidSize: 10, askSize: 10,
});

function conforming(): Spec {
  const trades = [rec(0), rec(1), rec(2), rec(3),
    rec(4, { rawMessageType: 'CANC', price: 2.01, size: 6, eventTime: T0 + 9_000, providerReceiveTime: T0 + 9_003 })];
  return {
    trades,
    pairs: [0, 1, 2, 3].map((i) => ({ trade: i, quote: quoteRec(i, T0 + i * 1_000 - 5), relation: 'STRICTLY_BEFORE' as const })),
    // The provider's count is of TRADE records — five here. It used to be 9,
    // trades plus pairs, which only matched because the check summed them too.
    reportedCount: 5,
  };
}

const fact = (quote: string): RightsFact => ({
  status: 'PERMITTED', quote, document: 'https://example.test/hypothetical-terms', readAt: '2026-09-20',
  evidence: 'PROVIDER_VERIFIED', note: 'a test manifest — no real vendor is described',
});
const PERMISSIVE: DatasetRightsManifest = {
  schema: 'quantflow-dataset-rights-v1', provider: 'hypothetical', dataset: 'HYPOTHETICAL.OPRA',
  subscriptionTier: 'test', intendedDeploymentMode: 'PRIVATE_RESEARCH',
  rights: {
    fetch: fact('(test) fetch'), persistRaw: fact('(test) keep raw'), persistNormalized: fact('(test) keep normalised'),
    researchUse: fact('(test) research'), modelTraining: fact('(test) training'), export: fact('(test) export'),
    redistribution: { ...fact('(test)'), status: 'PROHIBITED' }, retention: fact('(test) retention'),
  },
  sourceDocuments: ['https://example.test/hypothetical-terms'], verifiedAt: '2026-09-20',
};

async function gate(spec: Spec, manifest: DatasetRightsManifest | null = PERMISSIVE, mode: 'PRIVATE_RESEARCH' | 'PUBLIC_COMMERCIAL' = 'PRIVATE_RESEARCH') {
  const src = sourceOf(spec);
  const a = await importHistorical(src, REQ, { allowedLatenessMs: 1_000 });
  const b = await importHistorical(src, REQ, { allowedLatenessMs: 1_000 });
  return { report: a, verdict: smallSampleGate(a, b, manifest, TODAY, mode) };
}
const statusOf = (checks: GateCheck[]) => Object.fromEntries(checks.map((c) => [c.id, c.status]));

// ─── 1. The gate fails on what exists ─────────────────────────────────────────

test('gate: the golden fixtures, read through today\'s semantics, fail — for the right reasons', async () => {
  const f = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'events', '05-ordinary-cancellation-canc.json'), 'utf8'));
  const trades: RawTradeRecord[] = f.records.map(({ ref: _r, type: _t, ...r }: Record<string, unknown>) => ({
    ...f.defaults, ...r,
    eventTime: Date.parse(r.eventTime as string), providerReceiveTime: Date.parse(r.providerReceiveTime as string),
  }));
  const manifest = JSON.parse(readFileSync(join(__dirname, '..', '..', 'research', 'manifests', 'databento-opra-historical.json'), 'utf8'));
  const { verdict } = await gate({ trades, semantics: { codes: codeTableOf(OPRA_LAST_SALE_CODES), session: OPRA_SESSION_ENCODING }, capabilities: caps({ instrumentDefinitions: claim('MISSING') }) }, manifest);
  const s = statusOf(verdict.checks);
  assert.equal(verdict.passed, false);
  assert.equal(s['real-provider-data'], 'FAIL', 'a fixture is not a provider sample');
  assert.equal(s['rights-metadata'], 'FAIL', 'the candidate manifest grants nothing');
  assert.equal(s['code-semantics-verified'], 'FAIL', 'the OPRA table is UNVERIFIED');
  assert.equal(s['raw-provenance'], 'FAIL', 'fixtures carry no raw record pointer');
  assert.equal(s['stable-contract-identity'], 'NOT_ASSESSABLE');
  assert.equal(s['deterministic-reimport'], 'PASS');
  assert.equal(s['corrections-and-cancels'], 'PASS');
});

test('manifests: the candidates are well-formed and grant nothing, and no quote is a paraphrase', () => {
  for (const name of ['databento-opra-historical.json', 'thetadata-opra-historical.json']) {
    const m: DatasetRightsManifest = JSON.parse(readFileSync(join(__dirname, '..', '..', 'research', 'manifests', name), 'utf8'));
    assert.deepEqual(manifestProblems(m, TODAY), [], name);
    const verdict = importPermitted(m, TODAY, 'PRIVATE_RESEARCH');
    assert.equal(verdict.allowed, false, `${name}: nothing was read, so nothing is permitted`);
    for (const [axis, f] of Object.entries(m.rights)) {
      assert.equal(f.quote, null, `${name}.${axis}: no primary document was read, so there are no words to quote`);
      assert.notEqual(f.status, 'PERMITTED');
    }
    assert.equal(m.verifiedAt, null);
  }
});

test('manifest: a download is not a permission (INV-RIGHTS-001)', () => {
  const hopeful: DatasetRightsManifest = {
    ...PERMISSIVE,
    rights: { ...PERMISSIVE.rights, persistRaw: { ...PERMISSIVE.rights.persistRaw, quote: null, evidence: 'UNVERIFIED', note: 'the download worked' } },
  };
  const problems = manifestProblems(hopeful, TODAY).join('\n');
  assert.match(problems, /persistRaw: PERMITTED needs the words/);
  assert.match(problems, /technical accessibility does not promote a rights classification/);
  assert.equal(importPermitted(hopeful, TODAY, 'PRIVATE_RESEARCH').allowed, false);
  assert.match(manifestProblems({ ...PERMISSIVE, rights: { ...PERMISSIVE.rights, fetch: { ...PERMISSIVE.rights.fetch, readAt: '2026-10-01' } } }, TODAY).join(' '),
    /not a real date on or before/, 'a reading that has not happened is not provenance');
});

// ─── 2. The gate can pass, and each property fails its own check ────────────

test('gate: a conforming source passes every check', async () => {
  const { verdict, report } = await gate(conforming());
  assert.deepEqual(verdict.checks.filter((c) => c.status !== 'PASS'), []);
  assert.equal(verdict.passed, true);
  assert.equal(report.cancels.resolved, 1);
});

test('gate: each broken property fails exactly its own check', async () => {
  const cases: Array<[string, (s: Spec) => Spec, DatasetRightsManifest | null]> = [
    ['causal-quote-alignment', (s) => ({ ...s, pairs: s.pairs!.map((p, i) => i === 0 ? { ...p, relation: 'AT_OR_BEFORE' as const } : p) }), PERMISSIVE],
    ['provider-sequencing', (s) => ({ ...s, trades: s.trades.map((t, i) => i === 2 ? { ...t, providerSequence: '150' } : t) }), PERMISSIVE],
    ['duplicate-handling', (s) => ({ ...s, trades: [...s.trades, { ...s.trades[1]!, price: 9 }], reportedCount: 6 }), PERMISSIVE],
    ['raw-provenance', (s) => ({ ...s, trades: s.trades.map((t, i) => i === 1 ? { ...t, rawRecordRef: undefined } : t) }), PERMISSIVE],
    ['rights-metadata', (s) => s, null],
    ['event-counts-reconcile', (s) => ({ ...s, reportedCount: 9 }), PERMISSIVE],
    // A pair describing a trade the trade stream never sent shows nothing about alignment.
    ['causal-quote-alignment', (s) => ({ ...s, pairs: [...s.pairs!, { trade: rec(50), quote: quoteRec(4, T0 + 50_000 - 5), relation: 'STRICTLY_BEFORE' as const }] }), PERMISSIVE],
    // A genuine conflict needs an encoding whose regular value is explicit, not a default.
    ['session-semantics', (s) => ({
      ...s, semantics: { ...VERIFIED, session: { ...VERIFIED.session, defaultValue: null } },
      trades: s.trades.map((t, i) => i === 0 ? { ...t, rawConditions: ['v'] } : t),
    }), PERMISSIVE],
    ['corrections-and-cancels', (s) => ({ ...s, trades: s.trades.map((t, i) => i === 4 ? { ...t, referencedProviderEventId: 'nope' } : t) }), PERMISSIVE],
    ['real-provider-data', (s) => ({ ...s, trades: s.trades.map((t, i) => i === 0 ? { ...t, synthetic: true } : t) }), PERMISSIVE],
  ];
  for (const [id, mutate, manifest] of cases) {
    const { verdict } = await gate(mutate(conforming()), manifest);
    const failing = verdict.checks.filter((c) => c.status !== 'PASS').map((c) => c.id);
    assert.deepEqual(failing, [id], `breaking ${id} should fail only ${id}; got ${failing.join(', ')}`);
  }
});

test('gate: an unreadable cancel code is two failures, because it is two problems', async () => {
  // The cancel's scope cannot be read, AND the tape now rests on a code no
  // rule interprets — the semantics are not verified for this sample.
  const spec = conforming();
  spec.trades[4] = { ...spec.trades[4]!, rawConditions: ['ZZZZ'] };
  const { verdict } = await gate(spec);
  assert.deepEqual(verdict.checks.filter((c) => c.status !== 'PASS').map((c) => c.id),
    ['corrections-and-cancels', 'code-semantics-verified']);
  // Likewise an unreadable session identifier: a session problem, and a reading
  // that established nothing.
  const spec2 = conforming();
  spec2.trades[0] = { ...spec2.trades[0]!, rawSessionIdentifier: 7 };
  const { verdict: v2 } = await gate(spec2);
  assert.deepEqual(v2.checks.filter((c) => c.status !== 'PASS').map((c) => c.id),
    ['session-semantics', 'code-semantics-verified']);
});

test('gate: a pair with no quote is reported, and is not an accounting failure', async () => {
  // It used to be counted as received and accounted for nowhere, so a
  // provider that sometimes has no pre-trade book failed event-counts for it.
  const spec = conforming();
  spec.pairs = [...spec.pairs!, { trade: 4, quote: null, relation: 'STRICTLY_BEFORE' }];
  const { report, verdict } = await gate(spec);
  assert.equal(report.tradeQuotes!.withoutQuote, 1);
  assert.deepEqual(verdict.checks.filter((c) => c.status !== 'PASS'), []);
});

test('gate: a pair whose trade differs from the trade stream\'s record is caught', async () => {
  // Same identity (provider sequence), different content: the pair's quote
  // describes a trade that is not the one the log holds.
  const spec = conforming();
  spec.pairs = spec.pairs!.map((p, i) => i === 0 ? { ...p, trade: { ...rec(0), size: 999 } } : p);
  const { report, verdict } = await gate(spec);
  assert.equal(report.tradeQuotes!.tradeNotInStream, 1);
  assert.deepEqual(verdict.checks.filter((c) => c.status !== 'PASS').map((c) => c.id), ['causal-quote-alignment']);
});

test('manifest: dates must exist, and the mode must be the one the terms were read for', async () => {
  const withDate = (d: string): DatasetRightsManifest =>
    ({ ...PERMISSIVE, rights: { ...PERMISSIVE.rights, fetch: { ...PERMISSIVE.rights.fetch, readAt: d } } });
  assert.match(manifestProblems(withDate('2026-02-31'), TODAY).join(' '), /2026-02-31 is not a real date/,
    'the shape of a date is not a date');
  assert.deepEqual(manifestProblems(withDate('2026-02-28'), TODAY), []);
  assert.match(manifestProblems({ ...PERMISSIVE, verifiedAt: 'soon' }, TODAY).join(' '), /verified date soon/);
  assert.equal(importPermitted(PERMISSIVE, TODAY, 'PRIVATE_RESEARCH').allowed, true);
  const commercial = importPermitted(PERMISSIVE, TODAY, 'PUBLIC_COMMERCIAL');
  assert.equal(commercial.allowed, false);
  assert.match(commercial.why.join(' '), /read for PRIVATE_RESEARCH, and this import runs under PUBLIC_COMMERCIAL/);
  const { verdict } = await gate(conforming(), PERMISSIVE, 'PUBLIC_COMMERCIAL');
  assert.deepEqual(verdict.checks.filter((c) => c.status !== 'PASS').map((c) => c.id), ['rights-metadata']);
});

test('gate: a rejected record is counted, not dropped', async () => {
  const spec = { ...conforming(), malformed: 2, reportedCount: 7 };
  const { report, verdict } = await gate(spec);
  assert.equal(report.rejected.length, 2);
  assert.match(report.rejected[0]!.reason, /strike/);
  assert.equal(statusOf(verdict.checks)['event-counts-reconcile'], 'PASS');
});

// ─── 3. Parity: V2 events form signals through the live seam ────────────────

test('parity: the engine forms signals from admitted V2 events only, through ingestPrint', () => {
  resetDaily();
  const base = (i: number, over: Partial<RawTradeRecord> = {}): RawTradeRecord => ({
    ...rec(i), provider: 'fixture', datasetId: 'FIXTURE.OPRA.V1', synthetic: true, replay: true,
    price: 2.2, size: 150, eventTime: T0 + i * 20, providerReceiveTime: T0 + i * 20 + 3, ...over,
  });
  const q = buildQuoteEvent({ ...quoteRec(0, T0 - 50), provider: 'fixture', datasetId: 'FIXTURE.OPRA.V1', synthetic: true, bid: 2.1, ask: 2.2 });
  const t0 = buildTradeEvent(base(0, { venue: 'C' })) as TradeReportEvent;
  const t1 = buildTradeEvent(base(1, { venue: 'X' })) as TradeReportEvent;
  const complexLeg = buildTradeEvent(base(2, { venue: 'P', rawMessageType: 'SPRD' })) as TradeReportEvent;
  const unknownCode = buildTradeEvent(base(3, { venue: 'P', rawMessageType: 'ZZZZ' })) as TradeReportEvent;
  const lateReport = buildTradeEvent(base(4, { rawMessageType: 'LATE', eventTime: T0 + 30, providerReceiveTime: T0 + 60_000 })) as TradeReportEvent;
  const cancelT1 = buildTradeEvent(base(5, { rawMessageType: 'CANC', price: 2.2, size: 150, eventTime: T0 + 120_000, providerReceiveTime: T0 + 120_003, venue: 'X' })) as TradeCancelEvent;

  const log = new EventLog();
  const buf = new ReorderBuffer({ allowedLatenessMs: 1_000 });
  const emissions = [];
  for (const e of [q, t0, t1, complexLeg, unknownCode, lateReport, cancelT1].sort((a, b) => a.availableAt - b.availableAt)) {
    log.append(e);
    emissions.push(...buf.push(e));
  }
  emissions.push(...buf.flush());

  const admitted: string[] = [];
  const refused = new Map<string, string>();
  const quotes = log.finalCorrected().quotes;
  const signals = [];
  for (const em of emissions) {
    const a = detectorAdmission(em);
    if (!a.admit) { refused.set(em.event.eventId, a.reason); continue; }
    admitted.push(a.event.eventId);
    // The causal quote is chosen per trade, against what was known when the trade was.
    signals.push(...ingestPrint(toRawPrint(a.event, causalQuoteFor(a.event, quotes))));
  }
  signals.push(...drainIdle(0));

  assert.deepEqual(new Set(admitted), new Set([t0.eventId, t1.eventId]));
  for (const id of [complexLeg.eventId, unknownCode.eventId, lateReport.eventId, cancelT1.eventId, q.eventId]) {
    assert.ok(refused.has(id), `${id} was admitted`);
  }
  assert.ok(signals.length > 0, 'the admitted prints formed a signal');
  const evidence = new Set(signals.flatMap((s) => s.print_ids));
  for (const id of refused.keys()) assert.ok(!evidence.has(id), 'a refused event appeared as a signal\'s evidence');
  assert.ok(signals.every((s) => s.side === 'BUY'), 'lifted at the offer of the causal quote, through the engine\'s own classifier');

  // The cancel arrived two minutes later; the signal the engine formed is REVISED.
  const sig = signals[0]!;
  const ids = sig.print_ids;
  const ev = ids.map((id) => log.get(id)!);
  const rev = reviseSignal(
    { signalId: sig.id, evidenceEventIds: ids, decidedAt: Math.max(...ev.map((e) => e.availableAt)),
      underlying: 'SPY', firstEventAt: Math.min(...ev.map((e) => e.eventTime)), lastEventAt: Math.max(...ev.map((e) => e.eventTime)) },
    log.finalCorrected(), { finalityHorizonMs: 3_600_000, clusterGapMs: 100 },
    { lateEvents: emissions.filter((e) => e.kind === 'LATE_EVENT').map((e) => e.event) },
  );
  assert.equal(rev.status, 'REVISED');
  assert.deepEqual(rev.cancelledEvidence.map((c) => c.eventId), [t1.eventId]);
  resetDaily();
});

test('parity: a V2 event\'s availableAt crosses the seam instead of being discarded', () => {
  const t = buildTradeEvent(rec(0, { providerReceiveTime: T0 + 250 })) as TradeReportEvent;
  const raw = toRawPrint(t, { status: 'NONE_PRIOR', simultaneousExcluded: 0, arrivedLaterExcluded: 0 });
  assert.equal(raw.receivedAt, T0 + 250);
  assert.equal(raw.bid, undefined, 'no causal quote, no book — the engine\'s contract makes that AMBIGUOUS');
});

test('gate: NOT_ASSESSABLE is not a pass — a sample with no cancels proves nothing about cancels', async () => {
  const spec = conforming();
  spec.trades = spec.trades.slice(0, 4);
  spec.reportedCount = 8;
  const { verdict } = await gate(spec);
  assert.equal(statusOf(verdict.checks)['corrections-and-cancels'], 'NOT_ASSESSABLE');
  assert.equal(verdict.passed, false);
});

test('detector: a late report is refused even when it arrives inside the lateness bound', () => {
  // The buffer only catches lateness it can see. A LATE report that arrives
  // within the bound is ORDERED by the buffer and still reported outside its
  // real-time slot by the provider's own code.
  const late = buildTradeEvent(rec(0, { rawMessageType: 'LATE' })) as TradeReportEvent;
  const a = detectorAdmission({ kind: 'ORDERED', event: late, finalizedAt: late.availableAt, orderBasis: 'FIRST' });
  assert.equal(a.admit, false);
  assert.match(a.admit ? '' : a.reason, /LATE_IN_SEQUENCE/);
  const iso = buildTradeEvent(rec(1, { rawMessageType: 'ISOI' })) as TradeReportEvent;
  const b = detectorAdmission({ kind: 'ORDERED', event: iso, finalizedAt: iso.availableAt, orderBasis: 'FIRST' });
  assert.ok(b.admit, 'an ISO execution is an ordinary print with a flag');
  assert.equal(toRawPrint(iso, { status: 'NONE_PRIOR', simultaneousExcluded: 0, arrivedLaterExcluded: 0 }).iso, true);
});

test('seam: only a causal, fresh, two-sided book is attached to a print', () => {
  const t = buildTradeEvent(rec(0)) as TradeReportEvent;
  const quote = buildQuoteEvent(quoteRec(0, T0 - 5_000));
  assert.equal(toRawPrint(t, { status: 'STALE', quote, ageMs: 5_000, maxAgeMs: 2_000 }).bid, undefined);
  assert.equal(toRawPrint(t, { status: 'FOUND', quote, ageMs: 5, book: 'CROSSED', finalAnswerDiffers: false }).bid, undefined);
  const ok = toRawPrint(t, { status: 'FOUND', quote, ageMs: 5, book: 'TWO_SIDED', finalAnswerDiffers: false });
  assert.deepEqual([ok.bid, ok.ask, ok.quoteTs], [quote.bid, quote.ask, quote.eventTime],
    'the quote travels under its own timestamp, not the trade\'s');
});
