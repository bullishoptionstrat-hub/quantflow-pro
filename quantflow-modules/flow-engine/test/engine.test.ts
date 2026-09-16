/**
 * Flow Engine verification suite — node:test, zero test dependencies.
 * Run: npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { FlowEngine } from "../src/engine.js";
import { NbboBook } from "../src/nbbo.js";
import { scoreSignal } from "../src/score.js";
import { ClassifiedSignal, ContractStats } from "../src/types.js";
import {
  ambiguousScenario,
  buySweepScenario,
  contract,
  resetSeq,
  sellBlockScenario,
  splitScenario,
  T0,
  trade,
  quote,
  verticalSpreadScenario,
} from "./fixtures.js";

function run(
  scenario: { quotes: ReturnType<typeof quote>[]; trades: ReturnType<typeof trade>[] },
  stats?: Record<string, ContractStats>,
): ClassifiedSignal[] {
  resetSeq();
  const engine = new FlowEngine(
    { syntheticSource: true },
    (sym) => stats?.[sym],
  );
  const events = [
    ...scenario.quotes.map((q) => ({ ts: q.ts, kind: "Q" as const, q })),
    ...scenario.trades.map((t) => ({ ts: t.ts, kind: "T" as const, t })),
  ].sort((a, b) => a.ts - b.ts || (a.kind === "Q" ? -1 : 1));

  const out: ClassifiedSignal[] = [];
  for (const e of events) {
    if (e.kind === "Q") engine.onQuote(e.q);
    else out.push(...engine.onTrade(e.t));
  }
  out.push(...engine.flush());
  return out;
}

test("buy-side sweep: 3 exchanges at the ask → SWEEP / BUY / correct premium", () => {
  const c = contract("SPY", "C", 550);
  const signals = run(buySweepScenario(c));
  assert.equal(signals.length, 1);
  const s = signals[0]!;
  assert.equal(s.kind, "SWEEP");
  assert.equal(s.side, "BUY");
  assert.equal(s.totalSize, 650);
  // 200*5.00 + 150*5.00 + 300*5.05 = 1750 + 1515 = 3265 contracts*$ → *100
  assert.equal(s.totalPremium, 326_500);
  assert.equal(s.legs[0]!.exchanges.length, 3);
  assert.equal(s.synthetic, true);
  assert.equal(s.printIds.length, 3);
});

test("single 500-lot on the bid → BLOCK / SELL", () => {
  const c = contract("QQQ", "P", 480);
  const signals = run(sellBlockScenario(c));
  assert.equal(signals.length, 1);
  const s = signals[0]!;
  assert.equal(s.kind, "BLOCK");
  assert.equal(s.side, "SELL");
  assert.equal(s.totalPremium, 155_000);
});

test("six 20-lot prints over 3 minutes at the ask → SPLIT / BUY", () => {
  const c = contract("NVDA", "C", 1300);
  const signals = run(splitScenario(c));
  const split = signals.find((s) => s.kind === "SPLIT");
  assert.ok(split, "expected a SPLIT signal");
  assert.equal(split.side, "BUY");
  // Fires at the 5th print — the moment thresholds (5 prints, ≥$50k) are met.
  assert.equal(split.totalSize, 100);
  assert.equal(split.totalPremium, 85_000); // 100 * 8.50 * 100
  assert.equal(split.legs[0]!.prints, 5);
});

test("two legs same ms, different strikes → MULTI_LEG VERTICAL, no single-leg leak", () => {
  const low = contract("SPY", "C", 550);
  const high = contract("SPY", "C", 560);
  const signals = run(verticalSpreadScenario(low, high));
  assert.equal(signals.length, 1, "exactly one signal — legs must not emit separately");
  const s = signals[0]!;
  assert.equal(s.kind, "MULTI_LEG");
  assert.equal(s.spreadGuess, "VERTICAL");
  assert.equal(s.legs.length, 2);
  const sides = s.legs.map((l) => l.side).sort();
  assert.deepEqual(sides, ["BUY", "SELL"]);
});

test("stale NBBO → side AMBIGUOUS and score penalized", () => {
  const c = contract("TSLA", "P", 300);
  const signals = run(ambiguousScenario(c));
  assert.equal(signals.length, 1);
  const s = signals[0]!;
  assert.equal(s.side, "AMBIGUOUS");
  assert.equal(s.scoreBreakdown.ambiguousPenalty, -15);
});

test("below minimum premium → no signal emitted", () => {
  const c = contract("AAPL", "C", 260);
  const signals = run({
    quotes: [quote(c, T0 - 50, 1.00, 1.05)],
    trades: [trade(c, T0, 1.05, 10, "CBOE")], // $1,050 premium
  });
  assert.equal(signals.length, 0);
});

test("vol > OI boosts score (likely opening position)", () => {
  const c = contract("SPY", "C", 550);
  const base = run(buySweepScenario(c))[0]!;
  const boosted = run(buySweepScenario(c), {
    [c.symbol]: { openInterest: 100, dayVolume: 0, underlyingPrice: 540 },
  })[0]!;
  assert.equal(boosted.scoreBreakdown.volOverOi, 20);
  assert.ok(boosted.score > base.score, "vol>OI must raise the score");
});

test("repeat hits on same contract+side raise later scores", () => {
  const c = contract("SPY", "C", 550);
  resetSeq();
  const engine = new FlowEngine({ syntheticSource: true });
  const s1 = buySweepScenario(c);
  const out: ClassifiedSignal[] = [];
  for (const q of s1.quotes) engine.onQuote(q);
  for (const t of s1.trades) out.push(...engine.onTrade(t));
  out.push(...engine.flush());

  // Second identical sweep 10 minutes later.
  const later = 10 * 60_000;
  engine.onQuote(quote(c, T0 + later - 50, 4.90, 5.00));
  const out2: ClassifiedSignal[] = [];
  for (const t of s1.trades) {
    out2.push(...engine.onTrade({ ...t, id: `${t.id}_b`, ts: t.ts + later }));
  }
  out2.push(...engine.flush());

  assert.equal(out[0]!.scoreBreakdown.repeats, 0);
  assert.equal(out2[0]!.scoreBreakdown.repeats, 3); // 1 prior hit
  assert.ok(out2[0]!.score > out[0]!.score);
});

test("every signal carries a complete audit trail of print ids", () => {
  const c = contract("SPY", "C", 550);
  resetSeq(); // ids are assigned at fixture construction time
  const signals = run(buySweepScenario(c));
  assert.deepEqual(signals[0]!.printIds, ["syn_1", "syn_2", "syn_3"]);
});

// ─── Look-ahead ─────────────────────────────────────────────────────────────

/**
 * A quote timestamped after the trade must never infer a side.
 *
 * `inferSide` gated staleness with `tradeTs - nbbo.ts > maxAgeMs`. That is a
 * subtraction, so a quote stamped AFTER the trade produces a negative age and
 * passes — the engine would read the side of a print off an NBBO that may
 * already reflect that very print. Nothing exercised it while every quote
 * arrived carrying its own trade's timestamp, but an independent quote feed
 * (a Polygon NBBO poll, a replay with interleaved quotes) walks straight in.
 *
 * This is the same class of error as measuring an outcome from `ClassifiedSignal.ts`
 * instead of `decisionAt`: information that did not exist at decision time,
 * handed to the decision for free, and every result comes out flattering.
 */
test("a quote from after the trade is not evidence about it", () => {
  const book = new NbboBook();
  const sym = "SPY260918C00500000";

  // Quote lands one millisecond after the print.
  book.onQuote({ ts: T0 + 1, contractSymbol: sym, bid: 1.00, ask: 1.10 });

  // At the ask — would read BUY if the future quote were allowed.
  assert.equal(
    book.inferSide(sym, 1.10, T0, 2_000), "AMBIGUOUS",
    "a later quote must not give a trade its direction",
  );
});

test("a quote from well after the trade is refused however wide the age window", () => {
  const book = new NbboBook();
  const sym = "SPY260918C00500000";
  book.onQuote({ ts: T0 + 60_000, contractSymbol: sym, bid: 1.00, ask: 1.10 });
  // A generous maxAge must not become a licence to look forward.
  assert.equal(book.inferSide(sym, 1.10, T0, 3_600_000), "AMBIGUOUS");
});

test("a quote at exactly the trade timestamp is still usable", () => {
  // The boundary the fix must not break: every existing source publishes the
  // NBBO stamped with its own trade's timestamp, so `nbbo.ts === tradeTs` is
  // the normal case, not an edge one.
  const book = new NbboBook();
  const sym = "SPY260918C00500000";
  book.onQuote({ ts: T0, contractSymbol: sym, bid: 1.00, ask: 1.10 });
  assert.equal(book.inferSide(sym, 1.10, T0, 2_000), "BUY");
  assert.equal(book.inferSide(sym, 1.00, T0, 2_000), "SELL");
});

test("a quote from before the trade still ages out normally", () => {
  const book = new NbboBook();
  const sym = "SPY260918C00500000";
  book.onQuote({ ts: T0 - 5_000, contractSymbol: sym, bid: 1.00, ask: 1.10 });
  assert.equal(
    book.inferSide(sym, 1.10, T0, 2_000), "AMBIGUOUS",
    "5s old against a 2s window is stale",
  );
  assert.equal(
    book.inferSide(sym, 1.10, T0, 10_000), "BUY",
    "the same quote inside a wider window is fine",
  );
});

// ---------------------------------------------------------------------------
// The score reconciles with its own breakdown
// ---------------------------------------------------------------------------

/**
 * `scoreBreakdown` is rendered term by term under the heat number on the power
 * alerts page, so the terms have to add up to the number beside them.
 *
 * The clamp used to be applied silently. Components floor at `premium: 3` and
 * the ambiguous penalty is -15, so a low-premium signal whose side could not
 * be inferred produced a breakdown summing to **-12** against a score of 0.
 */
test("every breakdown sums to the score it is published with", () => {
  const contract = { symbol: "SPY_C610", underlying: "SPY", right: "C" as const, strike: 610, expiry: "2026-12-18" };
  const kinds = ["SWEEP", "BLOCK", "SPLIT", "MULTI_LEG", "LARGE"] as const;
  let sawClamp = false;

  for (const kind of kinds) {
    for (const totalPremium of [1_000, 60_000, 300_000, 2_000_000]) {
      for (const sideAmbiguous of [false, true]) {
        for (const exchanges of [1, 3]) {
          for (const repeatHits of [0, 5]) {
            const { score, breakdown } = scoreSignal({
              kind, totalPremium, totalSize: 10, iso: exchanges > 1,
              sideAmbiguous, exchanges, prints: 1, contract,
              signalTs: Date.parse("2026-12-17T15:00:00Z"), repeatHits,
            });
            const sum = Object.values(breakdown).reduce((a, v) => a + v, 0);
            assert.equal(sum, score,
              `${kind} $${totalPremium} ambiguous=${sideAmbiguous}: terms sum to ${sum}, score is ${score}`);
            assert.ok(score >= 0 && score <= 100, `score ${score} out of range`);
            if (breakdown.clamp !== undefined) sawClamp = true;
          }
        }
      }
    }
  }

  assert.ok(sawClamp, "the matrix should reach the clamped case, or it proves nothing");
});

test("the clamped case is the low-premium ambiguous signal, and it is named", () => {
  const { score, breakdown } = scoreSignal({
    kind: "LARGE", totalPremium: 1_000, totalSize: 1, iso: false,
    sideAmbiguous: true, exchanges: 1, prints: 1,
    contract: { symbol: "SPY_C610", underlying: "SPY", right: "C", strike: 610, expiry: "2027-06-18" },
    signalTs: Date.parse("2026-12-17T15:00:00Z"),
  });
  assert.equal(breakdown.premium, 3);
  assert.equal(breakdown.ambiguousPenalty, -15);
  assert.equal(breakdown.clamp, 12, "the floor is shown, not swallowed");
  assert.equal(score, 0);
});

test("a signal that needs no clamp carries no clamp term", () => {
  const { score, breakdown } = scoreSignal({
    kind: "SWEEP", totalPremium: 2_000_000, totalSize: 500, iso: true,
    sideAmbiguous: false, exchanges: 4, prints: 6,
    contract: { symbol: "SPY_C610", underlying: "SPY", right: "C", strike: 610, expiry: "2026-12-18" },
    signalTs: Date.parse("2026-12-17T15:00:00Z"), repeatHits: 5,
  });
  assert.equal(breakdown.clamp, undefined);
  assert.equal(Object.values(breakdown).reduce((a, v) => a + v, 0), score);
});

// ─── Structure naming: what two legs are, and when it refuses to say ─────────
//
// A call and a put at one expiry were ALL labelled STRADDLE_STRANGLE. That is
// only right when both legs are on the same side. A long call against a SHORT
// put is a risk reversal — a directional bet financed by selling the other
// wing — and it is the opposite kind of position from a long strangle, which
// is a bet on movement in either direction. One label was covering two views
// that disagree about direction.

/** Drive one two-leg structure and return the engine's verdict. */
function structure(
  legs: Array<{
    right: "C" | "P"; strike: number; expiry?: string;
    at: "bid" | "ask" | "mid" | "leanBuy" | "leanSell";
  }>,
): ClassifiedSignal {
  resetSeq();
  const engine = new FlowEngine({}, () => undefined, () => T0 + 50);
  const built = legs.map((l) => contract("SPY", l.right, l.strike, l.expiry));
  built.forEach((c) =>
    engine.onQuote({ contractSymbol: c.symbol, bid: 1.0, ask: 2.0, ts: T0 - 10 }));

  const out: ClassifiedSignal[] = [];
  legs.forEach((l, i) => {
    // At the ask reads BUY, at the bid SELL, at the mid AMBIGUOUS — the
    // engine's own quote rule, not a flag set by this test.
    const price =
      l.at === "ask" ? 2.0
      : l.at === "bid" ? 1.0
      : l.at === "leanBuy" ? 1.8    // above mid, inside the spread
      : l.at === "leanSell" ? 1.2   // below mid, inside the spread
      : 1.5;
    out.push(...engine.onTrade({
      id: `t${i}`, ts: T0 + i, price, size: 200, exchange: "CBOE",
      conditions: [], contract: built[i]!,
    }));
  });
  out.push(...engine.flush());
  return out.find((s) => s.kind === "MULTI_LEG")!;
}

test("a call bought against a put sold is a risk reversal", () => {
  const sig = structure([
    { right: "C", strike: 620, at: "ask" },
    { right: "P", strike: 600, at: "bid" },
  ]);
  assert.equal(sig.spreadGuess, "RISK_REVERSAL");
  assert.deepEqual(sig.legs.map((l) => l.side).sort(), ["BUY", "SELL"]);
});

test("a call and a put both bought is a strangle, not a reversal", () => {
  // The distinction the old rule could not make. Both long is a bet on
  // movement either way; long one and short the other is a bet on direction.
  const sig = structure([
    { right: "C", strike: 620, at: "ask" },
    { right: "P", strike: 600, at: "ask" },
  ]);
  assert.equal(sig.spreadGuess, "STRADDLE_STRANGLE");
});

test("both legs sold is also a straddle/strangle, from the other side", () => {
  const sig = structure([
    { right: "C", strike: 620, at: "bid" },
    { right: "P", strike: 600, at: "bid" },
  ]);
  assert.equal(sig.spreadGuess, "STRADDLE_STRANGLE");
});

test("an AMBIGUOUS leg makes the structure unnameable, not guessable", () => {
  // The load-bearing case. The engine refuses to infer a side without a fresh
  // NBBO, and a structure defined by whether its legs oppose each other cannot
  // be named from a leg with no polarity. Naming it anyway would put a
  // directional label on a position whose direction the engine has already
  // declined to state.
  const sig = structure([
    { right: "C", strike: 620, at: "ask" },
    { right: "P", strike: 600, at: "mid" },
  ]);
  assert.ok(sig.legs.some((l) => l.side === "AMBIGUOUS"), "the premise");
  assert.equal(sig.spreadGuess, "UNKNOWN");
});

test("same-right structures are unaffected by side", () => {
  // Verticals and calendars are named by their contracts alone. Routing them
  // through the polarity check would make a spread with one ambiguous leg
  // unnameable for no reason — its name never depended on direction.
  const vertical = structure([
    { right: "C", strike: 620, at: "ask" },
    { right: "C", strike: 630, at: "mid" },
  ]);
  assert.equal(vertical.spreadGuess, "VERTICAL");

  const calendar = structure([
    { right: "C", strike: 620, at: "ask" },
    { right: "C", strike: 620, expiry: "2026-07-17", at: "mid" },
  ]);
  assert.equal(calendar.spreadGuess, "CALENDAR");
});

test("a lean counts as its direction, and the reason is that it is priced once", () => {
  // A deliberate decision, and it needs a guard or it is only a comment. A
  // `*_LEAN` already encodes a direction, just less confidently — and that
  // confidence is already priced, because the ambiguity penalty lives in the
  // score. Discounting it a second time here would double-count one
  // uncertainty and make most real two-sided structures unnameable.
  const reversal = structure([
    { right: "C", strike: 620, at: "leanBuy" },
    { right: "P", strike: 600, at: "leanSell" },
  ]);
  assert.deepEqual(reversal.legs.map((l) => l.side).sort(), ["BUY_LEAN", "SELL_LEAN"]);
  assert.equal(reversal.spreadGuess, "RISK_REVERSAL");

  // And two leans the same way are still a strangle, not a reversal.
  const strangle = structure([
    { right: "C", strike: 620, at: "leanBuy" },
    { right: "P", strike: 600, at: "leanBuy" },
  ]);
  assert.equal(strangle.spreadGuess, "STRADDLE_STRANGLE");

  // A lean against a firm side is still opposition.
  const mixed = structure([
    { right: "C", strike: 620, at: "ask" },
    { right: "P", strike: 600, at: "leanSell" },
  ]);
  assert.equal(mixed.spreadGuess, "RISK_REVERSAL");
});
