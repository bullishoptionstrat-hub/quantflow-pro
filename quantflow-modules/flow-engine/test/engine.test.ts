/**
 * Flow Engine verification suite — node:test, zero test dependencies.
 * Run: npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { FlowEngine } from "../src/engine.js";
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
