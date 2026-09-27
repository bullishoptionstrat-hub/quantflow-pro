/**
 * Historical import, and the small-sample gate a first import must pass
 * before anything larger is allowed in (directive §17).
 *
 * The gate exists because the first corpus is the one that can contaminate
 * everything after it. A year of data read through a mis-mapped condition
 * code, or a pairing of trades with post-trade quotes, does not announce
 * itself — it produces results. So one or two days are imported TWICE, and a
 * list of properties is proven on them before the main import is permitted.
 *
 * Every check reports PASS, FAIL or NOT_ASSESSABLE, and only a gate whose
 * every check PASSES is passed. NOT_ASSESSABLE is not a soft pass: a sample
 * with no cancels in it proves nothing about cancel handling, and a gate that
 * waved it through would certify a property nobody tested. The operator
 * chooses sample days that exercise the checks; the gate says which ones did.
 *
 * Nothing in this environment can pass it — no real provider sample exists,
 * the code table and session rules are UNVERIFIED, and no dataset manifest
 * grants import rights. That is the correct output today, and the test suite
 * asserts it, so the gate cannot be quietly weakened into passing on fixtures.
 */
import { EventLog } from './eventLog';
import type { CancelOutcome } from './eventLog';
import { ReorderBuffer } from './reorder';
import type { GapWindow } from './reorder';
import type { HistoricalOptionsSource, HistoricalRequest, SourceCapabilities, TradeQuoteEvidence } from './historical';
import type { MarketEvent, SessionEvidence } from './types';
import { isAtLeast } from './semantics';
import type { SourceStatus } from './semantics';
import { importPermitted } from '../provenance/researchManifest';
import type { DatasetRightsManifest } from '../provenance/researchManifest';

export interface ImportReport {
  provider: string;
  datasetId: string;
  capabilities: SourceCapabilities;
  request: HistoricalRequest;
  /** Items the source yielded, events and rejections together. */
  received: number;
  rejected: Array<{ reason: string; rawRecordRef?: string }>;
  appended: number;
  duplicateIdentical: number;
  duplicateConflict: number;
  providerReportedCount: number | null;
  ordered: number;
  late: number;
  openGaps: GapWindow[];
  sequenced: number;
  cancels: { total: number; resolved: number; unresolvedByOutcome: Record<Exclude<CancelOutcome, 'RESOLVED'>, number> };
  sessions: Record<SessionEvidence['normalized'], number>;
  sessionBases: Record<SessionEvidence['basis'], number>;
  tradeQuotes: { total: number; strictlyBefore: number; otherRelation: number; withoutQuote: number } | null;
  withRawRecordRef: number;
  synthetic: number;
  semanticsStatus: SourceStatus;
  /** Sorted event ids and FINAL trade states — the determinism fingerprint. */
  fingerprint: string;
  log: EventLog;
}

export interface ImportOptions {
  allowedLatenessMs: number;
}

async function collect<T>(it: AsyncIterable<T> | undefined): Promise<T[]> {
  const out: T[] = [];
  if (it === undefined) return out;
  for await (const x of it) out.push(x);
  return out;
}

export async function importHistorical(
  source: HistoricalOptionsSource,
  request: HistoricalRequest,
  opts: ImportOptions,
): Promise<ImportReport> {
  const caps = source.capabilities();
  const tradeItems = await collect(source.trades(request));
  const quoteItems = await collect(source.quotes?.(request));
  const pairItems = await collect(source.tradeQuotes?.(request));

  const rejected: ImportReport['rejected'] = [];
  const events: MarketEvent[] = [];
  for (const item of [...tradeItems, ...quoteItems]) {
    if (item.ok) events.push(item.event);
    else rejected.push({ reason: item.reason, ...(item.rawRecordRef !== undefined ? { rawRecordRef: item.rawRecordRef } : {}) });
  }
  const pairs: TradeQuoteEvidence[] = [];
  for (const item of pairItems) {
    if (item.ok) pairs.push(item.event);
    else rejected.push({ reason: item.reason, ...(item.rawRecordRef !== undefined ? { rawRecordRef: item.rawRecordRef } : {}) });
  }
  // A pair's quote is an event like any other; its trade is already among the
  // trades, and appending it again is the duplicate check doing its job.
  for (const p of pairs) if (p.quote !== null) events.push(p.quote);

  // Arrival order is availableAt order; a stable sort keeps the source's order
  // for ties, which is the only order the source gave.
  const arrival = events.map((e, i) => ({ e, i })).sort((a, b) => a.e.availableAt - b.e.availableAt || a.i - b.i);
  const log = new EventLog();
  const buffer = new ReorderBuffer({ allowedLatenessMs: opts.allowedLatenessMs });
  let appended = 0;
  let duplicateIdentical = 0;
  let duplicateConflict = 0;
  let ordered = 0;
  let late = 0;
  const tally = (ems: ReturnType<ReorderBuffer['push']>) => {
    for (const em of ems) em.kind === 'ORDERED' ? ordered++ : late++;
  };
  for (const { e } of arrival) {
    const out = log.append(e);
    if (out.status === 'APPENDED') {
      appended++;
      tally(buffer.push(e));
    } else if (out.status === 'DUPLICATE_IDENTICAL') duplicateIdentical++;
    else duplicateConflict++;
  }
  tally(buffer.flush());

  const final = log.finalCorrected();
  const stored = log.events();
  // Every outcome is a key from the start, so a count is never defaulted:
  // an absent key would read as zero, and here it would be one.
  const unresolvedByOutcome: Record<Exclude<CancelOutcome, 'RESOLVED'>, number> = {
    UNRESOLVED_REFERENCE_UNKNOWN: 0, UNRESOLVED_ALREADY_CANCELLED: 0, UNRESOLVED_NO_MATCH: 0,
    UNRESOLVED_AMBIGUOUS: 0, UNRESOLVED_RESTATEMENT_MISMATCH: 0, UNRESOLVED_INSUFFICIENT_RESTATEMENT: 0,
    UNRESOLVED_SCOPE_UNKNOWN: 0, UNRESOLVED_SCOPE_CONTRADICTION: 0,
  };
  for (const c of final.cancels) {
    if (c.outcome !== 'RESOLVED') unresolvedByOutcome[c.outcome]++;
  }
  const sessions = { REGULAR: 0, EXTENDED: 0, UNKNOWN: 0, CONFLICT: 0 };
  const sessionBases = { PROVIDER_SESSION_IDENTIFIER: 0, LEGACY_SALE_CONDITION: 0, BOTH_AGREE: 0, BOTH_DISAGREE: 0, NONE: 0 };
  for (const e of stored) {
    if (e.kind === 'QUOTE') continue;
    sessions[e.sessionEvidence.normalized]++;
    sessionBases[e.sessionEvidence.basis]++;
  }

  const fingerprint = JSON.stringify({
    ids: stored.map((e) => e.eventId).sort(),
    states: final.trades.map((t) => [t.event.eventId, t.state]).sort(),
    cancels: final.cancels.map((c) => [c.cancelEventId, c.outcome, c.targetEventId]).sort(),
  });

  return {
    provider: caps.provider,
    datasetId: caps.datasetId,
    capabilities: caps,
    request,
    received: tradeItems.length + quoteItems.length + pairItems.length,
    rejected,
    appended,
    duplicateIdentical,
    duplicateConflict,
    providerReportedCount: (await source.providerReportedCount?.(request)) ?? null,
    ordered,
    late,
    openGaps: buffer.openGaps(),
    sequenced: stored.filter((e) => e.providerSequence !== undefined).length,
    cancels: {
      total: final.cancels.length,
      resolved: final.cancels.filter((c) => c.outcome === 'RESOLVED').length,
      unresolvedByOutcome,
    },
    sessions,
    sessionBases,
    tradeQuotes: source.tradeQuotes === undefined ? null : {
      total: pairs.length,
      strictlyBefore: pairs.filter((p) => p.quote !== null && p.quoteRelation === 'STRICTLY_BEFORE').length,
      otherRelation: pairs.filter((p) => p.quote !== null && p.quoteRelation !== 'STRICTLY_BEFORE').length,
      withoutQuote: pairs.filter((p) => p.quote === null).length,
    },
    withRawRecordRef: stored.filter((e) => e.rawRecordRef !== undefined).length,
    synthetic: stored.filter((e) => e.synthetic).length,
    semanticsStatus: final.semanticsStatus,
    fingerprint,
    log,
  };
}

export type CheckStatus = 'PASS' | 'FAIL' | 'NOT_ASSESSABLE';

export interface GateCheck {
  id: string;
  status: CheckStatus;
  detail: string;
}

export interface GateVerdict {
  passed: boolean;
  checks: GateCheck[];
}

/**
 * The §17 checks, on two imports of the same request and the dataset's
 * rights manifest. `today` is passed in so the verdict is reproducible.
 */
export function smallSampleGate(
  first: ImportReport,
  second: ImportReport,
  manifest: DatasetRightsManifest | null,
  today: string,
): GateVerdict {
  const checks: GateCheck[] = [];
  const add = (id: string, status: CheckStatus, detail: string) => checks.push({ id, status, detail });
  const r = first;

  add('real-provider-data', r.synthetic === 0 && r.appended > 0 ? 'PASS' : 'FAIL',
    r.synthetic > 0 ? `${r.synthetic} of ${r.appended} events are synthetic — a fixture is not a provider sample`
      : r.appended === 0 ? 'no events were imported' : 'no synthetic events');

  const noIdentity = r.log.events().filter((e) => e.kind !== 'QUOTE' && e.providerEventId === undefined && e.providerSequence === undefined).length;
  add('stable-contract-identity',
    r.capabilities.instrumentDefinitions.status !== 'AVAILABLE' ? 'NOT_ASSESSABLE'
      : noIdentity > 0 ? 'FAIL' : 'PASS',
    r.capabilities.instrumentDefinitions.status !== 'AVAILABLE'
      ? 'the source supplies no instrument definitions to check contract identity against'
      : noIdentity > 0 ? `${noIdentity} trade events have no provider identity, so a changed record cannot be detected`
        : 'definitions available and every trade carries a provider identity');

  const final = r.log.finalCorrected();
  const last = Math.max(...r.log.events().map((e) => e.availableAt));
  const atLast = r.appended > 0 ? r.log.asKnownAt(last) : final;
  const same = JSON.stringify({ ...atLast, basis: null, asOf: null }) === JSON.stringify({ ...final, basis: null, asOf: null });
  add('chronological-reconstruction', same ? 'PASS' : 'FAIL',
    same ? 'the corrected tape is the as-known tape at the last arrival' : 'the two views disagree at the last arrival');

  const blind = r.cancels.unresolvedByOutcome.UNRESOLVED_SCOPE_UNKNOWN + r.cancels.unresolvedByOutcome.UNRESOLVED_REFERENCE_UNKNOWN;
  add('corrections-and-cancels',
    r.cancels.total === 0 ? 'NOT_ASSESSABLE' : blind > 0 ? 'FAIL' : 'PASS',
    r.cancels.total === 0 ? 'the sample contains no cancels — choose a day that does'
      : blind > 0 ? `${blind} cancel(s) whose codes or references could not be read`
        : `${r.cancels.resolved} of ${r.cancels.total} resolved; the rest disputed their candidates rather than guessing`);

  const tradeEvents = r.log.events().filter((e) => e.kind !== 'QUOTE').length;
  const unreadable = r.sessions.CONFLICT + (r.sessionBases.PROVIDER_SESSION_IDENTIFIER > 0 ? r.sessions.UNKNOWN : 0);
  add('session-semantics',
    tradeEvents === 0 || r.sessionBases.NONE === tradeEvents ? 'NOT_ASSESSABLE'
      : unreadable > 0 ? 'FAIL' : 'PASS',
    `sessions ${JSON.stringify(r.sessions)}; bases ${JSON.stringify(r.sessionBases)}`);

  add('causal-quote-alignment',
    r.tradeQuotes === null || r.tradeQuotes.total === 0 ? 'NOT_ASSESSABLE'
      : r.tradeQuotes.otherRelation > 0 ? 'FAIL' : 'PASS',
    r.tradeQuotes === null ? 'the source pairs no trades with quotes'
      : `${r.tradeQuotes.strictlyBefore} strictly-before, ${r.tradeQuotes.otherRelation} otherwise, ${r.tradeQuotes.withoutQuote} with no quote`);

  add('provider-sequencing',
    r.sequenced === 0 ? 'NOT_ASSESSABLE' : r.openGaps.length > 0 ? 'FAIL' : 'PASS',
    r.sequenced === 0 ? 'no event carries a provider sequence'
      : r.openGaps.length > 0 ? `${r.openGaps.length} unfilled gap(s): ${r.openGaps.map((g) => `${g.scope} ${g.from}–${g.to}`).join(', ')}`
        : `${r.sequenced} sequenced events, no gaps`);

  add('duplicate-handling', r.duplicateConflict === 0 ? 'PASS' : 'FAIL',
    `${r.duplicateIdentical} identical re-deliveries, ${r.duplicateConflict} conflicting`);

  add('raw-provenance', r.withRawRecordRef === r.appended && r.appended > 0 ? 'PASS' : 'FAIL',
    `${r.withRawRecordRef} of ${r.appended} events point back to their raw record`);

  const rights = importPermitted(manifest, today);
  add('rights-metadata', rights.allowed ? 'PASS' : 'FAIL',
    rights.allowed ? 'the manifest grants every axis an import needs' : rights.why.join('; '));

  add('deterministic-reimport', first.fingerprint === second.fingerprint ? 'PASS' : 'FAIL',
    first.fingerprint === second.fingerprint ? 'two imports produced identical events, states and resolutions'
      : 'a second import of the same request produced a different tape');

  const accounted = r.appended + r.duplicateIdentical + r.duplicateConflict + r.rejected.length;
  const reconciles = accounted === r.received && (r.providerReportedCount === null || r.providerReportedCount === r.received);
  add('event-counts-reconcile',
    !reconciles ? 'FAIL' : r.providerReportedCount === null ? 'NOT_ASSESSABLE' : 'PASS',
    `received ${r.received} = appended ${r.appended} + duplicates ${r.duplicateIdentical + r.duplicateConflict} + rejected ${r.rejected.length}` +
    (r.providerReportedCount === null ? '; the provider reported no count to reconcile against' : `; provider reported ${r.providerReportedCount}`));

  add('code-semantics-verified', isAtLeast(r.semanticsStatus, 'PRIMARY_VERIFIED') ? 'PASS' : 'FAIL',
    `the tape was read through rules whose weakest standing is ${r.semanticsStatus}`);

  return { passed: checks.every((c) => c.status === 'PASS'), checks };
}
