/**
 * H-001-v2 §C, as code: the two SPY prices a return is measured between.
 *
 *   r       = 10,000 × ln(M(t_exit) / M(t_entry)), in basis points
 *   t_entry = anchor + 1 s            (the frozen latency allowance)
 *   M(t_entry): the latest SPY quote with event time AND availableAt ≤ t_entry,
 *               refused if older than 2 s
 *   t_exit  = t_entry + 15 min
 *   M(t_exit):  the latest SPY quote with event time ≤ t_exit
 *
 * The anchor is the signal's `decisionAt`, or a control's own availableAt
 * (§G: "measured the same way from each control's own availableAt"), so one
 * function measures both and they cannot drift into two rules.
 *
 * This is where look-ahead enters a study if it enters at all, so the rules are
 * applied literally and nothing is chosen to make a mark exist:
 *
 *   - The entry quote must be KNOWN by t_entry, not only stamped before it.
 *     A quote stamped 10:00:00.900 that arrived at 10:00:01.400 was not in any
 *     live book at 10:00:01.000, and using it hands the study a fresher price
 *     than a trader had.
 *   - The exit is measured on the final tape — event time only — because by
 *     the time anyone computes r the exit window is long past. That asymmetry
 *     is §C's, and it is deliberate.
 *   - The latest qualifying quote IS the book. If it is one-sided or crossed,
 *     there is no midpoint and the mark is refused; skipping back to an older,
 *     cleaner quote would be choosing evidence, the same refusal
 *     `events/causalQuote.ts` makes. A locked book (bid = ask) has a midpoint
 *     and is kept.
 *   - Several quotes sharing the latest event time with different midpoints is
 *     AMBIGUOUS, never "the last one in the list".
 *
 * **One gap is reported, not closed.** §C bounds the entry quote's age at 2 s
 * and states no bound for the exit. A feed that went quiet would let a
 * 40-minute-old quote stand in for M(t_exit), and the frozen text does not say
 * to refuse it. Inventing a bound here would be changing a preregistered rule
 * in code, so the exit's age is returned on every measurement instead
 * (`exitAgeMs`) and the decision is left to whoever can amend the hypothesis.
 *
 * **A day's quotes are indexed once, and the index is held to the scan.**
 * `markAt` over a plain array filters every quote on every call, and a study
 * calls it per signal, per meta-event, per control, per clock draw and 31 times
 * per balance window — on a feed of hundreds of thousands of SPY updates a day.
 * `quoteBook` sorts a copy by event time once and answers each mark by binary
 * search. It is not a second rule: the array path is kept as the reference, a
 * test holds the two to identical answers over randomised books (ties, late
 * arrivals, one-sided quotes), and either may be passed wherever a mark is taken.
 */

/** §C: t_entry = decisionAt + 1 s. */
export const H001_ENTRY_LATENCY_MS = 1_000;
/** §C: the entry quote is refused if older than 2 s. */
export const H001_ENTRY_MAX_AGE_MS = 2_000;
/** §C and §K: M15 is the only primary endpoint. */
export const H001_HORIZON_MS = 15 * 60_000;

/** One NBBO update for the underlying. `null` is the only spelling of "not sent". */
export interface UnderlyingQuote {
  provider: string;
  eventTime: number;
  availableAt: number;
  bid: number | null;
  ask: number | null;
}

export type MarkRefusal =
  | 'NO_QUOTE'          // nothing qualifies by the instant
  | 'STALE'             // the latest qualifying entry quote is older than 2 s
  | 'NO_MIDPOINT'       // the latest qualifying quote is one-sided or crossed
  | 'AMBIGUOUS';        // several books share the latest instant and disagree

export type Mark =
  | { ok: true; at: number; quote: UnderlyingQuote; midpoint: number; ageMs: number }
  | { ok: false; at: number; refusal: MarkRefusal; why: string };

export type H001Return =
  | {
      status: 'OK';
      entry: Extract<Mark, { ok: true }>;
      exit: Extract<Mark, { ok: true }>;
      returnBp: number;
      /** How old M(t_exit) was at t_exit. §C sets no bound; see the module note. */
      exitAgeMs: number;
    }
  | { status: 'NO_ENTRY_MARK'; entry: Extract<Mark, { ok: false }> }
  | { status: 'NO_EXIT_MARK'; entry: Extract<Mark, { ok: true }>; exit: Extract<Mark, { ok: false }> };

/**
 * A day's quotes, indexed for repeated marks. Built once by `quoteBook`; the
 * input array is copied, so a caller mutating it afterwards cannot desync the
 * index from what it was built over.
 */
export class QuoteBook {
  /** Quotes with a readable event time, stably sorted by it (ties keep input order). */
  private readonly byEvent: readonly UnderlyingQuote[];
  /** How many distinct providers the input carried — §C's one-feed rule reads it. */
  readonly providerCount: number;

  constructor(quotes: readonly UnderlyingQuote[]) {
    this.providerCount = new Set(quotes.map((q) => q.provider)).size;
    // A NaN event time is never at-or-before any instant, so the scan never
    // selects it; dropping it here keeps the sort's comparator total.
    this.byEvent = quotes.filter((q) => !Number.isNaN(q.eventTime))
      .map((q, i) => ({ q, i }))
      .sort((a, b) => a.q.eventTime - b.q.eventTime || a.i - b.i)
      .map((x) => x.q);
  }

  /** The number of quotes stamped at or before `at`. */
  private countThrough(at: number): number {
    let lo = 0;
    let hi = this.byEvent.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.byEvent[mid]!.eventTime <= at) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  /** The quotes the scan would call eligible at the latest qualifying instant, in input order. */
  latestEligible(at: number, requireAvailableBy: boolean): UnderlyingQuote[] {
    const e = this.byEvent;
    let i = this.countThrough(at) - 1;
    if (requireAvailableBy) while (i >= 0 && !(e[i]!.availableAt <= at)) i--;
    if (i < 0) return [];
    const latest = e[i]!.eventTime;
    let start = i;
    while (start > 0 && e[start - 1]!.eventTime === latest) start--;
    const out: UnderlyingQuote[] = [];
    for (let k = start; k < e.length && e[k]!.eventTime === latest; k++) {
      if (!requireAvailableBy || e[k]!.availableAt <= at) out.push(e[k]!);
    }
    return out;
  }
}

/** Index a day's quotes once, for a study that takes many marks against them. */
export function quoteBook(quotes: readonly UnderlyingQuote[]): QuoteBook {
  return new QuoteBook(quotes);
}

/** Where a mark can be read from: the plain array (the reference scan) or its index. */
export type QuoteSource = readonly UnderlyingQuote[] | QuoteBook;

function midpointOf(q: UnderlyingQuote): number | null {
  if (q.bid === null || q.ask === null) return null;
  if (!(Number.isFinite(q.bid) && Number.isFinite(q.ask)) || q.bid <= 0 || q.ask <= 0) return null;
  if (q.bid > q.ask) return null;
  return (q.bid + q.ask) / 2;
}

/**
 * The mark at instant `at`: the latest quote stamped at or before it, optionally
 * also known by it, optionally no older than a bound.
 */
export function markAt(
  quotes: QuoteSource,
  at: number,
  rule: { requireAvailableBy: boolean; maxAgeMs: number | null },
): Mark {
  let atLatest: UnderlyingQuote[];
  if (quotes instanceof QuoteBook) {
    atLatest = quotes.latestEligible(at, rule.requireAvailableBy);
  } else {
    const eligible = quotes.filter((q) =>
      q.eventTime <= at && (!rule.requireAvailableBy || q.availableAt <= at));
    atLatest = [];
    if (eligible.length > 0) {
      let latest = eligible[0]!.eventTime;
      for (const q of eligible) if (q.eventTime > latest) latest = q.eventTime;
      atLatest = eligible.filter((q) => q.eventTime === latest);
    }
  }
  if (atLatest.length === 0) {
    return { ok: false, at, refusal: 'NO_QUOTE', why: rule.requireAvailableBy
      ? 'no quote was both stamped and known by the instant'
      : 'no quote was stamped by the instant' };
  }
  const latest = atLatest[0]!.eventTime;
  const ageMs = at - latest;
  if (rule.maxAgeMs !== null && ageMs > rule.maxAgeMs) {
    return { ok: false, at, refusal: 'STALE', why: `the latest qualifying quote is ${ageMs} ms old; the bound is ${rule.maxAgeMs} ms` };
  }
  const mids = atLatest.map(midpointOf);
  if (mids.some((m) => m === null)) {
    return { ok: false, at, refusal: 'NO_MIDPOINT', why: 'the latest qualifying book is one-sided, crossed or unpriced' };
  }
  if (new Set(mids).size > 1) {
    return { ok: false, at, refusal: 'AMBIGUOUS', why: `${atLatest.length} books share the latest instant and disagree` };
  }
  return { ok: true, at, quote: atLatest[0]!, midpoint: mids[0]!, ageMs };
}

/**
 * The §C return measured from `anchor` (a signal's decisionAt, or a control's
 * own availableAt). Quotes must come from one provider: entry and exit read
 * against two clocks would measure their offset as much as the market.
 */
export function h001Return(anchor: number, quotes: QuoteSource): H001Return {
  if (!Number.isFinite(anchor)) throw new RangeError('the anchor must be an instant');
  const providers = quotes instanceof QuoteBook ? quotes.providerCount : new Set(quotes.map((q) => q.provider)).size;
  if (providers > 1) {
    throw new RangeError(`quotes from ${providers} providers; §C measures both marks on one feed`);
  }
  const tEntry = anchor + H001_ENTRY_LATENCY_MS;
  const entry = markAt(quotes, tEntry, { requireAvailableBy: true, maxAgeMs: H001_ENTRY_MAX_AGE_MS });
  if (!entry.ok) return { status: 'NO_ENTRY_MARK', entry };
  const tExit = tEntry + H001_HORIZON_MS;
  const exit = markAt(quotes, tExit, { requireAvailableBy: false, maxAgeMs: null });
  if (!exit.ok) return { status: 'NO_EXIT_MARK', entry, exit };
  return {
    status: 'OK', entry, exit,
    returnBp: 10_000 * Math.log(exit.midpoint / entry.midpoint),
    exitAgeMs: exit.ageMs,
  };
}
