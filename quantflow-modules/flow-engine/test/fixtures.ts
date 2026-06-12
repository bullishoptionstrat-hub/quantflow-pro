/**
 * SYNTHETIC TEST FIXTURES — not market data.
 *
 * Deterministic OPRA-shaped events for engine verification. Every engine
 * configured with syntheticSource=true stamps synthetic=true on its output;
 * nothing produced from these fixtures may ever be presented as live flow.
 */
import {
  OptionContract,
  OptionQuoteEvent,
  OptionTradeEvent,
} from "../src/types.js";

export const T0 = Date.parse("2026-06-10T14:30:00Z"); // 10:30 ET

let seq = 0;
export function resetSeq(): void { seq = 0; }

export function contract(
  underlying: string,
  right: "C" | "P",
  strike: number,
  expiry = "2026-06-19",
): OptionContract {
  const strikeStr = String(Math.round(strike * 1000)).padStart(8, "0");
  const exp = expiry.replaceAll("-", "").slice(2);
  return {
    symbol: `${underlying}${exp}${right}${strikeStr}`,
    underlying, right, strike, expiry,
  };
}

export function quote(
  c: OptionContract, ts: number, bid: number, ask: number,
): OptionQuoteEvent {
  return { ts, contractSymbol: c.symbol, bid, ask };
}

export function trade(
  c: OptionContract,
  ts: number,
  price: number,
  size: number,
  exchange: string,
  opts: { iso?: boolean; conditions?: number[] } = {},
): OptionTradeEvent {
  return {
    id: `syn_${++seq}`,
    ts,
    contract: c,
    price,
    size,
    exchange,
    conditions: opts.conditions ?? [],
    iso: opts.iso ?? false,
  };
}

/** A buy-side sweep: same contract lifted at the ask across 3 exchanges in 60ms. */
export function buySweepScenario(c: OptionContract) {
  return {
    quotes: [quote(c, T0 - 50, 4.90, 5.00)],
    trades: [
      trade(c, T0,      5.00, 200, "CBOE"),
      trade(c, T0 + 20, 5.00, 150, "PHLX"),
      trade(c, T0 + 55, 5.05, 300, "AMEX"),
    ],
  };
}

/** A single 500-lot hit on the bid: sell-side block. */
export function sellBlockScenario(c: OptionContract) {
  return {
    quotes: [quote(c, T0 - 40, 3.10, 3.25)],
    trades: [trade(c, T0, 3.10, 500, "CBOE")],
  };
}

/** Six 20-lot prints at the ask over ~3 minutes: split order. */
export function splitScenario(c: OptionContract) {
  const quotes: OptionQuoteEvent[] = [];
  const trades: OptionTradeEvent[] = [];
  for (let i = 0; i < 6; i++) {
    const ts = T0 + i * 30_000;
    quotes.push(quote(c, ts - 100, 8.40, 8.50));
    trades.push(trade(c, ts, 8.50, 20, "CBOE"));
  }
  return { quotes, trades };
}

/** Two legs same millisecond, different strikes, same expiry: vertical. */
export function verticalSpreadScenario(low: OptionContract, high: OptionContract) {
  return {
    quotes: [
      quote(low,  T0 - 30, 6.00, 6.10),
      quote(high, T0 - 30, 3.00, 3.10),
    ],
    trades: [
      trade(low,  T0,     6.10, 300, "CBOE"), // buy leg (at ask)
      trade(high, T0 + 5, 3.00, 300, "CBOE"), // sell leg (at bid)
    ],
  };
}

/** Mid-print with stale NBBO: side must be AMBIGUOUS. */
export function ambiguousScenario(c: OptionContract) {
  return {
    quotes: [quote(c, T0 - 10_000, 2.00, 2.20)], // stale (>2s before trade)
    trades: [trade(c, T0, 2.10, 400, "CBOE")],
  };
}
