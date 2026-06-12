/**
 * NBBO tracker + quote-rule side inference.
 *
 * Honesty contract: when the NBBO is missing or stale, side is AMBIGUOUS.
 * We never guess. Misclassified side is the #1 way flow tools lie.
 */
import { InferredSide, OptionQuoteEvent } from "./types.js";

interface NbboState {
  bid: number;
  ask: number;
  ts: number;
}

export class NbboBook {
  private book = new Map<string, NbboState>();

  onQuote(q: OptionQuoteEvent): void {
    if (q.bid < 0 || q.ask <= 0 || (q.bid > 0 && q.ask < q.bid)) return; // crossed/garbage
    this.book.set(q.contractSymbol, { bid: q.bid, ask: q.ask, ts: q.ts });
  }

  get(contractSymbol: string): NbboState | undefined {
    return this.book.get(contractSymbol);
  }

  /**
   * Quote-rule side inference.
   *  - at/above ask  → BUY
   *  - at/below bid  → SELL
   *  - inside spread → BUY_LEAN / SELL_LEAN by mid distance
   *  - exactly mid, no NBBO, or stale NBBO → AMBIGUOUS
   */
  inferSide(
    contractSymbol: string,
    price: number,
    tradeTs: number,
    maxAgeMs: number,
  ): InferredSide {
    const nbbo = this.book.get(contractSymbol);
    if (!nbbo) return "AMBIGUOUS";
    if (tradeTs - nbbo.ts > maxAgeMs) return "AMBIGUOUS";

    const epsilon = 1e-9;
    if (price >= nbbo.ask - epsilon) return "BUY";
    if (price <= nbbo.bid + epsilon) return "SELL";

    const mid = (nbbo.bid + nbbo.ask) / 2;
    if (Math.abs(price - mid) < epsilon) return "AMBIGUOUS";
    return price > mid ? "BUY_LEAN" : "SELL_LEAN";
  }
}

/** Collapse a side to its directional bucket for clustering. */
export function sideBucket(side: InferredSide): "BUY" | "SELL" | "AMBIGUOUS" {
  if (side === "BUY" || side === "BUY_LEAN") return "BUY";
  if (side === "SELL" || side === "SELL_LEAN") return "SELL";
  return "AMBIGUOUS";
}
