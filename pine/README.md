# pine/

TradingView Pine Script for futures. One system so far, and it has never
been run.

## `qf_f001_es_orb_vwap.pine` — F-001

A Pine v6 `strategy()` port of es-signal-tool's `combined_orb_vwap`: an
opening-range breakout on trend days and VWAP reversion on range days, routed
by one regime filter (an ADX threshold plus a realized-vol percentile cap).
Registered as **F-001** in `research/SEARCH_LEDGER.csv`; the preregistration
is `research/hypotheses/F-001-es-orb-vwap-regime.md`.

**Status: uncompiled, untested.** No Pine compiler exists in this repo or on
the machine it was written on. The script has not been loaded into
TradingView, and no result from it or its Python original has been viewed.

### Loading it

1. TradingView → Pine Editor → paste the file → *Add to chart*.
2. Chart: **ES1!** (or MES1!) on **5 minutes**, with extended hours **on**
   (the Python computes its regime over every bar it is given, and the
   overnight bars change ADX and the vol rank at the open).
3. Set *back-adjust* in the chart's continuous-contract settings on or off to
   match the data you feed the Python. If they differ, roll days differ.
4. The *Trade from* input defaults to **2026-08-15**, the parity window.
   **Do not move it earlier without first writing a row in
   `research/DATASET_EXPOSURE_LEDGER.csv`.** The Strategy Tester shows P&L
   the moment it loads, and that counts as viewing the result. 2023–2025 is
   F-001's confirmatory and holdout data. 2026-01-02 to 2026-08-14 belongs to
   H-001-v2, and the integrity test refuses any exposure row that touches it.

### What it does

| | |
|---|---|
| Decision | on each bar's close (`calc_on_every_tick=false`) |
| Fill | next bar's open (`process_orders_on_close=false`), like `run_backtest`'s `signal.shift(1)` |
| Flat | everything from 15:59 ET. No entry is placed for a bar opening at or after it |
| Costs | $2.00 per contract per fill ($4.00 round turn) and 1 tick of slippage per fill |
| Size | 1 contract, fixed |
| Margin | 0% long and short. The Python models no margin. Under a nonzero margin, TradingView's emulator can liquidate an ES contract against a $50k account with "Margin call" exits the Python never makes |
| Timezone | `America/New_York` everywhere. ES's exchange timezone is Chicago, so nothing reads `syminfo.timezone` |
| Repainting | none. No `request.security`, and every value is computed from closed bars |
| Alerts | one `alert()` per change of target, at bar close, as JSON. The prop rules es-signal-tool targets forbid unattended automation, so treat the alerts as prompts, not as a bot |

### Where the port follows the Python

These are deliberate. The point of the port is to produce the same trades as
the Python, so its odd behaviour is copied, not fixed. Fixing any of them is a
new experiment on both engines.

1. **ORB holds a position only while each bar keeps breaking.** The Python sets
   a target of ±1 on a bar only if *that bar's* high or low is beyond the
   range. A bar back inside the range sets 0, which closes the position at the
   next open. Its docstring says "only one direction per day", but nothing
   enforces it, so a day can go long and later short.
2. **A bar that breaks both sides goes long.** The high is checked before the low.
3. **Rolling statistics follow pandas, not `ta.*`.** pandas returns NaN when
   any value in its window is NaN, and Pine's built-ins skip `na`. ADX, the
   realized vol and its percentile rank are therefore written as explicit
   loops. Standard deviations are sample (ddof=1), and the rank averages ties
   the way `rank(pct=True)` does.
4. **The VWAP leg's vol cap is the literal 0.95 in the Python.** The port reads
   the *Vol percentile cap* input instead. The default is the same; change it
   and the engines part.
5. **Hindsight the port cannot copy.** The Python skips a whole day when it has
   ≤ 6 RTH bars (ORB) or < 22 (VWAP), which it knows only by looking at the
   finished day. A bar-by-bar engine cannot. This only matters on truncated
   days; ordinary half-days have 43+ bars.
6. **The flat check.** The Python compares the next bar's `HH:MM` label with
   `"15:59"`. The port compares the current bar's `time_close`, which is the
   same moment when bars are contiguous.
7. **Costs when contracts > 1.** The Python charges one fixed round-turn cost
   per trade whatever the size. TradingView charges per contract. With the
   default of 1 contract they agree.

### Not in it, on purpose

- **No daily loss limit or trailing-drawdown stop.** es-signal-tool evaluates
  the prop rules after the fact, in `prop_rules.py`. Putting them inside the
  strategy would change the trades and break parity.
- **No QuantFlow data.** Pine cannot reach this backend, and the GEX and flow
  here are simulated on this deployment anyway (see `docs/CLAIMS_LEDGER.md`).

### Checking parity

F-001 §C requires this before any confirmatory data is loaded:

1. Export the chart's own bars from 2026-08-15 onward and run the Python on
   *those*, not on another vendor's ES. VWAP reads volume and roll handling
   varies by vendor, so separate feeds would test the data as well as the
   code. (On lower TradingView plans, 5-minute history may not reach back to
   2026-08-15. If it doesn't, record the window actually used.)
2. Export TradingView's *List of trades*.
3. Match the two on entry bar and direction. Below 95% matched, F-001 halts
   until the difference is explained.
