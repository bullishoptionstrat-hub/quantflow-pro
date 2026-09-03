/**
 * Outcome Tracker verification — synthetic price paths, deterministic.
 * Run: npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { FlowEngine } from "../src/engine.js";
import { OutcomeTracker, buildReport } from "../src/outcome/tracker.js";
import {
  CHECKPOINT_OFFSETS_MS,
  decisionTimeOf,
  dominantLegOf,
  impliedDirectionOf,
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

/**
 * Price path: contract mark by time offset from the signal's **decision
 * time**; underlying drifts up.
 *
 * Keyed off `decisionTimeOf(sig)` rather than `T0`, because that is the origin
 * every horizon now runs from. `T0` is the fixture's first print, and the
 * tracker used to measure from `signal.ts` — the same first print — which
 * credited the horizon with the burst duration and the pipeline latency for
 * free.
 */
function pathLookup(
  origin: number,
  marks: Record<number, number>,
  entryMark: number,
): PriceLookup {
  return async ({ ts }) => {
    const offset = ts - origin;
    const contractMark = offset <= 0 ? entryMark : marks[offset];
    const underlyingPrice = 550 + (offset / 3_600_000) * 1.5; // +$1.5/h drift
    return { contractMark, underlyingPrice };
  };
}

const M15 = 15 * 60_000, H1 = 60 * 60_000, D1 = 24 * 60 * 60_000;

test("winner: +30% by H1 → POSITIVE, direction correct at D1", async () => {
  const sig = makeSignal();
  const origin = decisionTimeOf(sig).at;
  const store = new InMemoryOutcomeStore();
  const tracker = new OutcomeTracker(
    store,
    pathLookup(origin, { [M15]: 5.20, [H1]: 6.60, [D1]: 6.00 }, 5.00),
    { maxExpiryHorizonMs: 0 }, // skip EXPIRY for a tight 3-checkpoint test
  );

  const tracked = await tracker.register(sig);
  assert.equal(tracked.impliedDirection, "BULLISH"); // BUY calls
  assert.equal(tracked.entry.contractMark, 5.00);
  assert.equal(tracked.checkpoints.length, 3);

  // Nothing due yet.
  assert.equal((await tracker.evaluateDue(origin + M15 - 1)).length, 0);

  // Advance past D1 → all checkpoints fill, label assigned.
  const closed = await tracker.evaluateDue(origin + D1 + 1);
  assert.equal(closed.length, 1);
  const t = closed[0]!;
  assert.equal(t.finalLabel, "POSITIVE"); // 6.60/5.00 = +32% ≥ +25%
  assert.equal(t.directionCorrectAtD1, true); // underlying drifted up
  const h1 = t.checkpoints.find((c) => c.key === "H1")!;
  assert.ok(Math.abs((h1.contractReturnPct ?? 0) - 0.32) < 1e-9);
});

test("loser: bleeds to −40% with no positive checkpoint → NEGATIVE", async () => {
  const sig = makeSignal();
  const origin = decisionTimeOf(sig).at;
  const store = new InMemoryOutcomeStore();
  const tracker = new OutcomeTracker(
    store,
    pathLookup(origin, { [M15]: 4.60, [H1]: 4.00, [D1]: 3.00 }, 5.00),
    { maxExpiryHorizonMs: 0 },
  );
  await tracker.register(sig);
  const closed = await tracker.evaluateDue(origin + D1 + 1);
  assert.equal(closed[0]!.finalLabel, "NEGATIVE"); // min −40% ≤ −25%
});

test("chop: never beyond ±25% → NEUTRAL", async () => {
  const sig = makeSignal();
  const origin = decisionTimeOf(sig).at;
  const store = new InMemoryOutcomeStore();
  const tracker = new OutcomeTracker(
    store,
    pathLookup(origin, { [M15]: 5.10, [H1]: 4.80, [D1]: 5.05 }, 5.00),
    { maxExpiryHorizonMs: 0 },
  );
  await tracker.register(sig);
  const closed = await tracker.evaluateDue(origin + D1 + 1);
  assert.equal(closed[0]!.finalLabel, "NEUTRAL");
});

test("no entry mark available → UNGRADED, never guessed", async () => {
  const sig = makeSignal();
  const origin = decisionTimeOf(sig).at;
  const store = new InMemoryOutcomeStore();
  const tracker = new OutcomeTracker(
    store,
    async () => ({ contractMark: undefined, underlyingPrice: undefined }),
    { maxExpiryHorizonMs: 0 },
  );
  await tracker.register(sig);
  const closed = await tracker.evaluateDue(origin + D1 + 1);
  assert.equal(closed[0]!.finalLabel, "UNGRADED");
  assert.equal(closed[0]!.directionCorrectAtD1, undefined);
});

test("report aggregates honestly: hit rate excludes UNGRADED but counts it", async () => {
  const store = new InMemoryOutcomeStore();

  const runOne = async (marks: Record<number, number> | null) => {
    const sig = makeSignal();
  const origin = decisionTimeOf(sig).at;
    sig.id = `sig_${Math.random().toString(36).slice(2)}`;
    const tracker = new OutcomeTracker(
      store,
      marks
        ? pathLookup(origin, marks, 5.00)
        : async () => ({}),
      { maxExpiryHorizonMs: 0 },
    );
    await tracker.register(sig);
    await tracker.evaluateDue(origin + D1 + 1);
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

// ---------------------------------------------------------------------------
// The dominant leg
// ---------------------------------------------------------------------------

/**
 * A bullish risk reversal graded as BEARISH.
 *
 * `buildSignal` takes `ClassifiedSignal.side` from the highest-premium leg but
 * stores `legs` in the order their contract+side groups were first seen. The
 * tracker read `legs[0]` and paired it with `signal.side`, so whenever a
 * MULTI_LEG's small leg printed first the two described different contracts.
 *
 * Single-leg signals are unaffected, which is why this survived: it is only
 * wrong on the structures whose direction is hardest to read by eye.
 */
test("a MULTI_LEG is graded on the leg its side came from", async () => {
  resetSeq();
  const engine = new FlowEngine({}, () => undefined, () => T0 + 50);

  const put = contract("SPY", "P", 600);
  const call = contract("SPY", "C", 620);
  engine.onQuote({ contractSymbol: put.symbol, bid: 1.00, ask: 1.10, ts: T0 - 10 });
  engine.onQuote({ contractSymbol: call.symbol, bid: 5.00, ask: 5.10, ts: T0 - 10 });

  const out: ClassifiedSignal[] = [];
  // The small put prints first; the large call follows inside the leg window.
  out.push(...engine.onTrade({ id: "p1", ts: T0, price: 1.10, size: 20, exchange: "CBOE", conditions: [], contract: put }));
  out.push(...engine.onTrade({ id: "c1", ts: T0 + 5, price: 5.10, size: 200, exchange: "CBOE", conditions: [], contract: call }));
  out.push(...engine.flush());

  const sig = out.find((s) => s.kind === "MULTI_LEG");
  assert.ok(sig, "fixture should produce a MULTI_LEG");

  // The premises: the first leg is not the dominant one, and `side` came from
  // the dominant one. Without both, this test proves nothing.
  assert.equal(sig.legs[0]?.contract.right, "P", "the small put printed first");
  assert.equal(dominantLegOf(sig)?.contract.right, "C", "the large call is dominant");
  assert.equal(sig.side, "BUY");

  // `impliedDirectionOf(BUY, 'P')` is BEARISH — what the tracker used to
  // compute, on a position that is plainly bullish.
  assert.equal(impliedDirectionOf(sig.side, "P"), "BEARISH");

  const tracker = new OutcomeTracker(
    new InMemoryOutcomeStore(),
    async () => ({ contractMark: 5.10, underlyingPrice: 610 }),
    { maxExpiryHorizonMs: 0 },
  );
  const tracked = await tracker.register(sig);
  assert.equal(tracked.impliedDirection, "BULLISH",
    "a bought call alongside a small put is a bullish structure");
});

test("the measurement origin is the decision time, not the first print", async () => {
  // `signal.ts` is the FIRST print in the cluster. A signal assembled from a
  // burst was not actionable at that burst's first tick, so measuring from
  // there hands the horizon the burst duration plus the feed latency for free.
  const sig = makeSignal();
  const decision = decisionTimeOf(sig);
  assert.ok(decision.at >= sig.lastTs, "never earlier than the last forming print");
  assert.ok(decision.at >= sig.ts);

  const tracker = new OutcomeTracker(
    new InMemoryOutcomeStore(),
    async () => ({ contractMark: 5, underlyingPrice: 550 }),
    { maxExpiryHorizonMs: 0 },
  );
  const tracked = await tracker.register(sig);
  assert.equal(tracked.decision.at, decision.at);
  for (const cp of tracked.checkpoints) {
    assert.equal(cp.dueTs - decision.at, CHECKPOINT_OFFSETS_MS[cp.key as "M15" | "H1" | "D1"]);
  }
});

test("a signal with no receipt clock is marked as measured from event time", () => {
  // Replay. The origin is a lower bound crediting zero latency, and a report
  // that pools those with observed rows flatters every rate they appear in.
  const sig = makeSignal();
  const replayed = { ...sig, receivedAt: undefined, emittedAt: undefined as unknown as number };
  const d = decisionTimeOf(replayed);
  assert.equal(d.basis, "EVENT_TIME_ONLY");
  assert.equal(d.at, sig.lastTs);

  // The engine fixture's trades carry no `receivedAt`, so even a live-emitted
  // signal off it is event-time only — which is the honest reading.
  assert.equal(decisionTimeOf(sig).basis, "EVENT_TIME_ONLY");

  const observed = { ...sig, receivedAt: sig.lastTs + 40, emittedAt: sig.lastTs + 60 };
  const d2 = decisionTimeOf(observed);
  assert.equal(d2.basis, "OBSERVED");
  assert.equal(d2.at, sig.lastTs + 60, "the latest observed clock wins");

  // Both are required, not either: a partial observation credits the pipeline
  // a latency it cannot account for.
  assert.equal(decisionTimeOf({ ...observed, receivedAt: undefined }).basis, "EVENT_TIME_ONLY");
  assert.equal(
    decisionTimeOf({ ...observed, emittedAt: undefined as unknown as number }).basis,
    "EVENT_TIME_ONLY",
  );
});
