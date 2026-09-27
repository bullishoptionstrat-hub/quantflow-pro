/**
 * Which V2 events the real-time detector sees, and how they reach it.
 *
 * Research/production parity (directive §22) means a backtest receives exactly
 * what live would have: no cleaner. So V2 events do not get a private path to
 * the engine. They cross into it through `ingestPrint` — the seam every live
 * connector uses — and this module only decides two things:
 *
 *   ADMISSION  which events a real-time detector could have seen as ordinary
 *              trades at the moment they happened, and
 *   TRANSLATION what the seam receives: the trade, its causal quote (strictly
 *              before, known by the trade's availableAt), and the availableAt
 *              itself as the receipt clock.
 *
 * Everything the engine does not consume stays in the log rather than being
 * discarded on the way: conditions, corrections, session evidence and
 * sequence are all still on the V2 event the signal's `print_ids` point back
 * to, and they are applied where they belong — cancels by `signalRevision`,
 * session by `researchEligibility`, sequence by the reorder buffer.
 *
 * The admission rule is frozen here and named in docs/OPRA_EVENT_SEMANTICS.md's
 * "included in real-time detector?" column:
 *
 *   REGULAR report, not complex         admitted
 *   ISO report                          admitted, with iso carried
 *   LATE / OSEQ / OPNL / OPEN report    refused — reported outside its real-time
 *                                       slot; on the final tape, and a revision
 *                                       input for any signal it could have joined
 *   complex-order leg                   refused — not a standalone directional print
 *   uninterpreted code                  refused — could mean anything
 *   cancel                              refused — it revises signals, it is not one
 *   quote                               refused — book state, read by causalQuoteFor
 *   LATE_EVENT emission                 refused — never slipped into a finalised cluster
 */
import type { Emission } from './reorder';
import type { TradeReportEvent } from './types';
import type { CausalQuote } from './causalQuote';
import type { RawPrint } from '../ingestion/flowEngineAdapter';

export type Admission = { admit: true; event: TradeReportEvent } | { admit: false; reason: string };

export function detectorAdmission(em: Emission): Admission {
  if (em.kind === 'LATE_EVENT') {
    return { admit: false, reason: 'arrived behind the released watermark; a revision input, never inserted into a finalised cluster' };
  }
  const e = em.event;
  if (e.kind === 'QUOTE') return { admit: false, reason: 'a quote is book state, read through causalQuoteFor' };
  if (e.kind === 'TRADE_CANCEL') return { admit: false, reason: 'a cancel revises signals; it is not a trade' };
  if (e.reportLifecycle === 'UNKNOWN') {
    return { admit: false, reason: `uninterpreted code(s) ${e.uninterpretedCodes.join(', ') || '(conflicting lifecycle codes)'}` };
  }
  if (e.reportLifecycle !== 'REGULAR') {
    return { admit: false, reason: `${e.reportLifecycle}: reported outside its real-time slot` };
  }
  if (e.complex !== false) {
    return { admit: false, reason: e.complex === true ? 'a leg of a complex order is not a standalone directional print' : 'whether this is a complex-order leg is not established' };
  }
  return { admit: true, event: e };
}

/**
 * The seam's input for an admitted trade. The quote is attached only when it
 * is a causal, fresh, two-sided book; anything else attaches nothing, and the
 * engine's contract turns a missing quote into AMBIGUOUS with its penalty.
 */
export function toRawPrint(e: TradeReportEvent, q: CausalQuote): RawPrint {
  const book = q.status === 'FOUND' && q.book === 'TWO_SIDED' ? q.quote : null;
  return {
    id: e.eventId,
    ts: e.eventTime,
    receivedAt: e.availableAt,
    symbol: e.instrument.underlying,
    expiry: e.instrument.expiry,
    strike: e.instrument.strike,
    right: e.instrument.right,
    price: e.price,
    size: e.size,
    ...(e.venue !== undefined ? { exchange: e.venue } : {}),
    ...(book !== null && book.bid !== null && book.ask !== null
      ? { bid: book.bid, ask: book.ask, quoteTs: book.eventTime }
      : {}),
    ...(e.iso === true ? { iso: true } : {}),
    source: e.provider,
    synthetic: e.synthetic,
    replay: e.replay,
  };
}
