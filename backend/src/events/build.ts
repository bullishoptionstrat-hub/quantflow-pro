/**
 * From a provider record to a Market Event V2.
 *
 * Adapters own the provider's shapes; this is where they hand over. An adapter
 * translates field names and units and nothing else — every code the provider
 * sent arrives here as delivered, and the meaning is decided in one place,
 * against a code table whose rows say how sure they are.
 *
 * Three decisions live here and nowhere else:
 *
 *   1. `availableAt`. The latest of the clocks the record carries, never
 *      earlier than the event itself. The basis names the strongest clock
 *      present, and `clockInversion` records when a receipt clock read before
 *      a clock that must precede it — skew is kept visible, not averaged away.
 *
 *   2. What the codes mean. Codes the table does not interpret make the
 *      lifecycle `UNKNOWN` — never `REGULAR`, because an unknown code could be
 *      "late" or "cancelled" and reading it as ordinary is the flattering guess.
 *      Two lifecycle codes on one report is a contradiction (the OPRA Category
 *      'a' types are mutually exclusive), so that is `UNKNOWN` too.
 *
 *   3. What is refused outright. A record that cannot describe a contract, or
 *      carries a price or size no market could produce, throws
 *      `MalformedRecordError` with the reason — so an importer counts it
 *      instead of admitting it with a default in the gap.
 */
import { MARKET_EVENT_SCHEMA } from './types';
import type {
  AvailabilityBasis,
  InstrumentRef,
  QuoteEvent,
  TradeCancelEvent,
  TradeReportEvent,
} from './types';
import { OPRA_CODE_TABLE, OPRA_SEMANTICS, weakestStatus } from './semantics';
import type { CancelScope, CodeRow, CodeTable, ProviderSemantics, ReportLifecycle, SourceStatus } from './semantics';
import { readSessionEvidence } from './session';
import { eventIdOf } from './eventId';
import type { EventDraft } from './eventId';
import { expiryInstantMs } from '../flow-engine/expiry';

export class MalformedRecordError extends Error {
  constructor(readonly reason: string) {
    super(`malformed provider record: ${reason}`);
    this.name = 'MalformedRecordError';
  }
}

/** Fields every provider record carries once an adapter has translated it. */
export interface RawRecordCommon {
  provider: string;
  datasetId: string;
  providerEventId?: string;
  /** A bigint or a decimal string; never a float, which rounds past 2^53. */
  providerSequence?: string | bigint;
  sequenceScope?: string;
  eventTime: number;
  providerReceiveTime?: number;
  quantflowReceiveTime?: number;
  instrument: InstrumentRef;
  venue?: string;
  /** The provider's own session field, exactly as delivered. */
  rawSessionIdentifier?: string | number | null;
  rawRecordRef?: string;
  synthetic: boolean;
  replay: boolean;
}

export interface RawTradeRecord extends RawRecordCommon {
  /** For a cancel that restates rather than names, the cancelled trade's. */
  price?: number;
  size?: number;
  /**
   * The provider's primary transaction code, as delivered — for OPRA, the Last
   * Sale message type. A blank "regular" code is `null`; the adapter maps its
   * provider's blank to null and does nothing else to the code.
   */
  rawMessageType?: string | null;
  /** Any further condition codes, in delivered order. */
  rawConditions?: string[];
  /** For a cancel that names its target: the provider's id for that trade. */
  referencedProviderEventId?: string;
}

export interface RawQuoteRecord extends RawRecordCommon {
  bid: number | null;
  ask: number | null;
  bidSize: number | null;
  askSize: number | null;
}

// ─── availableAt ─────────────────────────────────────────────────────────────

export interface Availability {
  availableAt: number;
  availableAtBasis: AvailabilityBasis;
  clockInversion: boolean;
}

export function availabilityOf(
  eventTime: number,
  providerReceiveTime?: number,
  quantflowReceiveTime?: number,
): Availability {
  const clocks = [eventTime];
  if (providerReceiveTime !== undefined) clocks.push(providerReceiveTime);
  if (quantflowReceiveTime !== undefined) clocks.push(quantflowReceiveTime);
  const availableBasis: AvailabilityBasis =
    quantflowReceiveTime !== undefined ? 'QUANTFLOW_RECEIPT'
      : providerReceiveTime !== undefined ? 'PROVIDER_RECEIPT'
        : 'EVENT_TIME_LOWER_BOUND';
  // The expected order is event ≤ provider receipt ≤ our receipt. Any clock
  // reading earlier than one that must precede it is skew, and the maximum of
  // all of them is the only answer that admits no lookahead.
  const clockInversion =
    (providerReceiveTime !== undefined && providerReceiveTime < eventTime) ||
    (quantflowReceiveTime !== undefined && quantflowReceiveTime < eventTime) ||
    (providerReceiveTime !== undefined && quantflowReceiveTime !== undefined &&
      quantflowReceiveTime < providerReceiveTime);
  return { availableAt: Math.max(...clocks), availableAtBasis: availableBasis, clockInversion };
}

// ─── Codes ───────────────────────────────────────────────────────────────────

export interface CodeReading {
  kind: 'REPORT' | 'CANCEL';
  lifecycle: ReportLifecycle;
  cancelScope: CancelScope | 'UNKNOWN';
  iso: boolean | null;
  complex: boolean | null;
  uninterpretedCodes: string[];
  semanticsStatus: SourceStatus;
}

/**
 * Read a record's codes against a table. Pure, and exported so the table's
 * consequences can be tested without building whole events.
 */
export function readCodes(
  rawMessageType: string | null | undefined,
  rawConditions: readonly string[] = [],
  table: CodeTable = OPRA_CODE_TABLE,
): CodeReading {
  const delivered = [
    ...(rawMessageType !== null && rawMessageType !== undefined ? [rawMessageType] : []),
    ...rawConditions,
  ];
  // A session qualifier speaks to the session and to nothing else; session.ts
  // reads it. Leaving it in would mark every legacy extended-hours print as
  // "uninterpreted" and exclude it for the wrong reason.
  const codes = delivered.filter((c) => table.get(c)?.meaning.kind !== 'SESSION_QUALIFIER');

  const used: CodeRow[] = [];
  const uninterpreted: string[] = [];
  const statuses: SourceStatus[] = [];
  for (const c of codes) {
    const row = table.get(c);
    if (row === undefined) {
      uninterpreted.push(c);
      statuses.push('UNVERIFIED');
      continue;
    }
    statuses.push(row.status);
    if (row.meaning.kind === 'QUALIFIER_UNINTERPRETED') uninterpreted.push(c);
    else used.push(row);
  }
  if (codes.length === 0) {
    // No qualifying code at all: the table's reading of "blank" is itself a
    // claim about the specification, with its own standing.
    const regular = table.get('REGULAR');
    if (regular !== undefined) {
      used.push(regular);
      statuses.push(regular.status);
    } else {
      statuses.push('UNVERIFIED');
    }
  }
  const semanticsStatus = weakestStatus(statuses);

  const cancels = used.flatMap((r) => (r.meaning.kind === 'CANCEL' ? [r.meaning.scope] : []));
  if (cancels.length > 0) {
    // One cancel code names its scope. Two name different trades, and an
    // uninterpreted code beside a cancel may qualify it in a way this table
    // cannot see — either way the scope is not established.
    const scope = cancels.length === 1 && uninterpreted.length === 0 ? cancels[0]! : 'UNKNOWN';
    return {
      kind: 'CANCEL', lifecycle: 'UNKNOWN', cancelScope: scope,
      iso: null, complex: null, uninterpretedCodes: uninterpreted, semanticsStatus,
    };
  }

  const reports = used.flatMap((r) => (r.meaning.kind === 'REPORT' ? [r.meaning] : []));
  const qualifying = [...new Set(reports.map((m) => m.lifecycle).filter((l) => l !== 'REGULAR'))];
  const lifecycle: ReportLifecycle =
    uninterpreted.length > 0 ? 'UNKNOWN'
      : qualifying.length > 1 ? 'UNKNOWN'
        : qualifying.length === 1 ? qualifying[0]!
          : 'REGULAR';
  // A flag is `false` only when every code was read and none raised it; an
  // uninterpreted code might have been the one that did.
  const flag = (f: 'iso' | 'complex'): boolean | null =>
    reports.some((m) => m[f] === true) ? true : uninterpreted.length > 0 ? null : false;
  return {
    kind: 'REPORT', lifecycle, cancelScope: 'UNKNOWN',
    iso: flag('iso'), complex: flag('complex'), uninterpretedCodes: uninterpreted, semanticsStatus,
  };
}

// ─── Validation ──────────────────────────────────────────────────────────────

function sequenceOf(seq: string | bigint | undefined): string | undefined {
  if (seq === undefined) return undefined;
  const s = typeof seq === 'bigint' ? seq.toString() : seq.trim();
  if (!/^\d+$/.test(s)) throw new MalformedRecordError(`sequence "${String(seq)}" is not a non-negative integer`);
  // Canonical form, so "007" and "7" cannot become two identities for one slot.
  return BigInt(s).toString();
}

function checkCommon(r: RawRecordCommon): void {
  if (!r.provider) throw new MalformedRecordError('no provider');
  if (!r.datasetId) throw new MalformedRecordError('no dataset id');
  if (!Number.isFinite(r.eventTime)) throw new MalformedRecordError('event time is not a finite instant');
  for (const [name, v] of [['provider receive time', r.providerReceiveTime], ['QuantFlow receive time', r.quantflowReceiveTime]] as const) {
    if (v !== undefined && !Number.isFinite(v)) throw new MalformedRecordError(`${name} is not a finite instant`);
  }
  const i = r.instrument;
  if (!i || !i.underlying) throw new MalformedRecordError('no underlying');
  if (i.right !== 'C' && i.right !== 'P') throw new MalformedRecordError(`right "${String(i.right)}" is neither C nor P`);
  // A strike of zero pads into a real-looking OCC symbol and classifies ITM
  // against every spot — the strike-0 finding, refused at the door this time.
  if (!(Number.isFinite(i.strike) && i.strike > 0)) throw new MalformedRecordError(`strike ${String(i.strike)} is not a positive price`);
  // The same reader the adapter gate uses (F-17), so there is one date rule.
  if (Number.isNaN(expiryInstantMs(i.expiry))) throw new MalformedRecordError(`expiry "${i.expiry}" is not an ISO calendar date`);
}

function nonNegative(v: number | undefined, what: string): void {
  if (v !== undefined && !(Number.isFinite(v) && v >= 0)) {
    throw new MalformedRecordError(`${what} ${String(v)} is not a non-negative number`);
  }
}

// ─── Builders ────────────────────────────────────────────────────────────────

function commonOf(r: RawRecordCommon, codes: readonly string[], semantics: ProviderSemantics) {
  const providerSequence = sequenceOf(r.providerSequence);
  return {
    schemaVersion: MARKET_EVENT_SCHEMA,
    provider: r.provider,
    datasetId: r.datasetId,
    ...(r.providerEventId !== undefined ? { providerEventId: r.providerEventId } : {}),
    ...(providerSequence !== undefined ? { providerSequence } : {}),
    ...(r.sequenceScope !== undefined ? { sequenceScope: r.sequenceScope } : {}),
    eventTime: r.eventTime,
    ...(r.providerReceiveTime !== undefined ? { providerReceiveTime: r.providerReceiveTime } : {}),
    ...(r.quantflowReceiveTime !== undefined ? { quantflowReceiveTime: r.quantflowReceiveTime } : {}),
    ...availabilityOf(r.eventTime, r.providerReceiveTime, r.quantflowReceiveTime),
    instrument: { ...r.instrument },
    ...(r.venue !== undefined ? { venue: r.venue } : {}),
    sessionEvidence: readSessionEvidence(r.rawSessionIdentifier, codes, semantics),
    ...(r.rawRecordRef !== undefined ? { rawRecordRef: r.rawRecordRef } : {}),
    synthetic: r.synthetic,
    replay: r.replay,
  };
}

/**
 * A trade record becomes a report or a cancel — decided by its codes, because
 * on an OPRA-style tape a cancel is a trade message carrying a cancel type.
 */
export function buildTradeEvent(
  r: RawTradeRecord,
  semantics: ProviderSemantics = OPRA_SEMANTICS,
): TradeReportEvent | TradeCancelEvent {
  const table = semantics.codes;
  checkCommon(r);
  const rawMessageType = r.rawMessageType ?? null;
  const rawConditions = [...(r.rawConditions ?? [])];
  const codes = [...(rawMessageType !== null ? [rawMessageType] : []), ...rawConditions];
  const reading = readCodes(rawMessageType, rawConditions, table);
  nonNegative(r.price, 'price');
  nonNegative(r.size, 'size');

  if (reading.kind === 'CANCEL') {
    const draft: Omit<TradeCancelEvent, 'eventId'> = {
      ...commonOf(r, codes, semantics),
      kind: 'TRADE_CANCEL',
      cancelScope: reading.cancelScope,
      ...(r.referencedProviderEventId !== undefined
        ? { referencedProviderEventId: r.referencedProviderEventId } : {}),
      ...(r.price !== undefined ? { price: r.price } : {}),
      ...(r.size !== undefined ? { size: r.size } : {}),
      rawMessageType,
      rawConditions,
      uninterpretedCodes: reading.uninterpretedCodes,
      semanticsStatus: reading.semanticsStatus,
    };
    return { ...draft, eventId: eventIdOf(draft as EventDraft) };
  }

  if (r.price === undefined) throw new MalformedRecordError('a trade report carries no price');
  if (!(r.size !== undefined && r.size > 0)) throw new MalformedRecordError(`a trade report of size ${String(r.size)} reports nothing`);
  const draft: Omit<TradeReportEvent, 'eventId'> = {
    ...commonOf(r, codes, semantics),
    kind: 'TRADE_REPORT',
    price: r.price,
    size: r.size,
    rawMessageType,
    rawConditions,
    reportLifecycle: reading.lifecycle,
    iso: reading.iso,
    complex: reading.complex,
    uninterpretedCodes: reading.uninterpretedCodes,
    semanticsStatus: reading.semanticsStatus,
  };
  return { ...draft, eventId: eventIdOf(draft as EventDraft) };
}

export function buildQuoteEvent(r: RawQuoteRecord, semantics: ProviderSemantics = OPRA_SEMANTICS): QuoteEvent {
  checkCommon(r);
  nonNegative(r.bid ?? undefined, 'bid');
  nonNegative(r.ask ?? undefined, 'ask');
  nonNegative(r.bidSize ?? undefined, 'bid size');
  nonNegative(r.askSize ?? undefined, 'ask size');
  // `null` is the only spelling of "not sent". A record parsed from JSON with
  // the key simply absent arrives as `undefined`, which the type forbids and the
  // runtime does not — and `bookStateOf` would then read a missing bid as a
  // price (`undefined > ask` is false, so a one-sided book came out TWO_SIDED,
  // and a record with neither side came out LOCKED).
  const draft: Omit<QuoteEvent, 'eventId'> = {
    ...commonOf(r, [], semantics),
    kind: 'QUOTE',
    bid: r.bid ?? null,
    ask: r.ask ?? null,
    bidSize: r.bidSize ?? null,
    askSize: r.askSize ?? null,
  };
  return { ...draft, eventId: eventIdOf(draft as EventDraft) };
}
