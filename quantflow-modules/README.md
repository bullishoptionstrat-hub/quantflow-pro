# QuantFlow Modules

Production modules for QuantFlow Terminal (Quantum Edge Capital LLC).

| Module | Purpose | Verified |
|---|---|---|
| `flow-engine/` | Options flow classification: sweep/block/split/multi-leg, NBBO side inference, unusualness score v1, outcome tracker + hit-rate reporting | tsc strict clean, 14/14 tests |
| `firecrawl/` | Web enrichment: FINRA doc sync w/ change detection, news context (context layer only), competitor-intel + macro-digest research workflows | tsc strict clean, live-verified error paths |

Each module has its own README with integration steps and honest limitations.

Positioning: market intelligence and research tooling — signals are
educational market intelligence, never guaranteed buy/sell instructions.
