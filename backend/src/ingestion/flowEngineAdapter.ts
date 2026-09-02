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
import { type InferenceGrade, type Provenance, upstreamProvenance } from '../config/provenance';
import { confidenceForSide, gradeForSide, inferenceMethodFor } from '../flow/grade';
import type {
  ClassifiedSignal,
  ContractStats,
  InferredSide,
  OptionTradeEvent,
} from '../flow-engine/types';

// ─── Input ──────────────────────────────────────────────────────────────────

/** Provider-agnostic print. Every connector normalizes to this. */
export interface RawPrint {
  id?: string;
  /** Epoch ms. Defaults to now. Prints must arrive roughly ascending. */
  ts?: number;
  symbol: string;                 // underlying, e.g. "SPY"
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
   * Truth Firewall envelope for the originating print. Carried through
   * classification so the emitted signal can state where it came from, whether
   * it is delayed, and how its side was inferred. A print without provenance is
   * not publishable in live mode — see `rejectEmission` in config/dataMode.
   */
  provenance?: Provenance;
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
  is_unusual: boolean;
  exchange_count: number;
  avg_price: number;
  iv: number;
  delta: number;
  open_interest: number;
  days_to_expiry: number;
  moneyness: 'ITM' | 'ATM' | 'OTM';
  spot_price: number;
  created_at: string;
  source: string;
  ml_score?: number;

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
   * How far the `side` above may be trusted. Never OBSERVED — see flow/grade.ts.
   */
  classification_grade: InferenceGrade;
  /**
   * Provenance of the dominant originating print. Always present: when no
   * origin carried one, a minimal envelope is synthesized from the source name
   * so the field is never silently absent (absence would read as "real" at the
   * emit boundary, which is the failure this contract exists to prevent).
   */
  provenance: Provenance;
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

const contractStats = new Map<string, ContractStats>();
const MAX_TRACKED_CONTRACTS = 5_000;

function recordStats(symbol: string, print: RawPrint): void {
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
    dayVolume: print.dayVolume ?? prev?.dayVolume ?? 0,
    underlyingPrice: print.underlyingPrice ?? prev?.underlyingPrice,
  });
}

// ─── Engine instance ────────────────────────────────────────────────────────

const engine = new FlowEngine({}, (sym) => contractStats.get(sym));

/** Source label per print id, so emitted signals keep their provenance. */
const printSource = new Map<
  string,
  { source: string; synthetic: boolean; iv?: number; delta?: number; provenance?: Provenance }
>();
const MAX_TRACKED_PRINTS = 20_000;

let seq = 0;
let lastPrintTs = 0;

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

const observers: SignalObserver[] = [];

export function onSignal(fn: SignalObserver): void {
  observers.push(fn);
}

/** Test seam. */
export function __clearSignalObservers(): void {
  observers.length = 0;
}

function notify(sigs: ClassifiedSignal[]): void {
  if (observers.length === 0) return;
  for (const sig of sigs) {
    const origin = originOf(sig);
    for (const fn of observers) {
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
function originOf(sig: ClassifiedSignal): SignalOrigin {
  const resolved = sig.printIds.map((id) => printSource.get(id));
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
 * Feed one print. Returns the signals finalized by this print (often none —
 * the engine emits on burst close, not per trade).
 */
export function ingestPrint(print: RawPrint): WireFlowEvent[] {
  // `strike > 0` belongs with the other identity checks, and its absence was a
  // hole. `occSymbol()` below builds the contract key from the strike, so a
  // zero-strike print does not merely carry a wrong number — it is assigned a
  // fabricated contract identity (strike part `00000000`), and the engine
  // clusters by that key. A run of rows whose strike failed to parse therefore
  // collapses into one synthetic "contract" and is scored as repeat activity on
  // it. No listed option has a strike of zero, so this rejects nothing real.
  if (
    !print.symbol || !print.expiry ||
    !(print.price > 0) || !(print.size > 0) || !(print.strike > 0)
  ) return [];

  const ts = print.ts ?? Date.now();
  // Receipt time is stamped here, at the boundary — the earliest moment this
  // process could possibly have known about the print. Distinct from `ts`,
  // which is when it happened at the venue; the gap between them is the feed
  // latency a forward measurement must be charged.
  const receivedAt = print.replay ? undefined : Date.now();
  lastPrintTs = Math.max(lastPrintTs, ts);
  const symbol = occSymbol(print.symbol, print.expiry, print.right, print.strike);

  recordStats(symbol, print);

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
  if (bid !== undefined && ask !== undefined && ask > 0 && ask >= bid) {
    engine.onQuote({ ts: print.quoteTs ?? ts, contractSymbol: symbol, bid, ask });
  }

  const venues = print.exchanges?.length
    ? print.exchanges
    : [print.exchange ?? 'UNKNOWN'];

  // A multi-venue fill is several prints, one per venue — that is what makes
  // it a sweep. Split the size across venues rather than double-counting it.
  const perVenueSize = Math.max(1, Math.floor(print.size / venues.length));
  const out: ClassifiedSignal[] = [];

  venues.forEach((venue, i) => {
    const id = `${print.id ?? `p${++seq}`}${venues.length > 1 ? `-${i}` : ''}`;
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
      provenance: print.provenance,
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
      size: i === venues.length - 1
        ? print.size - perVenueSize * (venues.length - 1) // remainder on the last
        : perVenueSize,
      exchange: venue,
      conditions: print.conditions ?? [],
      iso: print.iso,
      receivedAt,
    };
    out.push(...engine.onTrade(trade));
  });

  notify(out);
  return out.map(toWireEvent);
}

/**
 * Drain bursts that have gone quiet. The engine finalizes a burst when a later
 * trade advances its watermark, so an idle feed would otherwise hold the last
 * signal indefinitely. Only drains when the feed has been silent well past the
 * sweep window, so a live cluster is never cut in half.
 */
export function drainIdle(quietMs = 500): WireFlowEvent[] {
  if (lastPrintTs === 0 || Date.now() - lastPrintTs < quietMs) return [];
  const flushed = engine.flush();
  notify(flushed);
  return flushed.map(toWireEvent);
}

/**
 * Clear per-session counters. `repeatHits` is scored as "prior signals on the
 * same contract+side *today*", so on a long-lived process it must be reset or
 * every contract drifts toward the maximum repeat component.
 */
export function resetDaily(): void {
  engine.resetDaily();
  contractStats.clear();
  // `printSource` is deliberately NOT cleared: a burst can straddle the reset,
  // and losing its origins would emit `synthetic: false` for simulated data.
  // The map is bounded by eviction in `ingestPrint`.
}

// ─── Signal → wire ──────────────────────────────────────────────────────────

function toWireEvent(sig: ClassifiedSignal): WireFlowEvent {
  const dominant = [...sig.legs].sort((a, b) => b.totalPremium - a.totalPremium)[0];
  const leg = dominant ?? sig.legs[0]!;
  const stats = contractStats.get(leg.contract.symbol);
  const spot = stats?.underlyingPrice ?? 0;

  const origins = sig.printIds.map((id) => printSource.get(id)).filter(Boolean);
  const { source, synthetic } = originOf(sig);
  const iv = origins.find((o) => o?.iv !== undefined)?.iv ?? 0;
  const delta = origins.find((o) => o?.delta !== undefined)?.delta ?? 0;

  // Provenance of the dominant origin, else a minimal envelope built from the
  // source name. Never left undefined: the emit boundary treats missing
  // provenance in live mode as a rejection, and a signal that reached this
  // point has real prints behind it — it should be rejected for the right
  // reason (an unknown source) rather than for having no envelope at all.
  const provenance: Provenance =
    origins.find((o) => o?.provenance)?.provenance ??
    upstreamProvenance({
      source,
      source_type: synthetic ? 'generator' : 'vendor',
      // Side is always inferred here — this pipeline never receives an
      // exchange aggressor flag. `sig.side` may legitimately be AMBIGUOUS.
      is_inferred: true,
      inference_method: inferenceMethodFor(sig.side),
      confidence: confidenceForSide(sig.side),
    });

  const exchanges = new Set<string>();
  sig.legs.forEach((l) => l.exchanges.forEach((e) => exchanges.add(e)));

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
    is_unusual: sig.score >= 75,
    exchange_count: exchanges.size,
    avg_price: parseFloat(leg.vwap.toFixed(4)),
    iv,
    delta,
    open_interest: stats?.openInterest ?? 0,
    days_to_expiry: daysToExpiry(sig.ts, leg.contract.expiry),
    moneyness: moneynessOf(leg.contract.right, leg.contract.strike, spot),
    spot_price: spot,
    created_at: new Date(sig.ts).toISOString(),
    source,
    side: sig.side,
    classification_grade: gradeForSide(sig.side),
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
    // `originOf` already ORs in `sig.synthetic` and treats evicted origins as
    // synthetic, so this is the pessimistic value — do not re-OR it here.
    synthetic,
    provenance,
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

function daysToExpiry(tsMs: number, expiry: string): number {
  const exp = Date.parse(`${expiry}T20:00:00Z`);
  if (Number.isNaN(exp)) return 0;
  return Math.max(0, Math.round((exp - tsMs) / 86_400_000));
}

function moneynessOf(
  right: 'C' | 'P', strike: number, spot: number,
): 'ITM' | 'ATM' | 'OTM' {
  if (!(spot > 0)) return 'OTM';
  if (Math.abs(strike - spot) / spot <= 0.01) return 'ATM';
  const itm = right === 'C' ? spot > strike : spot < strike;
  return itm ? 'ITM' : 'OTM';
}
