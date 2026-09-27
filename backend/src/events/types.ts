/**
 * Market Event V2 — the envelope every real options event enters through.
 *
 * `RawPrint` (ingestion/flowEngineAdapter.ts) and the engine's
 * `OptionTradeEvent` can describe a trade. Neither can describe what happened
 * to it afterwards: a trade later cancelled, a trade reported late or out of
 * sequence, which trading session it belonged to, or — the one research
 * depends on — the earliest instant anyone could have known it. `RawPrint` even
 * documents the assumption that makes those unrepresentable: "Prints must
 * arrive roughly ascending." That is not an enforceable invariant, and a
 * research corpus ingested through it would be permanently unable to answer
 * "what did the live system believe at 10:31:07, before the cancel arrived?"
 *
 * Three rules shape this file:
 *
 *   1. **A cancel is its own event, never an edit.** `TRADE_CANCEL` references a
 *      trade; nothing ever mutates or deletes the trade it cancels. Both the
 *      tape as known at a moment and the finally-corrected tape are DERIVED
 *      (eventLog.ts), so neither can overwrite the other.
 *   2. **Time is three clocks plus a rule.** When it happened (`eventTime`),
 *      when a provider saw it, when QuantFlow saw it — and `availableAt`, the
 *      earliest instant it was knowable, with the basis that produced it.
 *   3. **Provider evidence is kept raw beside its interpretation.** Every
 *      normalised field that came from a code keeps the code, so a better
 *      reading of the specification can reinterpret history without re-import.
 */
import type { CancelScope, ReportLifecycle, SourceStatus } from './semantics';

export const MARKET_EVENT_SCHEMA = 'market-event-v2' as const;

/** A listed option, identified independently of any provider's symbology. */
export interface InstrumentRef {
  underlying: string;
  /** ISO calendar date, market-local. */
  expiry: string;
  strike: number;
  right: 'C' | 'P';
}

/**
 * What the provider said about the trading session, kept raw beside the
 * normalised reading. See `session.ts` for the rules that produce it.
 */
export interface SessionEvidence {
  /** The provider's own session field, exactly as delivered. */
  rawSessionIdentifier: string | number | null;
  /** Sale-condition codes as delivered, for the legacy encoding path. */
  rawSaleConditions: string[];
  normalized: 'REGULAR' | 'EXTENDED' | 'UNKNOWN' | 'CONFLICT';
  basis:
    | 'PROVIDER_SESSION_IDENTIFIER'
    | 'LEGACY_SALE_CONDITION'
    | 'BOTH_AGREE'
    | 'BOTH_DISAGREE'
    | 'NONE';
  /** Standing of the encoding rules used to read the raw fields. */
  semanticsStatus: SourceStatus;
}

/**
 * How `availableAt` was established, weakest last.
 *
 * `EVENT_TIME_LOWER_BOUND` credits zero latency. It is what a dataset without
 * any receive clock can offer, and it flatters every measurement taken from it
 * — the same standing as `decisionBasis: 'EVENT_TIME_ONLY'` in persistence,
 * which is excluded from published rates rather than pooled with observed ones.
 */
export type AvailabilityBasis =
  | 'QUANTFLOW_RECEIPT'
  | 'PROVIDER_RECEIPT'
  | 'EVENT_TIME_LOWER_BOUND';

interface EventBase {
  schemaVersion: typeof MARKET_EVENT_SCHEMA;
  /**
   * Stable identity: the same raw record re-imported yields the same id, so a
   * re-import is idempotent and a changed record under a reused id is a
   * conflict rather than a silent rewrite. Built by `eventIdOf` (eventId.ts).
   */
  eventId: string;
  provider: string;
  datasetId: string;
  providerEventId?: string;
  /**
   * The provider's sequence number, as a string: OPRA-scale sequences exceed
   * 2^53 over a session, and a sequence rounded by a float is a sequence gap
   * that never happened.
   */
  providerSequence?: string;
  /**
   * The stream instance a sequence number is ordered within — a feed line AND
   * its reset period. OPRA-style sequences restart, so a scope without the
   * period in it lets two different events share an identity; the log refuses
   * that loudly (DUPLICATE_CONFLICT) rather than letting one overwrite the other.
   */
  sequenceScope?: string;

  /** When it happened at the venue/participant, epoch ms. */
  eventTime: number;
  providerReceiveTime?: number;
  quantflowReceiveTime?: number;
  /**
   * The earliest instant this event was knowable. Never earlier than
   * `eventTime`: when a receipt clock reads before the event clock (skew),
   * `availableAt` takes the later of the two and `clockInversion` records that
   * it had to — the `decisionAt = max(...)` rule, for the same reason: the
   * conservative answer admits no lookahead.
   */
  availableAt: number;
  availableAtBasis: AvailabilityBasis;
  clockInversion: boolean;

  instrument: InstrumentRef;
  venue?: string;
  sessionEvidence: SessionEvidence;
  /** Pointer back to the raw record, so the interpretation can be redone. */
  rawRecordRef?: string;

  synthetic: boolean;
  replay: boolean;
}

export interface TradeReportEvent extends EventBase {
  kind: 'TRADE_REPORT';
  price: number;
  size: number;
  /** The message-type / condition code as delivered, or null for none. */
  rawMessageType: string | null;
  rawConditions: string[];
  reportLifecycle: ReportLifecycle;
  /** Intermarket sweep, if the code said so; null when no code spoke to it. */
  iso: boolean | null;
  /** A leg of a complex order — not a standalone directional print. */
  complex: boolean | null;
  /** Codes present that `semantics.ts` does not interpret. */
  uninterpretedCodes: string[];
  semanticsStatus: SourceStatus;
}

export interface TradeCancelEvent extends EventBase {
  kind: 'TRADE_CANCEL';
  cancelScope: CancelScope | 'UNKNOWN';
  /**
   * Set when the provider names the cancelled trade — by ITS id for that trade,
   * as delivered. The log resolves it against `providerEventId` within the same
   * provider and dataset; it is raw evidence, not one of our event ids.
   */
  referencedProviderEventId?: string;
  /**
   * OPRA-style cancels restate the cancelled trade's price and size rather than
   * naming it. They are used to MATCH, never to guess: see eventLog.ts.
   */
  price?: number;
  size?: number;
  rawMessageType: string | null;
  rawConditions: string[];
  uninterpretedCodes: string[];
  semanticsStatus: SourceStatus;
}

export interface QuoteEvent extends EventBase {
  kind: 'QUOTE';
  /** null when the side is absent. A missing bid is not a zero bid. */
  bid: number | null;
  ask: number | null;
  bidSize: number | null;
  askSize: number | null;
}

export type MarketEvent = TradeReportEvent | TradeCancelEvent | QuoteEvent;
