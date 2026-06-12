/**
 * QuantFlow Flow Engine — orchestrator
 *
 * Streaming classifier for options time & sales. Events must arrive in
 * roughly ascending timestamp order (true for both live feeds and replay).
 *
 * Pipeline per underlying:
 *   trades → burst clustering (gap ≤ sweepWindowMs)
 *          → finalize when watermark passes the burst
 *          → MULTI_LEG if ≥2 contracts opened within multiLegWindowMs
 *          → else per contract+side group: SWEEP / BLOCK / LARGE
 *          → unclassified small prints feed the SPLIT detector
 *   every emitted signal is scored (rule-based v1) with full breakdown.
 *
 * Honesty contracts:
 *   - side is AMBIGUOUS when NBBO is missing/stale — never guessed
 *   - `synthetic` flag propagates to every signal in replay/fixture mode
 *   - every signal carries the print ids that formed it (audit trail)
 */
import { NbboBook, sideBucket } from "./nbbo.js";
import { scoreSignal } from "./score.js";
import {
  ClassifiedSignal,
  ContractStats,
  DEFAULT_CONFIG,
  FlowEngineConfig,
  InferredSide,
  OptionQuoteEvent,
  OptionTradeEvent,
  premiumOf,
  SignalLeg,
} from "./types.js";

interface AnnotatedTrade extends OptionTradeEvent {
  side: InferredSide;
}

interface Burst {
  underlying: string;
  firstTs: number;
  lastTs: number;
  trades: AnnotatedTrade[];
}

type StatsLookup = (contractSymbol: string) => ContractStats | undefined;

export class FlowEngine {
  private readonly cfg: FlowEngineConfig;
  private readonly nbbo = new NbboBook();
  private readonly bursts = new Map<string, Burst>(); // key: underlying
  private readonly splitBuf = new Map<string, AnnotatedTrade[]>(); // key: contract|side
  private readonly repeatHits = new Map<string, number>(); // key: contract|side
  private watermark = 0;
  private seq = 0;

  constructor(
    config: Partial<FlowEngineConfig> = {},
    private readonly statsLookup: StatsLookup = () => undefined,
  ) {
    this.cfg = { ...DEFAULT_CONFIG, ...config };
  }

  onQuote(q: OptionQuoteEvent): void {
    this.nbbo.onQuote(q);
    this.watermark = Math.max(this.watermark, q.ts);
  }

  /** Process one trade; returns any signals finalized by the new watermark. */
  onTrade(t: OptionTradeEvent): ClassifiedSignal[] {
    this.watermark = Math.max(this.watermark, t.ts);
    const side = this.nbbo.inferSide(
      t.contract.symbol, t.price, t.ts, this.cfg.nbboMaxAgeMs,
    );
    const annotated: AnnotatedTrade = { ...t, side };

    const out: ClassifiedSignal[] = [];
    const key = t.contract.underlying;
    const burst = this.bursts.get(key);

    if (burst && t.ts - burst.lastTs <= this.cfg.sweepWindowMs) {
      burst.trades.push(annotated);
      burst.lastTs = t.ts;
    } else {
      if (burst) out.push(...this.finalizeBurst(burst));
      this.bursts.set(key, {
        underlying: key, firstTs: t.ts, lastTs: t.ts, trades: [annotated],
      });
    }

    // Finalize any other underlyings whose burst window has closed.
    for (const [u, b] of this.bursts) {
      if (u !== key && this.watermark - b.lastTs > this.cfg.sweepWindowMs) {
        out.push(...this.finalizeBurst(b));
        this.bursts.delete(u);
      }
    }
    return out;
  }

  /** End-of-stream: finalize everything pending. */
  flush(): ClassifiedSignal[] {
    const out: ClassifiedSignal[] = [];
    for (const b of this.bursts.values()) out.push(...this.finalizeBurst(b));
    this.bursts.clear();
    return out;
  }

  // -------------------------------------------------------------------------
  // Burst finalization
  // -------------------------------------------------------------------------

  private finalizeBurst(burst: Burst): ClassifiedSignal[] {
    this.bursts.delete(burst.underlying);
    const out: ClassifiedSignal[] = [];

    // Group prints by contract+sideBucket.
    const groups = new Map<string, AnnotatedTrade[]>();
    const firstTsByContract = new Map<string, number>();
    for (const t of burst.trades) {
      const gk = `${t.contract.symbol}|${sideBucket(t.side)}`;
      const arr = groups.get(gk);
      if (arr) arr.push(t); else groups.set(gk, [t]);
      const f = firstTsByContract.get(t.contract.symbol);
      if (f === undefined || t.ts < f) firstTsByContract.set(t.contract.symbol, t.ts);
    }

    // MULTI_LEG: ≥2 distinct contracts whose first prints land within the leg window.
    const contracts = [...firstTsByContract.entries()].sort((a, b) => a[1] - b[1]);
    const first = contracts[0];
    if (contracts.length >= 2 && first) {
      const within = contracts.filter(
        ([, ts]) => ts - first[1] <= this.cfg.multiLegWindowMs,
      );
      if (within.length >= 2) {
        const legSymbols = new Set(within.map(([sym]) => sym));
        const legGroups = [...groups.entries()].filter(([gk]) =>
          legSymbols.has(gk.split("|")[0] ?? ""),
        );
        const sig = this.buildSignal("MULTI_LEG", legGroups.map(([, ts]) => ts));
        if (sig) out.push(sig);
        // Remaining groups (outside the leg window) classify independently.
        for (const [gk, trades] of groups) {
          if (!legSymbols.has(gk.split("|")[0] ?? "")) {
            out.push(...this.classifySingleGroup(trades));
          }
        }
        return out;
      }
    }

    for (const trades of groups.values()) {
      out.push(...this.classifySingleGroup(trades));
    }
    return out;
  }

  private classifySingleGroup(trades: AnnotatedTrade[]): ClassifiedSignal[] {
    const exchanges = new Set(trades.map((t) => t.exchange));
    const anyIso = trades.some((t) => t.iso === true);
    const totalPremium = trades.reduce((s, t) => s + premiumOf(t.price, t.size), 0);
    const out: ClassifiedSignal[] = [];

    // SWEEP: multi-exchange fill cluster or ISO-flagged, meeting min premium.
    if ((exchanges.size >= 2 || anyIso) && totalPremium >= this.cfg.minSignalPremium) {
      const sig = this.buildSignal("SWEEP", [trades]);
      if (sig) out.push(sig);
      return out;
    }

    // BLOCK: a single print meeting size or premium threshold.
    const block = trades.find(
      (t) =>
        t.size >= this.cfg.blockMinSize ||
        premiumOf(t.price, t.size) >= this.cfg.blockMinPremium,
    );
    if (block) {
      const sig = this.buildSignal("BLOCK", [[block]]);
      if (sig) out.push(sig);
      const rest = trades.filter((t) => t !== block);
      if (rest.length > 0) this.feedSplitDetector(rest, out);
      return out;
    }

    // LARGE: single-exchange cluster that still clears min premium.
    if (totalPremium >= this.cfg.minSignalPremium) {
      const sig = this.buildSignal("LARGE", [trades]);
      if (sig) out.push(sig);
      return out;
    }

    // Below thresholds → candidate split prints.
    this.feedSplitDetector(trades, out);
    return out;
  }

  private feedSplitDetector(trades: AnnotatedTrade[], out: ClassifiedSignal[]): void {
    for (const t of trades) {
      const key = `${t.contract.symbol}|${sideBucket(t.side)}`;
      const buf = this.splitBuf.get(key) ?? [];
      buf.push(t);
      // Prune outside the rolling window.
      const cutoff = t.ts - this.cfg.splitWindowMs;
      const pruned = buf.filter((p) => p.ts >= cutoff);
      const sum = pruned.reduce((s, p) => s + premiumOf(p.price, p.size), 0);
      if (pruned.length >= this.cfg.splitMinPrints && sum >= this.cfg.splitMinPremium) {
        const sig = this.buildSignal("SPLIT", [pruned]);
        if (sig) out.push(sig);
        this.splitBuf.set(key, []); // consume — no re-fire on every next print
      } else {
        this.splitBuf.set(key, pruned);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Signal construction + scoring
  // -------------------------------------------------------------------------

  private buildSignal(
    kind: ClassifiedSignal["kind"],
    legTradeGroups: AnnotatedTrade[][],
  ): ClassifiedSignal | null {
    const legs: SignalLeg[] = legTradeGroups.map((trades) => {
      const totalSize = trades.reduce((s, t) => s + t.size, 0);
      const totalPremium = trades.reduce((s, t) => s + premiumOf(t.price, t.size), 0);
      const vwap = totalSize > 0
        ? trades.reduce((s, t) => s + t.price * t.size, 0) / totalSize
        : 0;
      const sides = new Set(trades.map((t) => sideBucket(t.side)));
      const side: InferredSide =
        sides.size === 1 ? (trades[0]?.side ?? "AMBIGUOUS") : "AMBIGUOUS";
      const c = trades[0];
      if (!c) throw new Error("empty leg group"); // unreachable by construction
      return {
        contract: c.contract,
        side,
        totalSize,
        totalPremium,
        vwap,
        prints: trades.length,
        exchanges: [...new Set(trades.map((t) => t.exchange))],
      };
    });

    const totalPremium = legs.reduce((s, l) => s + l.totalPremium, 0);
    if (kind === "MULTI_LEG" && totalPremium < this.cfg.minSignalPremium) return null;

    const totalSize = legs.reduce((s, l) => s + l.totalSize, 0);
    const allTrades = legTradeGroups.flat();
    const ts = Math.min(...allTrades.map((t) => t.ts));
    const iso = allTrades.some((t) => t.iso === true);

    const dominant = [...legs].sort((a, b) => b.totalPremium - a.totalPremium)[0];
    if (!dominant) return null;
    const side = dominant.side;
    const sideAmbiguous = sideBucket(side) === "AMBIGUOUS";

    const repeatKey = `${dominant.contract.symbol}|${sideBucket(side)}`;
    const repeats = this.repeatHits.get(repeatKey) ?? 0;

    const { score, breakdown } = scoreSignal({
      kind,
      totalPremium,
      totalSize,
      iso,
      sideAmbiguous,
      exchanges: new Set(allTrades.map((t) => t.exchange)).size,
      prints: allTrades.length,
      contract: dominant.contract,
      signalTs: ts,
      stats: this.statsLookup(dominant.contract.symbol),
      repeatHits: repeats,
    });

    this.repeatHits.set(repeatKey, repeats + 1);

    return {
      id: `sig_${++this.seq}_${ts}`,
      kind,
      ts,
      underlying: dominant.contract.underlying,
      side,
      legs,
      totalPremium,
      totalSize,
      iso,
      score,
      scoreBreakdown: breakdown,
      spreadGuess: kind === "MULTI_LEG" ? guessSpread(legs) : undefined,
      printIds: allTrades.map((t) => t.id),
      synthetic: this.cfg.syntheticSource,
    };
  }
}

function guessSpread(legs: SignalLeg[]): NonNullable<ClassifiedSignal["spreadGuess"]> {
  if (legs.length !== 2) return "UNKNOWN";
  const [a, b] = legs;
  if (!a || !b) return "UNKNOWN";
  const ca = a.contract, cb = b.contract;
  if (ca.right === cb.right && ca.expiry === cb.expiry && ca.strike !== cb.strike)
    return "VERTICAL";
  if (ca.right === cb.right && ca.strike === cb.strike && ca.expiry !== cb.expiry)
    return "CALENDAR";
  if (ca.right !== cb.right && ca.expiry === cb.expiry)
    return "STRADDLE_STRANGLE";
  return "UNKNOWN";
}
