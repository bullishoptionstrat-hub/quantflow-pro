# F-001 — Does a regime-routed ORB + VWAP-reversion system on ES survive costs and a 50K prop drawdown?

**Status:** `FROZEN`, `UNTESTED`.
**Frozen:** 2026-10-30. No ES data has been run through this system on any
engine: es-signal-tool's `data/` and `reports/` are empty, and the Pine port in
`pine/qf_f001_es_orb_vwap.pine` has never been loaded on a chart. Nothing below
was chosen after seeing a result, because none exists.

The rule set is not new. It is es-signal-tool's `combined_orb_vwap` at its
shipped defaults, fingerprinted by md5 in the Pine header, and the pass
conditions are that tool's own "three numbers that decide everything", made
precise enough to fail. Changing anything below after data is accessed makes it
**F-001-v2**, recorded in `research/SEARCH_LEDGER.csv`; this file is not edited.
Its hash is pinned in `backend/test/researchIntegrity.test.ts`.

---

## The question

On E-mini S&P 500 futures, 5-minute bars, one contract, does the system
below make money after $4.00 round-turn commission and one tick of slippage
per side, steadily rather than in one lucky stretch, without a drawdown that
would end a TopStep 50K Combine?

The null it must beat: an intraday breakout system on ES pays the spread and
commission on every trade, and over enough trades it loses about that much.

## A. The system (frozen)

`combined_orb_vwap(bars, bar_minutes=5)` with every default:

- **Regime.** Simplified ADX(14) on simple moving averages; realized vol is the
  sample stdev of true range over 20 bars, ranked over the last 100.
  *Trend* = ADX ≥ 20. *Tradeable* = trend and vol rank ≤ 0.95.
- **ORB** (trend days). Opening range = the first 30 minutes from 09:30 ET.
  On each later RTH bar where tradeable: long if the high is above the OR high,
  else short if the low is below the OR low, else flat.
- **VWAP reversion** (range days). Session VWAP from 09:30 (typical price),
  bands ±2.0 × the sample stdev of (close − VWAP) over 20 RTH bars. Fade a
  close beyond a band; exit at VWAP, or when price runs another band-width
  against. Forced flat on any bar that is trend or vol rank > 0.95.
- **Routing.** ORB's target wins where it is non-zero, else VWAP reversion's.
- **Execution.** Target decided on bar close, filled at the next bar's open;
  flat from 15:59 ET; shorts allowed.

## B. Windows

| role | window | use |
|---|---|---|
| DEVELOPMENT | everything before **2023-01-03** | pipeline checks only |
| CONFIRMATORY | **2023-01-03 through 2024-12-31** | the test, run once |
| HOLDOUT | **2025-01-02 through 2025-12-31** | not accessed unless the confirmatory result is SUPPORTED |
| PARITY | **2026-08-15 onward** | Pine ↔ Python trade-list comparison only; evidential for nothing |

2026-01-02 through 2026-08-14 is **not used**. It overlaps H-001-v2's windows,
and `researchIntegrity.test.ts` refuses any exposure-ledger row that touches
them, whatever the instrument. The Pine script's `Trade from` defaults to
2026-08-15 so that opening TradingView's Strategy Tester shows the parity
window and nothing else.

## C. Engine of record

es-signal-tool's Python backtester and `prop_rules.py`. The Pine port is a
mirror, and a mirror is only evidence once it has been checked. **Before the
confirmatory window is loaded**, the two must agree on the parity window: at
least 95% of Python trades matched by a Pine trade with the same entry bar and
direction. A lower match rate halts F-001 until it is explained. The Python
is fed **TradingView's own bars** for that window (the chart's data export),
so that a difference is a difference in code and not between data vendors;
VWAP reads volume and roll handling varies by vendor.

## D. Decision rule

Over the confirmatory window, one contract, Combined mode. Every measure is
computed by code that already exists in es-signal-tool, on
`trades = run_backtest(bars, lambda b: combined_orb_vwap(b, bar_minutes=5))`
with the default `BacktestConfig()`:

| condition | measure |
|---|---|
| D1 | `summarize(trades)["net_pnl"] > 0` |
| D2 | `trades.groupby(trades.exit_time.dt.to_period("Q")).pnl_dollars.sum() > 0` in at least **6 of the 8** quarters (a quarter with no trades counts as not positive) |
| D3 | `evaluate(trades, PropConfig(drawdown_type=DrawdownType.EOD_STATIC, daily_loss_limit=None, max_drawdown=float("inf"))).max_intraday_dd < 2000`. This config never stops early, so the figure covers every trade. It is peak-to-trough of **realized** equity in exit order, which is looser than marking open P&L. That limit is stated in `evaluate`'s own docstring and accepted here rather than written as new code |
| D4 | `evaluate(trades, PropConfig.topstep_50k()).passed` |
| D5 | `summarize(trades)["trades"] >= 200` |

- D5 fails → **INCONCLUSIVE**, whatever D1–D4 say.
- D1–D5 all hold → **SUPPORTED**, and the holdout may then be run once, under
  the same rule.
- Otherwise → **REJECTED**, moved to `research/rejected/`, never deleted.

No parameter is tuned on the confirmatory window. A different parameter set
is a different experiment with its own ledger row.

## E. Known differences between engines

Listed in `pine/README.md` under "Where the port follows the Python". They
change no trade on a full RTH session with continuous 5-minute bars, which is
the case D1–D5 are measured on.
