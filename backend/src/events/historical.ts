/**
 * The provider-neutral contract a historical options source implements.
 *
 * Nothing in this directory may import a vendor's types — not Databento's,
 * not ThetaData's. An adapter owns its vendor's shapes, translates field names
 * and units, and hands over Market Event V2 through `build.ts`; the domain
 * never learns which vendor a record came from except by the `provider` and
 * `datasetId` it carries. That is what keeps the provider decision the
 * operator's to make (directive §14) instead of one the architecture has
 * already made.
 *
 * Two properties of the contract are deliberate:
 *
 *   - A source yields REJECTIONS as well as events. An adapter that silently
 *     skips a record it could not build makes the import's counts impossible
 *     to reconcile with what the vendor sent, and "the counts reconcile" is
 *     one of the §17 gate checks. So a record that fails `build.ts` comes back
 *     as `{ ok: false, reason }`, counted, never dropped.
 *
 *   - Capabilities are declared per field, and the declaration carries its
 *     own standing. A vendor page saying a field exists is
 *     DOCUMENTED_CAPABILITY_ONLY until a sample has been pulled and checked —
 *     the directive's term, and the same distinction as `credentialed` versus
 *     `entitled` in the collection doctor.
 */
import type { InstrumentRef, QuoteEvent, TradeCancelEvent, TradeReportEvent } from './types';

/** How a capability claim stands. */
export type CapabilityStatus =
  /** The field is present, as the research requirement needs it. */
  | 'AVAILABLE'
  /** Not delivered, but computable from what is delivered — with the derivation stated. */
  | 'DERIVED'
  | 'MISSING'
  /** Delivered, with semantics that do not settle the research question. */
  | 'AMBIGUOUS';

export interface CapabilityClaim {
  status: CapabilityStatus;
  /**
   * DOCUMENTED_CAPABILITY_ONLY until a sample has been inspected; then
   * SAMPLE_VERIFIED with the sample it was verified on.
   */
  evidence: 'DOCUMENTED_CAPABILITY_ONLY' | 'SAMPLE_VERIFIED' | 'NOT_ESTABLISHED';
  note: string;
}

export interface SourceCapabilities {
  provider: string;
  datasetId: string;
  trades: CapabilityClaim;
  quotes: CapabilityClaim;
  /** A trade delivered with the book as it stood before it. */
  tradeQuotes: CapabilityClaim;
  /** Whether that book is strictly before the trade (H-001-v2 §H). */
  quoteStrictlyBeforeTrade: CapabilityClaim;
  instrumentDefinitions: CapabilityClaim;
  eventTime: CapabilityClaim;
  providerReceiveTime: CapabilityClaim;
  sequence: CapabilityClaim;
  saleConditions: CapabilityClaim;
  sessionIdentifier: CapabilityClaim;
  cancels: CapabilityClaim;
  venue: CapabilityClaim;
}

export interface HistoricalRequest {
  underlying: string;
  /** Inclusive market-local dates. */
  from: string;
  to: string;
  /** Narrow to specific contracts; omitted means every contract on the underlying. */
  contracts?: InstrumentRef[];
}

export type SourceItem<E> =
  | { ok: true; event: E }
  /** A record the adapter could not build, with the reason and where it was. */
  | { ok: false; reason: string; rawRecordRef?: string };

/** A trade delivered with the provider's pre-trade book. */
export interface TradeQuoteEvidence {
  trade: TradeReportEvent | TradeCancelEvent;
  quote: QuoteEvent | null;
  /**
   * What the provider guarantees about the pairing — read from its
   * documentation, never assumed. `AT_OR_BEFORE` admits the post-trade book at
   * an equal timestamp, which H-001-v2 refuses.
   */
  quoteRelation: 'STRICTLY_BEFORE' | 'AT_OR_BEFORE' | 'UNKNOWN';
}

export interface InstrumentDefinition {
  instrument: InstrumentRef;
  providerInstrumentId: string;
  rawSymbol: string;
  /** When the definition was in force, epoch ms. */
  definedAt: number;
}

export interface HistoricalOptionsSource {
  capabilities(): SourceCapabilities;
  trades(request: HistoricalRequest): AsyncIterable<SourceItem<TradeReportEvent | TradeCancelEvent>>;
  tradeQuotes?(request: HistoricalRequest): AsyncIterable<SourceItem<TradeQuoteEvidence>>;
  quotes?(request: HistoricalRequest): AsyncIterable<SourceItem<QuoteEvent>>;
  instrumentDefinitions?(request: HistoricalRequest): AsyncIterable<SourceItem<InstrumentDefinition>>;
  /**
   * The number of TRADE records (reports and cancels) the provider itself
   * reported for the request, when it reports one — the trade stream's count,
   * not a total across quotes or pairs, which are separate requests. The gate
   * reconciles the trade stream against it; a source that cannot say returns
   * null.
   */
  providerReportedCount?(request: HistoricalRequest): Promise<number | null>;
}
