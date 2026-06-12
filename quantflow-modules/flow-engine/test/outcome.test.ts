/**
 * Outcome Tracker verification — synthetic price paths, deterministic.
 * Run: npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { FlowEngine } from "../src/engine.js";
import { OutcomeTracker, buildReport } from "../src/outcome/tracker.js";
import {
  InMemoryOutcomeStore,
  PriceLookup,
} from "../src/outcome/types.js";
import { ClassifiedSignal } from "../src/types.js";
import { buySweepScenario, contract, resetSeq, T0 } from "./fixtures.js";

/** Produce one real engine signal to feed the tracker. */
function makeSignal(): ClassifiedSignal {
  resetSeq();
  const engine = new FlowEngine({ syntheticSource: true });
  const c = contract("SPY", "C", 550);
  const sc = buySweepScenario(c);
  for (const q of sc.quotes) engine.onQuote(q);
  const out: ClassifiedSignal[] = [];
  for (const t of sc.trades) out.push(...engine.onTrade(t));
  out.push(...engine.flush());
  const sig = out[0];
  if (!sig) throw new Error("fixture produced no signal");
  return sig;
}

/** Price path: contract mark by time offset; underlying drifts up. */
function pathLookup(marks: Record<number, number>, entryMark: number): PriceLookup {
  return async ({ ts }) => {
    const offset = ts - T0;
    const contractMark = offset <= 0 ? entryMark : marks[offset];
    const underlyingPrice = 550 + (offset / 3_600_000) * 1.5; // +$1.5/h drift
    return { contractMark, underlyingPrice };
  };
}

const M15 = 15 * 60_000, H1 = 60 * 60_000, D1 = 24 * 60 * 60_000;

test("winner: +30% by H1 → POSITIVE, direction correct at D1", async () => {
  const sig = makeSignal();
  const store = new InMemoryOutcomeStore();
  const tracker = new OutcomeTracker(
    store,
    pathLookup({ [M15]: 5.20, [H1]: 6.60, [D1]: 6.00 }, 5.00),
    { maxExpiryHorizonMs: 0 }, // skip EXPIRY for a tight 3-checkpoint test
  );

  const tracked = await tracker.register(sig);
  assert.equal(tracked.impliedDirection, "BULLISH"); // BUY calls
  assert.equal(tracked.entry.contractMark, 5.00);
  assert.equal(tracked.checkpoints.length, 3);

  // Nothing due yet.
  assert.equal((await tracker.evaluateDue(sig.ts + M15 - 1)).length, 0);

  // Advance past D1 → all checkpoints fill, label assigned.
  const closed = await tracker.evaluateDue(sig.ts + D1 + 1);
  assert.equal(closed.length, 1);
  const t = closed[0]!;
  assert.equal(t.finalLabel, "POSITIVE"); // 6.60/5.00 = +32% ≥ +25%
  assert.equal(t.directionCorrectAtD1, true); // underlying drifted up
  const h1 = t.checkpoints.find((c) => c.key === "H1")!;
  assert.ok(Math.abs((h1.contractReturnPct ?? 0) - 0.32) < 1e-9);
});

test("loser: bleeds to −40% with no positive checkpoint → NEGATIVE", async () => {
  const sig = makeSignal();
  const store = new InMemoryOutcomeStore();
  const tracker = new OutcomeTracker(
    store,
    pathLookup({ [M15]: 4.60, [H1]: 4.00, [D1]: 3.00 }, 5.00),
    { maxExpiryHorizonMs: 0 },
  );
  await tracker.register(sig);
  const closed = await tracker.evaluateDue(sig.ts + D1 + 1);
  assert.equal(closed[0]!.finalLabel, "NEGATIVE"); // min −40% ≤ −25%
});

test("chop: never beyond ±25% → NEUTRAL", async () => {
  const sig = makeSignal();
  const store = new InMemoryOutcomeStore();
  const tracker = new OutcomeTracker(
    store,
    pathLookup({ [M15]: 5.10, [H1]: 4.80, [D1]: 5.05 }, 5.00),
    { maxExpiryHorizonMs: 0 },
  );
  await tracker.register(sig);
  const closed = await tracker.evaluateDue(sig.ts + D1 + 1);
  assert.equal(closed[0]!.finalLabel, "NEUTRAL");
});

test("no entry mark available → UNGRADED, never guessed", async () => {
  const sig = makeSignal();
  const store = new InMemoryOutcomeStore();
  const tracker = new OutcomeTracker(
    store,
    async () => ({ contractMark: undefined, underlyingPrice: undefined }),
    { maxExpiryHorizonMs: 0 },
  );
  await tracker.register(sig);
  const closed = await tracker.evaluateDue(sig.ts + D1 + 1);
  assert.equal(closed[0]!.finalLabel, "UNGRADED");
  assert.equal(closed[0]!.directionCorrectAtD1, undefined);
});

test("report aggregates honestly: hit rate excludes UNGRADED but counts it", async () => {
  const store = new InMemoryOutcomeStore();

  const runOne = async (marks: Record<number, number> | null) => {
    const sig = makeSignal();
    sig.id = `sig_${Math.random().toString(36).slice(2)}`;
    const tracker = new OutcomeTracker(
      store,
      marks
        ? pathLookup(marks, 5.00)
        : async () => ({}),
      { maxExpiryHorizonMs: 0 },
    );
    await tracker.register(sig);
    await tracker.evaluateDue(sig.ts + D1 + 1);
  };

  await runOne({ [M15]: 6.60, [H1]: 6.60, [D1]: 6.60 }); // POSITIVE
  await runOne({ [M15]: 3.00, [H1]: 3.00, [D1]: 3.00 }); // NEGATIVE
  await runOne({ [M15]: 5.05, [H1]: 5.05, [D1]: 5.05 }); // NEUTRAL
  await runOne(null);                                     // UNGRADED

  const report = buildReport(await store.all());
  assert.equal(report.length, 1);
  const r = report[0]!;
  assert.equal(r.kind, "SWEEP");
  assert.equal(r.total, 4);
  assert.equal(r.positive, 1);
  assert.equal(r.negative, 1);
  assert.equal(r.neutral, 1);
  assert.equal(r.ungraded, 1);
  assert.ok(Math.abs((r.hitRate ?? 0) - 1 / 3) < 1e-9);
});
