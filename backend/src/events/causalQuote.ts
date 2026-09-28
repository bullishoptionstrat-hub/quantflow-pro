/**
 * The quote a trade may be classified against: the book as it stood BEFORE
 * the trade, as it could have been known WHEN the trade was.
 *
 * Two conditions, and both are strict:
 *
 *   1. `quote.eventTime < trade.eventTime`. Not `<=`. A quote stamped at the
 *      trade's own instant may already reflect the trade — a lifted offer
 *      leaves a new offer at the same timestamp — and reading a print's
 *      direction off a book it moved is the look-ahead `nbbo.ts` refuses for
 *      a quote stamped after. Equality is admitted only when a provider proves
 *      its ordering semantics, and none has been proven here.
 *   2. `quote.availableAt <= trade.availableAt`. A quote stamped before the
 *      trade that ARRIVED after it was not in the live system's book. Using it
 *      gives a backtest a cleaner NBBO than live would have had.
 *
 * Among the quotes that pass, the latest is THE book — and if that book is
 * one-sided, locked or crossed, that is what the book was. Skipping back to an
 * older, prettier quote would be choosing evidence to suit the classifier.
 *
 * This selects a quote. It does not infer a side: the engine's `inferSide`
 * does that, with the same staleness constant imported below, so there is one
 * rule for "too old" and one classifier.
 */
import type { QuoteEvent, TradeReportEvent } from './types';
import { DEFAULT_CONFIG } from '../flow-engine/types';

export type BookState = 'TWO_SIDED' | 'ONE_SIDED' | 'EMPTY' | 'LOCKED' | 'CROSSED';

export type CausalQuote =
  | {
      status: 'FOUND';
      quote: QuoteEvent;
      ageMs: number;
      book: BookState;
      /**
       * A quote stamped between this one and the trade exists, but arrived
       * after the trade. The live answer (this quote) and the final answer
       * (that one) differ — the quote-side analogue of AS_KNOWN vs FINAL.
       */
      finalAnswerDiffers: boolean;
    }
  | { status: 'STALE'; quote: QuoteEvent; ageMs: number; maxAgeMs: number }
  | {
      status: 'NONE_PRIOR';
      /** Quotes stamped at the trade's own instant, excluded by rule 1. */
      simultaneousExcluded: number;
      /** Quotes stamped before the trade that arrived after it, excluded by rule 2. */
      arrivedLaterExcluded: number;
    }
  /** Several different books share the latest pre-trade instant. */
  | { status: 'AMBIGUOUS_SIMULTANEOUS_QUOTES'; quotes: QuoteEvent[] };

export function bookStateOf(q: QuoteEvent): BookState {
  if (q.bid === null && q.ask === null) return 'EMPTY';
  if (q.bid === null || q.ask === null) return 'ONE_SIDED';
  if (q.bid === q.ask) return 'LOCKED';
  if (q.bid > q.ask) return 'CROSSED';
  return 'TWO_SIDED';
}

const sameContract = (q: QuoteEvent, t: TradeReportEvent) =>
  q.instrument.underlying === t.instrument.underlying &&
  q.instrument.expiry === t.instrument.expiry &&
  q.instrument.strike === t.instrument.strike &&
  q.instrument.right === t.instrument.right;

export function causalQuoteFor(
  trade: TradeReportEvent,
  quotes: readonly QuoteEvent[],
  maxAgeMs: number = DEFAULT_CONFIG.nbboMaxAgeMs,
): CausalQuote {
  // One clock domain: comparing one provider's quote stamp against another's
  // trade stamp measures their clock offset as much as the market.
  const mine = quotes.filter((q) => q.provider === trade.provider && sameContract(q, trade));
  const prior = mine.filter((q) => q.eventTime < trade.eventTime);
  const eligible = prior.filter((q) => q.availableAt <= trade.availableAt);

  if (eligible.length === 0) {
    return {
      status: 'NONE_PRIOR',
      simultaneousExcluded: mine.filter((q) => q.eventTime === trade.eventTime).length,
      arrivedLaterExcluded: prior.length,
    };
  }

  const latestTime = Math.max(...eligible.map((q) => q.eventTime));
  const atLatest = eligible.filter((q) => q.eventTime === latestTime);
  const distinct = new Map(atLatest.map((q) => [`${q.bid}|${q.ask}|${q.bidSize}|${q.askSize}`, q]));
  if (distinct.size > 1) {
    return { status: 'AMBIGUOUS_SIMULTANEOUS_QUOTES', quotes: [...distinct.values()] };
  }
  const quote = atLatest[0]!;
  const ageMs = trade.eventTime - quote.eventTime;
  if (ageMs > maxAgeMs) return { status: 'STALE', quote, ageMs, maxAgeMs };

  const finalAnswerDiffers = prior.some((q) =>
    q.availableAt > trade.availableAt && q.eventTime > quote.eventTime);
  return { status: 'FOUND', quote, ageMs, book: bookStateOf(quote), finalAnswerDiffers };
}
