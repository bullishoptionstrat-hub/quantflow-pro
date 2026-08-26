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
const printSource = new Map<string, { source: string; synthetic: boolean; iv?: number; delta?: number }>();
const MAX_TRACKED_PRINTS = 20_000;

let seq = 0;
let lastPrintTs = 0;

// ─── Ingest ─────────────────────────────────────────────────────────────────

/**
 * Feed one print. Returns the signals finalized by this print (often none —
 * the engine emits on burst close, not per trade).
 */
export function ingestPrint(print: RawPrint): WireFlowEvent[] {
  if (!print.symbol || !print.expiry || !(print.price > 0) || !(print.size > 0)) return [];

  const ts = print.ts ?? Date.now();
  lastPrintTs = Math.max(lastPrintTs, ts);
  const symbol = occSymbol(print.symbol, print.expiry, print.right, print.strike);

  recordStats(symbol, print);

  // NBBO first: a trade with no fresh quote can only ever infer AMBIGUOUS.
  const bid = print.bid;
  const ask = print.ask;
  if (bid !== undefined && ask !== undefined && ask > 0 && ask >= bid) {
    engine.onQuote({ ts, contractSymbol: symbol, bid, ask });
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
    };
    out.push(...engine.onTrade(trade));
  });

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
  return engine.flush().map(toWireEvent);
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
  const source = origins[0]?.source ?? 'unknown';
  const iv = origins.find((o) => o?.iv !== undefined)?.iv ?? 0;
  const delta = origins.find((o) => o?.delta !== undefined)?.delta ?? 0;

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
    synthetic: sig.synthetic || origins.some((o) => o?.synthetic === true),
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
