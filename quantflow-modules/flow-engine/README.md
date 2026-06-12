# QuantFlow Flow Engine

Provider-agnostic options flow classification engine — the core IP layer of a
FlowAlgo-class product. Sweep / Block / Split / Multi-Leg / Large detection with
NBBO side inference, rule-based unusualness scoring, and a full audit trail.

## Status (verified 2026-06-12)

| Check | Result |
|---|---|
| `tsc --noEmit` (strict, noUncheckedIndexedAccess) | PASS |
| Test suite (14 deterministic scenarios, node:test) | 14/14 PASS |
| Dollar cost to build and verify | **$0** |

## The free-development strategy

Real-time OPRA-derived options data cannot be free — anyone offering it free is
reselling delayed data. The play here:

1. **Now ($0):** the hardest logic — classification, side inference, scoring —
   is built and proven against deterministic synthetic fixtures
   (`test/fixtures.ts`, clearly labeled SYNTHETIC; engine stamps
   `synthetic: true` on every signal in this mode).
2. **When ready to spend:** subscribe to Polygon options (real-time trades
   effectively starts at the paid Advanced tier as of mid-2026 — verify current
   pricing) and use `adapters/polygon-replay.ts` to validate the engine against
   real historical tape with zero engine changes.
3. **Go live:** swap the REST replay source for the WebSocket feed. Same
   `onQuote`/`onTrade` interface.

## Files

```
src/types.ts                  domain types, config, defaults
src/nbbo.ts                   NBBO book + quote-rule side inference
src/score.ts                  unusualness score v1 (deterministic, explainable)
src/engine.ts                 orchestrator: bursts → multi-leg → sweep/block/large → split
src/adapters/polygon-replay.ts  REST replay (needs paid options key)
src/outcome/types.ts          outcome types, persistence interface, direction map
src/outcome/tracker.ts        checkpoint scheduler, grader, hit-rate report
src/index.ts                  barrel export
test/fixtures.ts              SYNTHETIC fixtures
test/engine.test.ts           9-scenario verification suite
```

## Run

```bash
npm install
npm run typecheck   # expect clean
npm test            # expect 9/9
```

## Use in the QuantFlow ingest service

```ts
import { FlowEngine } from "./flow-engine/index.js";

const engine = new FlowEngine(
  { minSignalPremium: 25_000, syntheticSource: false },
  (contractSymbol) => statsCache.get(contractSymbol), // OI / dayVolume / spot
);

ws.on("quote", (q) => engine.onQuote(normalizeQuote(q)));
ws.on("trade", (t) => {
  for (const signal of engine.onTrade(normalizeTrade(t))) {
    persistSignal(signal);   // Supabase: classified signals only, never raw tape
    maybeAlert(signal);      // score >= threshold → Telegram/webhook
  }
});
```

Every signal includes: kind, dominant side, per-leg breakdown (size, premium,
vwap, prints, exchanges), score with component breakdown, spread guess for
multi-leg, `printIds[]` audit trail, and the `synthetic` flag.

## Classification rules (v1)

- **Side**: at/above ask → BUY; at/below bid → SELL; inside spread → lean by
  mid; at mid, missing, or stale (>2s) NBBO → **AMBIGUOUS — never guessed**,
  and ambiguous side takes a −15 score penalty.
- **MULTI_LEG**: ≥2 contracts on the same underlying whose first prints land
  within 25ms — emitted as one signal with legs; single-leg signals are
  suppressed (no "bullish call buying" that's actually half a collar).
- **SWEEP**: same contract+side cluster (gap ≤100ms) across ≥2 exchanges or
  ISO-flagged, ≥ $25k premium.
- **BLOCK**: single print ≥100 contracts or ≥ $100k premium.
- **LARGE**: single-exchange cluster ≥ $25k that is neither sweep nor block.
- **SPLIT**: ≥5 sub-threshold prints, same contract+side, within 5 minutes,
  cumulative ≥ $50k — fires the moment thresholds are met, buffer consumed.
- **Score v1 (0–100)**: premium tier (30) + aggression/ISO/exchanges (20) +
  vol>OI (20) + OTM distance (10) + DTE urgency (10) + repeat hits (10) −
  ambiguity penalty. Unknown OI/spot never inflates a score.

All thresholds are config (`FlowEngineConfig`) — tune per underlying later.

## Outcome Tracker (the moat)

Every signal can be registered for grading at M15 / H1 / D1 / EXPIRY
(expiry only when ≤14 days out). Labels: POSITIVE (max contract return
≥ +25%), NEGATIVE (≤ −25% with no positive checkpoint), NEUTRAL, or
UNGRADED (ambiguous side / missing marks — reported, never hidden).
`buildReport()` aggregates honest hit-rates per signal kind, plus
direction-correct rate at D1. UNGRADED is excluded from hit-rate math but
its count is always shown. `PriceLookup` and `OutcomeStore` are interfaces:
plug any quote source and Supabase respectively. This is also the labeled
dataset that must exist before any predictive scorer is legitimate.

```ts
const tracker = new OutcomeTracker(supabaseStore, priceLookup);
await tracker.register(signal);          // at alert time
await tracker.evaluateDue(Date.now());   // cron every minute
const report = buildReport(await store.all()); // public hit-rate page
```

## Known limitations (read before live use)

1. **ISO condition code (227) is a placeholder** — verify against Polygon's
   options trade-conditions reference before trusting the ISO flag live.
   Multi-exchange clustering works regardless.
2. **Side inference is the quote rule, not truth.** Mid prints, price
   improvement, and complex-order-book executions misclassify everywhere —
   including at FlowAlgo. AMBIGUOUS labeling is the honest handling.
3. **Multi-leg detection is time-window heuristics**, not OPRA complex-trade
   condition codes. Legs filled >25ms apart will classify separately. Tighten
   with condition codes once on real data.
4. **Throughput untested at full OPRA scale.** Filtered single-underlying
   streams are fine; full-market firehose needs a perf pass (pre-filter by
   premium at the adapter before the engine).
5. **Score v1 is descriptive, not predictive.** It ranks unusualness; it does
   not predict outcomes. Outcome tracking produces the labels that could ever
   justify a predictive model. Signals are market intelligence, not trade
   triggers — God's Plan price-confirmation rules govern entries, always.
