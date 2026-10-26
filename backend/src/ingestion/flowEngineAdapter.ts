/**
 * QuantFlow Pro — Flow Engine adapter
 *
 * Bridges the connector layer to `src/flow-engine` (vendored from
 * quantflow-modules/flow-engine). Replaces the legacy
 * `heatScore.computeHeatScore` + `sweepDetector.classifySweep` pair as the
 * classification/scoring path.
 *
 * Every source funnels through `ingestPrint()`, which:
 *   1. builds the OCC contract symbol,
 *   2. publishes the NBBO for that contract *before* the trade (without this
 *      the engine returns AMBIGUOUS for every side and applies a -15 penalty),
 *   3. records per-contract stats for the scorer (OI / day volume / spot),
 *   4. feeds the trade and maps any finalized signals onto the wire shape.
 *
 * Honesty contracts inherited from the engine are preserved on the wire:
 * `side` may be AMBIGUOUS, `synthetic` marks simulated/replayed sources, and
 * `print_ids` carries the audit trail back to the originating prints.
 */
import { FlowEngine } from '../flow-engine/engine';
import { sideBucket } from '../flow-engine/nbbo';
import {
  daysToExpiry as engineDaysToExpiry, expiryInstantMs,
} from '../flow-engine/expiry';
import type {
  ClassifiedSignal,
  ContractStats,
  FlowEngineConfig,
  InferredSide,
  OptionTradeEvent,
} from '../flow-engine/types';
import { DEFAULT_CONFIG } from '../flow-engine/types';
import { classifySource, type RightsClass } from '../provenance/rights';

// ─── Input ──────────────────────────────────────────────────────────────────

/** Provider-agnostic print. Every connector normalizes to this. */
export interface RawPrint {
  id?: string;
  /**
   * Epoch ms. Defaults to now.
   *
   * This said "Prints must arrive roughly ascending", which was an assumption
   * written as a contract: nothing enforced it and no feed guarantees it.
   * Historical and fixture events now reach this seam through
   * `events/reorder.ts`, which releases them in a stated order and reports
   * anything later than its bound as a LATE_EVENT instead of inserting it.
   * The LIVE path has no reorder buffer yet, and says so: its only sources
   * today are the simulation and chain snapshots, which emit in order, and
   * the first live OPRA source is exactly what would need one (§29).
   */
  ts?: number;
  /**
   * When the print became knowable, carried from an upstream record that
   * measured it — a Market Event V2's `availableAt`. When absent the adapter
   * stamps its own wall clock, or nothing for replay.
   *
   * A historical record with a provider receipt is not "replay with no
   * clock": dropping that receipt here would hand its signals a decision
   * basis of EVENT_TIME_ONLY for data that has a better one, which is the
   * historical shortcut §22 forbids.
   */
  receivedAt?: number;
  symbol: string;                 // underlying, e.g. "SPY"
  /**
   * The option root, when the source names it — `SPXW` under the underlying
   * `SPX`. The contract's identity (its OCC symbol, the key for the NBBO book
   * and the stats table) is built from it; absent, the root is taken to be the
   * underlying, which is true for every equity and ETF on the watch lists and
   * false for SPX weeklies. Building identity from the underlying alone merged
   * an AM-settled SPX monthly with the PM-settled SPXW weekly sharing its date
   * and strike — two contracts, one book.
   */
  root?: string;
  expiry: string;                 // ISO date, "2026-06-19"
  strike: number;
  right: 'C' | 'P';
  price: number;                  // per-contract premium
  size: number;                   // contracts
  /** Single venue, or several when the source reports a multi-venue fill. */
  exchange?: string;
  exchanges?: string[];
  bid?: number;
  ask?: number;
  /**
   * When the NBBO above was quoted, epoch ms. Defaults to the print's own `ts`.
   *
   * Every source that carries a quote *with* the trade leaves this unset, and
   * for those the quote and the trade are genuinely simultaneous. A source that
   * fetches the NBBO separately must set it, because stamping a five-second-old
   * quote with the trade's timestamp manufactures a freshness it does not have
   * — and the engine's 2s staleness rule, the thing that decides whether a side
   * can be inferred at all, would be deciding on a fabricated age.
   */
  quoteTs?: number;
  /**
   * Set when `price` is a trade whose *time* the source does not report.
   *
   * A chain-snapshot connector builds a print out of three things that did not
   * happen together: `last` is a trade at some unknown moment in the session,
   * `size` is the whole day's cumulative volume, and `bid`/`ask` are the NBBO
   * as of the poll. Leaving `quoteTs` to default to `ts` asserts the trade and
   * the quote were simultaneous, which is the one thing known to be false.
   *
   * The consequence is not cosmetic. `inferSide` compares the fill against the
   * NBBO and refuses to answer when the quote is more than `maxAgeMs` from the
   * trade — the rule `nbbo.ts` opens by calling the #1 way flow tools lie. A
   * gap asserted as zero can never exceed 2s, so the rule could not fire for
   * any of these sources, and a day's aggregate volume compared against a
   * closing quote came out as a confident BUY.
   *
   * Note what does *not* fix it: stamping the snapshot with its true as-of
   * time. Measured through this function, one print at spot 580 —
   *
   *     ts = now, quoteTs unset                  side=BUY
   *     ts and quoteTs both back 15 min          side=BUY
   *     ts and quoteTs both back 24 h            side=BUY
   *     quoteTs 15 min behind ts                 side=AMBIGUOUS
   *
   * — because the rule measures the *gap*, and shifting both stamps preserves
   * it at zero. A delay concept would have bought honest labelling and left
   * the inference exactly as wrong.
   *
   * So the print says the gap is unknown, and `ingestPrint` withholds the
   * NBBO: a missing quote is already AMBIGUOUS by contract. The cost is that
   * the book does not learn this contract's bid/ask, so a live tape print
   * arriving later for the same contract cannot use it — which is the right
   * cost, because a delayed chain's NBBO is not evidence about a live fill
   * either, and the staleness rule could not have caught that one either.
   */
  tradeTimeUnknown?: boolean;
  openInterest?: number;
  dayVolume?: number;
  avgDailyVolume?: number;
  underlyingPrice?: number;
  iv?: number;
  delta?: number;
  iso?: boolean;
  conditions?: number[];
  source: string;
  /** Simulated / replayed data — surfaces as `synthetic` on the wire. */
  synthetic?: boolean;
  /**
   * Set by connectors replaying history. Suppresses the wall-clock receipt
   * stamp, because "now" says nothing about when a 2024 print was knowable.
   * Signals formed from such prints get an EVENT_TIME_ONLY decision basis and
   * are kept out of the track record's rates.
   */
  replay?: boolean;
}

// ─── Output (matches frontend/lib/types.ts FlowEvent) ───────────────────────

export type OrderType = 'SWEEP' | 'BLOCK' | 'SPLIT' | 'MULTI_LEG' | 'LARGE';

export interface WireFlowEvent {
  id: string;
  underlying: string;
  expiry: string;
  strike: number;
  option_type: 'C' | 'P';
  order_type: OrderType;
  total_size: number;
  total_premium: number;
  heat_score: number;
  sentiment: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  /** `heat_score >= UNUSUAL_SCORE`. The threshold lives here and nowhere else. */
  is_unusual: boolean;
  /**
   * The threshold `is_unusual` was decided against — `UNUSUAL_SCORE` at the
   * moment this signal was classified.
   *
   * Published so a power alert can name the rule that raised it (ROADMAP
   * 5.3). The frontend used to state "75 or above" in its own copy, which
   * was the threshold's second home: correct only while nobody changed the
   * first. Carried per event rather than once on `/api/health` because a row
   * records what was true when *it* fired, and a deploy can move the line
   * between two alerts in one session.
   */
  unusual_threshold: number;
  exchange_count: number;
  /**
   * Every venue the contributing records named, and whether the size at each
   * was separately observed.
   *
   * `exchange_count` counts venues on the engine's own trade events, which is
   * one per upstream record. When a source declares several venues on ONE
   * record it is saying the order touched them — not that it saw a fill at
   * each — so the allocation is `UNKNOWN` and `venue_evidence` is longer than
   * the observed count. The adapter used to resolve that by splitting the
   * record into one fabricated execution per venue, which manufactured the
   * exact venue diversity the SWEEP label is built on.
   */
  venue_evidence: string[];
  venue_allocation: VenueAllocation;
  avg_price: number;
  /**
   * Contract greeks and chain figures as the *source* reported them, or null.
   *
   * These were `?? 0`. A print arriving without a chain snapshot — every
   * Polygon trade whose NBBO lookup was budgeted out, for one — published
   * `iv: 0`, `delta: 0`, `open_interest: 0` and `spot_price: 0` on the wire.
   * Nothing in the terminal renders them today, which is exactly the
   * `MarketSnapshot` hazard: a field carrying a fabricated default, waiting
   * for its first consumer to bind to it and show a zero as a fact.
   */
  iv: number | null;
  delta: number | null;
  open_interest: number | null;
  days_to_expiry: number | null;
  /**
   * `UNKNOWN` where the underlying's price is not known.
   *
   * `moneynessOf` opened with `if (!(spot > 0)) return 'OTM'` — a
   * classification asserted from no data, on every signal whose contract had
   * no stats. Three states could not express "we do not know", so it picked
   * one and stated it with the same confidence as a computed answer.
   */
  moneyness: 'ITM' | 'ATM' | 'OTM' | 'UNKNOWN';
  /** The underlying's price when the signal formed, or null. Was `?? 0`. */
  spot_price: number | null;
  created_at: string;
  source: string;

  // `ml_score` was declared here and never populated. The service that would
  // have filled it is deleted; a scored signal carries `score_breakdown`, which
  // is the deterministic engine attribution and can be checked.

  // ── Engine-native fields (additive; older clients ignore them) ──
  /** Quote-rule inference. AMBIGUOUS when NBBO was missing or stale. */
  side: InferredSide;
  /** Per-component score contributions — the UI can show *why* it scored. */
  score_breakdown: Record<string, number>;
  /** Present on MULTI_LEG: the full structure. The event itself is the dominant leg. */
  legs?: Array<{
    underlying: string;
    expiry: string;
    strike: number;
    option_type: 'C' | 'P';
    side: InferredSide;
    total_size: number;
    total_premium: number;
    avg_price: number;
    prints: number;
    exchanges: string[];
  }>;
  spread_guess?: ClassifiedSignal['spreadGuess'];
  /** Audit trail: every print id that formed this signal. */
  print_ids: string[];
  /** True when the feeding source was simulated or replayed. */
  synthetic: boolean;
  /**
   * Every dataset that contributed a print, and the DISPLAY class in force.
   *
   * `SignalRecord` has carried `source` / `datasetId` / `rightsClass` since
   * the store existed; the wire carried none of them, so §22's taint
   * propagation held inside the database and stopped at the door — the CSV a
   * reader downloads knew less about its own provenance than the row nobody
   * exports. That is F-16.
   *
   * **Plural, because a cluster can span sources.** `originOf` already
   * establishes that and the recorder already refuses to ignore it: checking
   * only the first print's source would let one permitted print carry
   * unverified ones into the record.
   *
   * **`rights_display`, not `rights_class`.** This is the DISPLAY axis — what
   * governed these rows reaching a browser — and it is deliberately NOT the
   * PERSIST decision the recorder makes, which differs for the same dataset:
   * Finnhub is PERMITTED to display and PROHIBITED to persist. One field
   * answering two questions is the defect this repo has hit with `synthetic`,
   * with `connected`, and with `excursion`.
   *
   * The class published is the **weakest** across contributing datasets, the
   * same fail-closed rule the recorder applies when it refuses on any refused
   * source.
   */
  datasets: string[];
  rights_display: RightsClass | 'UNKNOWN_DATASET';
}

// ─── Contract symbol / stats bookkeeping ────────────────────────────────────

/** OCC-style symbol: root + yymmdd + C|P + strike×1000 padded to 8. */
export function occSymbol(
  underlying: string, expiry: string, right: 'C' | 'P', strike: number,
): string {
  const [y = '', m = '', d = ''] = expiry.split('-');
  const strikePart = String(Math.round(strike * 1000)).padStart(8, '0');
  return `${underlying}${y.slice(2)}${m}${d}${right}${strikePart}`;
}

const MAX_TRACKED_CONTRACTS = 5_000;

function recordStats(S: IngestorState, symbol: string, print: RawPrint): void {
  const { contractStats } = S;
  const prev = contractStats.get(symbol);
  if (!prev && contractStats.size >= MAX_TRACKED_CONTRACTS) {
    // Bounded: drop the oldest insertion rather than growing without limit.
    const oldest = contractStats.keys().next().value;
    if (oldest !== undefined) contractStats.delete(oldest);
  }
  contractStats.set(symbol, {
    openInterest: print.openInterest ?? prev?.openInterest,
    avgDailyVolume: print.avgDailyVolume ?? prev?.avgDailyVolume,
    // Day volume *before* this print — the engine adds the signal's own size.
    //
    // No `?? 0` on the end. `ContractStats.dayVolume` is optional and
    // `score.ts` already writes `(dayVol ?? 0) + input.totalSize`, so the zero
    // changed no score — it only made "this source reports no day volume"
    // indistinguishable from "nothing has traded today" for anything else that
    // reads these stats.
    dayVolume: print.dayVolume ?? prev?.dayVolume,
    underlyingPrice: print.underlyingPrice ?? prev?.underlyingPrice,
  });
}

/**
 * Whether the venues on a signal were each separately observed.
 *
 * `OBSERVED` — every venue came from its own upstream record, so the set is a
 * count of executions. `UNKNOWN` — at least one record declared several venues
 * at once, so the order touched them but how the size split across them was
 * never reported. The two must not be read as the same evidence: the second is
 * what a "sweep across 4 exchanges" claim is usually built from.
 */
export type VenueAllocation = 'OBSERVED' | 'UNKNOWN';

interface PrintOrigin {
  source: string;
  synthetic: boolean;
  iv?: number;
  delta?: number;
  /** Venues the source named on this one record. */
  declaredVenues: string[];
  venueAllocation: VenueAllocation;
}

const MAX_TRACKED_PRINTS = 20_000;

// ─── Signal observers ───────────────────────────────────────────────────────

/**
 * Called for every finalized signal, with the engine-native object and the
 * provenance resolved from its forming prints.
 *
 * The wire event is a lossy projection built for the UI — it drops the cluster
 * boundaries and receipt times that a durable record needs — so anything
 * recording history subscribes here rather than reading the wire shape.
 */
export interface SignalOrigin {
  /** The first-printing source. Used as the row's display provenance. */
  source: string;
  /**
   * Every distinct source that contributed a print to this signal — usually
   * one. A cluster can span sources, and when it does the rights decision must
   * consider all of them, not just whichever printed first.
   */
  sources: string[];
  /** True when ANY forming print was simulated. Pessimistic by design. */
  synthetic: boolean;
}

export type SignalObserver = (
  sig: ClassifiedSignal,
  origin: SignalOrigin,
) => void;

function notify(S: IngestorState, sigs: ClassifiedSignal[]): void {
  if (S.observers.length === 0) return;
  for (const sig of sigs) {
    const origin = originOf(S, sig);
    for (const fn of S.observers) {
      try {
        fn(sig, origin);
      } catch (err) {
        // An observer must never break the live feed. Recording is the thing
        // that can be lost here; the tape is not.
        console.error('[flowEngineAdapter] signal observer threw:', err);
      }
    }
  }
}

/**
 * Resolve a signal's provenance from the prints that formed it.
 *
 * Both aggregate fields are pessimistic on purpose. `synthetic` is OR-ed
 * across origins — a cluster mixing a simulated print with a real one is not
 * real. `sources` lists every contributor rather than just the first, because
 * a rights decision taken on the first print alone would let one permitted
 * print carry an entire cluster of unverified ones into the record.
 */
function originOf(S: IngestorState, sig: ClassifiedSignal): SignalOrigin {
  const resolved = sig.printIds.map((id) => S.printSource.get(id));
  const origins = resolved.filter(Boolean);
  const sources = [...new Set(origins.map((o) => o!.source))];

  // `printSource` is bounded and evicts its oldest quarter under load, so a
  // long-lived burst can outlive the origins of some of its prints. When that
  // happens the provenance is INCOMPLETE, and the dangerous case is subtle: if
  // the evicted print was the simulated one and a real print survives, the
  // signal would look real and attributable when it is neither.
  //
  // So an unresolved print id contributes 'unknown', which no dataset maps to
  // and which the rights gate therefore refuses. Losing a row is the correct
  // outcome; recording one whose origin we cannot vouch for is not.
  const complete = resolved.every(Boolean) && sources.length > 0;
  if (!complete) sources.push('unknown');

  return {
    source: sources[0] ?? 'unknown',
    sources,
    // Pessimistic on both axes: incomplete provenance cannot rule out that a
    // simulated print formed part of this cluster.
    synthetic: sig.synthetic || !complete || origins.some((o) => o?.synthetic === true),
  };
}

// ─── Ingest ─────────────────────────────────────────────────────────────────

/**
 * Prints refused at the seam for an expiry nothing could read, per source.
 *
 * Counted rather than silently dropped, and this is the half the strike-0 fix
 * left out: that refusal returns `[]` and tells nobody, so a connector whose
 * every row is rejected looks exactly like a quiet tape. `sourceNotes` is the
 * channel for "arriving and qualified", which is what this is.
 */
function noteUnreadableExpiry(S: IngestorState, source: string, expiry: string): void {
  const { unreadableExpiries, unreadableExpirySample } = S;
  const n = (unreadableExpiries[source] ?? 0) + 1;
  unreadableExpiries[source] = n;
  if (unreadableExpirySample[source] === undefined) {
    unreadableExpirySample[source] = expiry.slice(0, 32);
  }
  // First, then sparsely. A vendor using a different date format produces one
  // per print, and a log line per print is its own outage — `noteUnparsedFrame`
  // settled this argument already.
  if (n === 1 || n % 500 === 0) {
    console.warn(
      `[${source}] ${n} print(s) refused: expiry ` +
      `${JSON.stringify(unreadableExpirySample[source])} is not a readable ` +
      `calendar date. The contract cannot be identified, so the print is ` +
      `dropped rather than published with a fabricated symbol.`,
    );
  }
}

/**
 * Epoch milliseconds a trade or quote stamp may take: 2000-01-01 to 2100-01-01.
 *
 * Wide on purpose. It is not a freshness rule; it is a units rule. A stamp in
 * seconds lands in 1970 and one in micro- or nanoseconds lands tens of
 * thousands of years ahead, and both are outside it by orders of magnitude.
 */
const EPOCH_MS_MIN = Date.UTC(2000, 0, 1);
const EPOCH_MS_MAX = Date.UTC(2100, 0, 1);

/**
 * How far ahead of its own receipt a stamp may be: the clock skew the Tradier
 * validator already tolerates (`maxClockSkewMs`). A trade cannot happen after
 * it was received; beyond skew, the clock or the units are wrong.
 */
export const MAX_STAMP_AHEAD_OF_RECEIPT_MS = 5 * 60_000;

/**
 * Why a stamp cannot be read as the moment something happened, or null if it
 * can. `receivedAt` is undefined for replay, which has no receipt to bound by.
 */
export function stampFault(ts: number, receivedAt: number | undefined): string | null {
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return 'is not a number';
  if (ts < EPOCH_MS_MIN || ts > EPOCH_MS_MAX) {
    return 'is not epoch milliseconds (seconds, micro- or nanoseconds?)';
  }
  if (receivedAt !== undefined && ts > receivedAt + MAX_STAMP_AHEAD_OF_RECEIPT_MS) {
    return 'is more than 5 min after the print was received';
  }
  return null;
}

function noteUnreadableTradeTime(S: IngestorState, source: string, ts: unknown, why: string): void {
  const n = (S.unreadableTradeTimes[source] ?? 0) + 1;
  S.unreadableTradeTimes[source] = n;
  if (S.unreadableTradeTimeSample[source] === undefined) {
    S.unreadableTradeTimeSample[source] = `${String(ts).slice(0, 24)} ${why}`;
  }
  if (n === 1 || n % 500 === 0) {
    console.warn(
      `[${source}] ${n} print(s) refused: trade time ${S.unreadableTradeTimeSample[source]}. ` +
      `The print is dropped rather than published with a fabricated date.`,
    );
  }
}

/** Per source: prints refused for an unreadable trade time, and an example. */
function unreadableTradeTimeCountsOf(S: IngestorState): Record<string, { count: number; sample: string }> {
  const out: Record<string, { count: number; sample: string }> = {};
  for (const [source, count] of Object.entries(S.unreadableTradeTimes)) {
    out[source] = { count, sample: S.unreadableTradeTimeSample[source] ?? '' };
  }
  return out;
}

/** Per source: how many prints were refused, and an example of the value. */
function unreadableExpiryCountsOf(S: IngestorState): Record<string, { count: number; sample: string }> {
  const out: Record<string, { count: number; sample: string }> = {};
  for (const [source, count] of Object.entries(S.unreadableExpiries)) {
    out[source] = { count, sample: S.unreadableExpirySample[source] ?? '' };
  }
  return out;
}

/**
 * Feed one print. Returns the signals finalized by this print (often none —
 * the engine emits on burst close, not per trade).
 */
function ingestInto(S: IngestorState, print: RawPrint): WireFlowEvent[] {
  // `strike` joined this guard late. It was the one field of the five that a
  // caller could leave absent: `occSymbol` pads `Math.round(0 * 1000)` to
  // `00000000` without complaint, so a strike-0 print became a real-looking
  // OCC symbol and was classified, scored and published. Measured through this
  // function, one print, spot 580:
  //
  //     strike 0   -> moneyness ITM, sentiment BULLISH, score 32
  //
  // because `moneynessOf` asks `spot > strike`, and every spot is above zero.
  // `marketData` was fixed connector-side by dropping the row; this is the
  // same rule at the seam every source passes through, so the next caller
  // gets it without knowing about it.
  if (!print.symbol || !print.expiry || !(print.price > 0) || !(print.size > 0)) return [];
  if (!(print.strike > 0)) return [];
  // `expiry` was the sixth field, and it was checked for TRUTHINESS only —
  // which is exactly what `strike` was before the line above, and produced the
  // same class of outcome. Measured through this function, one print at
  // 2026-09-24 against an October expiry:
  //
  //     expiry "2026-10-16" -> occ SPY261016C00550000    dte 22
  //     expiry "20261016"   -> occ SPY261016C00550000    dte  0
  //     expiry "10/16/2026" -> occ SPY/16/2026C00550000  dte  0
  //     expiry "not-a-date" -> occ SPYtadateC00550000    dte  0
  //     expiry "2026-13-45" -> occ SPY261345C00550000    dte  0
  //
  // Two things came out of it. `occSymbol` splits on '-' and slices, so any
  // string produces a real-looking contract symbol — and that symbol is the
  // contract's identity for the NBBO book and the stats table, so a malformed
  // one silently partitions or merges contracts. And the wire's
  // `days_to_expiry` fell to 0, which does not read as "unknown": it reads as
  // **0DTE**, the shortest-dated and highest-attention bucket there is.
  //
  // The compact-ISO row is the one that decides this. `20261016` is a format a
  // vendor could plausibly switch to, it yields the CORRECT OCC symbol, and it
  // publishes every contract as expiring today. Nothing would look wrong.
  //
  // The test is `expiryInstantMs` rather than a regex here, because that is the
  // one home for reading an expiry and its docstring already argues why it
  // rejects a loose parse. Three of the four chain connectors pass a vendor
  // string through with a truthiness check only, and none of them has ever run
  // against a live vendor from this tree — so a format mismatch surfaces here,
  // counted and named on /api/health, instead of as a tape of 0DTE prints.
  if (Number.isNaN(expiryInstantMs(print.expiry))) {
    noteUnreadableExpiry(S, print.source, print.expiry);
    return [];
  }

  // A root the source named but this cannot read is refused rather than
  // replaced with the underlying: substituting it is the SPX/SPXW merge the
  // field exists to prevent.
  if (print.root !== undefined && !/^[A-Z][A-Z0-9]{0,5}$/.test(print.root)) return [];

  // Receipt time is stamped here, at the boundary — the earliest moment this
  // process could possibly have known about the print. Distinct from `ts`,
  // which is when it happened at the venue; the gap between them is the feed
  // latency a forward measurement must be charged.
  const receivedAt = print.receivedAt ?? (print.replay ? undefined : S.now());
  // The trade time was the one field of a print nothing checked. Measured
  // through this function, one SPY print against a November expiry:
  //
  //     ts in ms (control)  -> dte 25
  //     ts in seconds       -> dte 20757, trade dated 1970
  //     ts in microseconds  -> dte 0 (published as 0DTE), dated ~year 58000
  //     ts in nanoseconds   -> threw "Invalid time value" out of ingestPrint
  //     ts NaN              -> threw "Invalid time value"
  //
  // A unit mix-up is the likely vendor change (Polygon sends nanoseconds,
  // Tradier milliseconds), and the microsecond row is the expiry finding again:
  // a wrong date that reads as the loudest bucket rather than as unknown. An
  // absent `ts` still means "now", because a source that sends none is
  // stamping receipt, which is honest.
  if (print.ts !== undefined) {
    const why = stampFault(print.ts, receivedAt);
    if (why) {
      noteUnreadableTradeTime(S, print.source, print.ts, why);
      return [];
    }
  }
  const ts = print.ts ?? S.now();
  S.lastPrintTs = Math.max(S.lastPrintTs, ts);
  const symbol = occSymbol(print.root ?? print.symbol, print.expiry, print.right, print.strike);

  recordStats(S, symbol, print);

  // NBBO first: a trade with no fresh quote can only ever infer AMBIGUOUS.
  //
  // The quote is published under its OWN timestamp when the source supplies
  // one. Publishing every quote under the trade's `ts` was correct while the
  // only quotes arrived attached to their trade; for a separately-fetched NBBO
  // it would assert that a quote from some seconds earlier was simultaneous
  // with the print, which is exactly the input the staleness rule exists to
  // judge. A quote from after the trade is refused outright by `inferSide`.
  const bid = print.bid;
  const ask = print.ask;
  // A quote stamp nobody can read is withheld rather than trusted: NaN passes
  // both the staleness test and the after-the-trade test, because every
  // comparison with NaN is false, so it read as perfectly fresh. Without the
  // quote the side is AMBIGUOUS, which is the honest answer.
  const quoteTsOk = print.quoteTs === undefined || stampFault(print.quoteTs, receivedAt) === null;
  if (bid !== undefined && ask !== undefined && ask > 0 && ask >= bid
      && !print.tradeTimeUnknown && quoteTsOk) {
    S.engine.onQuote({ ts: print.quoteTs ?? ts, contractSymbol: symbol, bid, ask });
  }

  // ONE upstream record is ONE observed execution.
  //
  // This used to split a record carrying `exchanges: [A, B, C]` and
  // `size: 60` into three trade events of 20, one per venue, on the reasoning
  // that "a multi-venue fill is several prints — that is what makes it a
  // sweep". That reasoning is an assumption written as arithmetic, and it
  // fabricated five things the source never said: the print count, the size at
  // each venue, three event identities, their simultaneity, and — because the
  // engine's sweep test is `new Set(trades.map(t => t.exchange)).size >= 2` —
  // the venue diversity that produced the SWEEP label itself. Measured: one
  // record in, `printIds: ["AGG1-0","AGG1-1","AGG1-2"]` out, classified SWEEP.
  //
  // A venue list on one record is evidence about *where* the order touched,
  // not a record of separate fills. It is carried as evidence and the
  // allocation across those venues is reported UNKNOWN, because it is. A
  // source that genuinely observes individual executions sends them as
  // individual prints, and each becomes its own event here — which is what
  // makes multi-venue clustering meaningful when it does happen.
  const declaredVenues = print.exchanges?.length
    ? print.exchanges
    : [print.exchange ?? 'UNKNOWN'];
  const venueAllocation: VenueAllocation =
    declaredVenues.length > 1 ? 'UNKNOWN' : 'OBSERVED';

  const out: ClassifiedSignal[] = [];

  {
    const { printSource } = S;
    const id = print.id ?? `p${++S.seq}`;
    // Evict the oldest entries rather than clearing: a wholesale clear would
    // drop the origins of prints in an unfinalized burst, and those origins
    // carry `synthetic` — the one flag that must always reach the UI.
    if (printSource.size >= MAX_TRACKED_PRINTS) {
      let toEvict = Math.floor(MAX_TRACKED_PRINTS / 4);
      for (const key of printSource.keys()) {
        if (toEvict-- <= 0) break;
        printSource.delete(key);
      }
    }
    printSource.set(id, {
      source: print.source,
      synthetic: print.synthetic === true,
      iv: print.iv,
      delta: print.delta,
      declaredVenues,
      venueAllocation,
    });

    const trade: OptionTradeEvent = {
      id,
      ts,
      contract: {
        symbol,
        underlying: print.symbol,
        right: print.right,
        strike: print.strike,
        expiry: print.expiry,
      },
      price: print.price,
      size: print.size,
      // The engine's event carries a single venue. When the source declared
      // several for one record, the first stands as the event's venue and the
      // full list travels as evidence — rather than inventing a separate
      // execution per name so the set looks diverse.
      exchange: declaredVenues[0] ?? 'UNKNOWN',
      conditions: print.conditions ?? [],
      iso: print.iso,
      receivedAt,
    };
    out.push(...S.engine.onTrade(trade));
  }

  notify(S, out);
  return out.map((sig) => toWireEvent(S, sig));
}

/** See `drainIdle`. */
function drainIdleOf(S: IngestorState, quietMs: number): WireFlowEvent[] {
  if (S.lastPrintTs === 0 || S.now() - S.lastPrintTs < quietMs) return [];
  return flushOf(S);
}

function flushOf(S: IngestorState): WireFlowEvent[] {
  const flushed = S.engine.flush();
  notify(S, flushed);
  return flushed.map((sig) => toWireEvent(S, sig));
}

/** See `resetDaily`. */
function resetDailyOf(S: IngestorState): void {
  S.engine.resetDaily();
  S.contractStats.clear();
  // `printSource` is deliberately NOT cleared: a burst can straddle the reset,
  // and losing its origins would emit `synthetic: false` for simulated data.
  // The map is bounded by eviction in `ingestPrint`.
}

// ─── Instances ──────────────────────────────────────────────────────────────

/**
 * Everything one ingestion pipeline remembers between prints: the engine with
 * its NBBO book and open bursts, the per-contract stats the scorer reads, the
 * origin of every print still inside a burst, and who is told about signals.
 *
 * It used to be module state, so there was exactly one pipeline per process.
 * A research re-run that needed the engine under a different configuration —
 * H-001-v2 §I's 1 s and 5 s staleness bounds — then had two options, both
 * wrong: feed the live engine (its NBBO book and repeat counters would absorb
 * historical prints, and its observers include the recorder, so a replayed
 * signal would be offered to the track record), or re-implement the seam
 * beside it, which is a second copy of the six refusals above for nobody to
 * keep in agreement. An instance gets the same seam, and nothing else.
 */
interface IngestorState {
  readonly engine: FlowEngine;
  readonly contractStats: Map<string, ContractStats>;
  readonly printSource: Map<string, PrintOrigin>;
  seq: number;
  lastPrintTs: number;
  readonly observers: SignalObserver[];
  readonly unreadableExpiries: Record<string, number>;
  /** The first malformed value seen per source, so the note can name the shape. */
  readonly unreadableExpirySample: Record<string, string>;
  /** Prints refused at the seam for a trade time that is not epoch ms, per source. */
  readonly unreadableTradeTimes: Record<string, number>;
  readonly unreadableTradeTimeSample: Record<string, string>;
  /** Stamps receipt time, a missing trade time, `emittedAt`, and the idle-drain clock. */
  readonly now: () => number;
}

export interface IngestorOptions {
  /** Overrides on the engine's defaults; the live pipeline passes none. */
  engineConfig?: Partial<FlowEngineConfig>;
  /**
   * The wall clock. A replay that must be deterministic passes its own; the
   * live default reads `Date.now()` at each call, so a test that stubs it
   * still reaches this instance.
   */
  now?: () => number;
}

export interface Ingestor {
  ingestPrint(print: RawPrint): WireFlowEvent[];
  drainIdle(quietMs?: number): WireFlowEvent[];
  /** Finalize every open burst now, whatever the clock says. The end of a replay. */
  flush(): WireFlowEvent[];
  resetDaily(): void;
  onSignal(fn: SignalObserver): void;
  clearSignalObservers(): void;
  unreadableExpiryCounts(): Record<string, { count: number; sample: string }>;
  unreadableTradeTimeCounts(): Record<string, { count: number; sample: string }>;
  /** The configuration this instance's engine runs under, resolved against the defaults. */
  readonly config: Readonly<FlowEngineConfig>;
}

export function createIngestor(opts: IngestorOptions = {}): Ingestor {
  const now = opts.now ?? (() => Date.now());
  const contractStats = new Map<string, ContractStats>();
  const S: IngestorState = {
    engine: new FlowEngine(opts.engineConfig ?? {}, (sym) => contractStats.get(sym), now),
    contractStats,
    printSource: new Map(),
    seq: 0,
    lastPrintTs: 0,
    observers: [],
    unreadableExpiries: {},
    unreadableExpirySample: {},
    unreadableTradeTimes: {},
    unreadableTradeTimeSample: {},
    now,
  };
  return {
    ingestPrint: (print) => ingestInto(S, print),
    drainIdle: (quietMs = 500) => drainIdleOf(S, quietMs),
    flush: () => flushOf(S),
    resetDaily: () => resetDailyOf(S),
    onSignal: (fn) => { S.observers.push(fn); },
    clearSignalObservers: () => { S.observers.length = 0; },
    unreadableExpiryCounts: () => unreadableExpiryCountsOf(S),
    unreadableTradeTimeCounts: () => unreadableTradeTimeCountsOf(S),
    config: Object.freeze({ ...DEFAULT_CONFIG, ...opts.engineConfig }),
  };
}

/**
 * The one live pipeline. Every connector, the recorder and `/api/health` reach
 * it through the module-level functions below, which is what they always
 * called — so the live path is unchanged by instances existing at all.
 */
const live = createIngestor();

/** Feed one print to the live pipeline. Returns the signals it finalized (often none). */
export function ingestPrint(print: RawPrint): WireFlowEvent[] { return live.ingestPrint(print); }

/**
 * Drain bursts that have gone quiet. The engine finalizes a burst when a later
 * trade advances its watermark, so an idle feed would otherwise hold the last
 * signal indefinitely. Only drains when the feed has been silent well past the
 * sweep window, so a live cluster is never cut in half.
 */
export function drainIdle(quietMs = 500): WireFlowEvent[] { return live.drainIdle(quietMs); }

/**
 * Clear per-session counters. `repeatHits` is scored as "prior signals on the
 * same contract+side *today*", so on a long-lived process it must be reset or
 * every contract drifts toward the maximum repeat component.
 */
export function resetDaily(): void { live.resetDaily(); }

export function onSignal(fn: SignalObserver): void { live.onSignal(fn); }

/** Test seam. */
export function __clearSignalObservers(): void { live.clearSignalObservers(); }

/**
 * Per source: how many prints the live pipeline refused, and an example value.
 *
 * Read by `getIngestionStatus()` into `sourceNotes`. Exported rather than
 * folded into a note string here, because formatting a health note is that
 * module's job and a second copy of the vocabulary is how `sourceNotes` and
 * `sourceErrors` would start disagreeing.
 */
export function unreadableExpiryCounts(): Record<string, { count: number; sample: string }> {
  return live.unreadableExpiryCounts();
}

/** Prints the live pipeline refused for an unreadable trade time, per source. */
export function unreadableTradeTimeCounts(): Record<string, { count: number; sample: string }> {
  return live.unreadableTradeTimeCounts();
}

/**
 * The score at or above which a signal is `is_unusual`.
 *
 * One home. `is_unusual` was `sig.score >= 75` here, and the frontend's
 * `isPowerAlert` read `e.is_unusual && e.heat_score >= 75` — a conjunction
 * whose second term is implied by the first, restating the threshold in a
 * second place while looking like an independent condition. The power alerts
 * page then described its trigger as two conditions, which was true and
 * misleading at once.
 */
export const UNUSUAL_SCORE = 75;

// ─── Signal → wire ──────────────────────────────────────────────────────────

/**
 * Rank of a DISPLAY class, most restrictive first. Used to publish the
 * **weakest** class across a cluster's datasets rather than the first one.
 *
 * A cluster spanning a PERMITTED source and an UNVERIFIED one is not a
 * permitted cluster — the recorder already reasons this way for PERSIST, and
 * publishing the strongest class would let one clean print launder the rest.
 * `UNKNOWN_DATASET` ranks below everything: an unregistered source is the
 * least established thing on the list, not the most.
 *
 * Keyed by the union rather than by `string`, so the lookup is total and
 * needs no `?? 0`. `defaultedReadings.test.ts` refused the widened version,
 * correctly: a default here would have been a silent claim about a class
 * nobody declared — the same defect `nominalHorizonMs` was fixed for.
 */
const DISPLAY_RANK: Record<RightsClass | 'UNKNOWN_DATASET', number> = {
  UNKNOWN_DATASET: 0,
  PROHIBITED: 1,
  UNVERIFIED: 2,
  PERMITTED: 3,
};

/**
 * The datasets behind a signal and the weakest DISPLAY class among them.
 *
 * Note this asks the **DISPLAY** question. `recorder.ts` asks PERSIST of the
 * same sources and can get a different answer for the same dataset, which is
 * exactly why the wire field is named for its axis.
 */
export function displayRightsOf(sources: string[]): {
  datasets: string[];
  rights_display: RightsClass | 'UNKNOWN_DATASET';
} {
  const seen = new Set<string>();
  let weakest: RightsClass | 'UNKNOWN_DATASET' = 'PERMITTED';
  let anyResolved = false;

  for (const src of sources) {
    const d = classifySource(src, 'DISPLAY');
    const cls = d.rightsClass as RightsClass | 'UNKNOWN_DATASET';
    if (DISPLAY_RANK[cls] < DISPLAY_RANK[weakest]) weakest = cls;

    // Only a **registered** dataset is named. `classifySource` mints
    // `source:<name>` as the id for an unregistered source, and publishing
    // that would put a placeholder in the CSV's Datasets column beside real
    // registry entries like TRADIER_STREAM, where a reader sorting the column
    // could not tell which is which. `UNKNOWN_DATASET` on the class already
    // says the row could not be attributed; the list does not need to invent
    // a name for the thing it failed to find.
    //
    // Found by mutating this function: swapping the class resolution was an
    // *equivalent* mutation, which is what exposed that the branch it touched
    // was dead — and the dead branch was hiding this.
    if (cls !== 'UNKNOWN_DATASET') {
      seen.add(d.datasetId);
      anyResolved = true;
    }
  }

  // No resolvable source at all is not "permitted by default".
  if (!anyResolved) return { datasets: [], rights_display: 'UNKNOWN_DATASET' };
  return { datasets: [...seen].sort(), rights_display: weakest };
}

function toWireEvent(S: IngestorState, sig: ClassifiedSignal): WireFlowEvent {
  const dominant = [...sig.legs].sort((a, b) => b.totalPremium - a.totalPremium)[0];
  const leg = dominant ?? sig.legs[0]!;
  const stats = S.contractStats.get(leg.contract.symbol);
  // `?? 0` here put a spot price of zero on the wire — and fed `moneynessOf`,
  // which then classified the strike against it.
  const spot = stats?.underlyingPrice ?? null;

  const origins = sig.printIds.map((id) => S.printSource.get(id)).filter(Boolean);
  const { source, sources, synthetic } = originOf(S, sig);
  const rights = displayRightsOf(sources);
  const iv = origins.find((o) => o?.iv !== undefined)?.iv ?? null;
  const delta = origins.find((o) => o?.delta !== undefined)?.delta ?? null;

  // Venues actually carried by the engine's events — one per upstream record.
  const exchanges = new Set<string>();
  sig.legs.forEach((l) => l.exchanges.forEach((e) => exchanges.add(e)));

  // Venues the sources *named*, which can exceed the above when a record
  // declared several at once. `venue_allocation` says which of the two this
  // signal's evidence is: UNKNOWN if any contributing record declared a list.
  const declared = new Set<string>();
  let venueAllocation: VenueAllocation = 'OBSERVED';
  for (const o of origins) {
    if (!o) continue;
    o.declaredVenues?.forEach((v) => declared.add(v));
    if (o.venueAllocation === 'UNKNOWN') venueAllocation = 'UNKNOWN';
  }
  exchanges.forEach((e) => declared.add(e));

  return {
    id: sig.id,
    underlying: sig.underlying,
    expiry: leg.contract.expiry,
    strike: leg.contract.strike,
    option_type: leg.contract.right,
    order_type: sig.kind,
    total_size: sig.totalSize,
    total_premium: Math.round(sig.totalPremium),
    heat_score: sig.score,
    sentiment: sentimentOf(sig.side, leg.contract.right),
    is_unusual: sig.score >= UNUSUAL_SCORE,
    unusual_threshold: UNUSUAL_SCORE,
    exchange_count: exchanges.size,
    /**
     * Every venue named by the contributing records, and whether the size at
     * each was separately observed. `exchange_count` counts observed
     * executions; these two say what is actually known about venue spread, so
     * a reader can tell "four prints across four exchanges" from "one record
     * that mentioned four".
     */
    venue_evidence: [...declared],
    venue_allocation: venueAllocation,
    avg_price: parseFloat(leg.vwap.toFixed(4)),
    iv,
    delta,
    open_interest: stats?.openInterest ?? null,
    days_to_expiry: daysToExpiry(sig.ts, leg.contract.expiry),
    moneyness: moneynessOf(leg.contract.right, leg.contract.strike, spot),
    spot_price: spot,
    created_at: new Date(sig.ts).toISOString(),
    source,
    side: sig.side,
    score_breakdown: sig.scoreBreakdown,
    legs: sig.kind === 'MULTI_LEG'
      ? sig.legs.map((l) => ({
          underlying: l.contract.underlying,
          expiry: l.contract.expiry,
          strike: l.contract.strike,
          option_type: l.contract.right,
          side: l.side,
          total_size: l.totalSize,
          total_premium: Math.round(l.totalPremium),
          avg_price: parseFloat(l.vwap.toFixed(4)),
          prints: l.prints,
          exchanges: l.exchanges,
        }))
      : undefined,
    spread_guess: sig.spreadGuess,
    print_ids: sig.printIds,
    synthetic,
    datasets: rights.datasets,
    rights_display: rights.rights_display,
  };
}

/**
 * Direction is a function of side *and* right — buying puts is bearish,
 * selling puts is bullish. An unknown side is never given a direction.
 */
export function sentimentOf(
  side: InferredSide, right: 'C' | 'P',
): 'BULLISH' | 'BEARISH' | 'NEUTRAL' {
  const bucket = sideBucket(side);
  if (bucket === 'AMBIGUOUS') return 'NEUTRAL';
  const bullish = bucket === 'BUY' ? right === 'C' : right === 'P';
  return bullish ? 'BULLISH' : 'BEARISH';
}

/**
 * Whole days to expiry for the wire, from the engine's own instant.
 *
 * This had its own `T20:00:00Z` parse — the third copy of one rule, and the
 * two that computed a number disagreed about rounding as well as being wrong
 * in winter. The instant now comes from `flow-engine/expiry.ts`; the rounding
 * stays here, because a whole number of days is a presentation choice for this
 * wire field and not a property of the contract.
 */
function daysToExpiry(tsMs: number, expiry: string): number | null {
  const dte = engineDaysToExpiry(tsMs, expiry);
  // `null`, never 0. A 0 here does not read as "unknown", it reads as 0DTE —
  // which is a claim about the contract, and the loudest one on the board.
  // `ingestPrint` refuses an unreadable expiry at the seam, so this branch is
  // unreachable today; it is `null` anyway because the previous type could not
  // express the honest answer, which is the defect `SpotQuote.change` had.
  return Number.isNaN(dte) ? null : Math.round(dte);
}

/**
 * Where the strike sits against the underlying — or `UNKNOWN`.
 *
 * This returned `'OTM'` when the spot was not known, which is a classification
 * asserted from no data. It reached the wire on every signal whose contract
 * had no chain snapshot behind it.
 */
function moneynessOf(
  right: 'C' | 'P', strike: number, spot: number | null,
): 'ITM' | 'ATM' | 'OTM' | 'UNKNOWN' {
  if (spot === null || !(spot > 0)) return 'UNKNOWN';
  if (Math.abs(strike - spot) / spot <= 0.01) return 'ATM';
  const itm = right === 'C' ? spot > strike : spot < strike;
  return itm ? 'ITM' : 'OTM';
}
