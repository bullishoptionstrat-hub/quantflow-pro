# H-001-v2 — Does quote-classified aggressive SPY call buying carry short-horizon information?

**Status:** `FROZEN`, `UNTESTED`.
**Frozen:** 2026-09-27, before any real options or underlying data has entered
this system. `signal_outcomes` holds zero rows; every signal on record is
synthetic. Nothing below was chosen after seeing a result, because none exists.

**Supersedes nothing.** `H-001-aggressive-call-buying-spy.md` is preserved
unchanged. v2 answers the same question with the design gaps the audit of
2026-09-27 found closed *before* any result is read: a stop date that was a
phrase rather than a date, a sample threshold (n ≥ 30) doing a precision
target's job, "CI includes zero" treated as refutation, no stated unit of
analysis, controls matched on the clock alone, and a causal-quote rule that
permitted equality. Changing anything below after data is accessed makes it
**H-001-v3**, recorded in `research/SEARCH_LEDGER.csv`; v2 is not edited.

---

## The question

Among SPY call option executions, classified **aggressive buying** against a
strictly causal NBBO, on simple (non-complex) reports, in the regular session,
above a frozen premium floor — does SPY's 15-minute return after them differ
from matched controls?

The economic story and the null it must beat are H-001's, unchanged: informed
buyers paying the spread for convexity ahead of a move, against the null that
aggressive option buying clusters around volatility that was already
happening.

## A. Exact dates

| role | window | sessions | use |
|---|---|---|---|
| DEVELOPMENT (§17 gate) | **2026-09-22** and **2026-09-24** (SPY only) | 2 | pipeline validation. Contaminated for inference by definition, and outside every window below. If a gate day contains no cancels, the next session (2026-09-25, then onward) is added and the addition recorded in the exposure ledger |
| CONFIRMATORY | **2026-01-02 through 2026-06-30** | 123 | the test. Loaded exactly once, after the gate passes and the analysis code is frozen |
| HOLDOUT | **2026-07-01 through 2026-08-14** | 32 | **not accessed for H-001-v2 at all.** Reserved to replicate a positive result, or to test a successor hypothesis |

**Stop date: 2026-06-30.** Selected on 2026-09-27, with no data in existence to
influence it, for three reasons unrelated to any result: the exchange calendar
covers 2026 and answers `UNKNOWN` outside it; the window ends before Cboe's
equity-options extended hours began (2026-08-17, SEARCH_ONLY) and before
OPRA's session identifier (2026-09-21), so every eligible trade is in the
regular session by construction; and six months gives enough trading days for
day-clustered inference at the precision below.

**Code freeze.** The analysis is implemented and run on the DEVELOPMENT days
only. Its commit hash is recorded in the exposure ledger row that loads the
CONFIRMATORY window, and nothing about the analysis may change after that row
exists.

## B. Unit of analysis

**One meta-event**, not one print and not one engine signal. Twenty prints of
one sweep are one piece of information, and so are three signals from one
order split across strikes.

Within a trading day, sort qualifying signals by `decisionAt`. The first defines
a meta-event at `t₁`; every qualifying signal with `decisionAt` in
`[t₁, t₁ + 15 min)` is absorbed into it; the first at or after `t₁ + 15 min`
starts the next. Meta-event windows therefore never overlap, so no outcome
window is counted twice. Each meta-event is measured from its first signal.

## C. Primary estimand

`Δ_AC = mean over A meta-events of (r_A − r̄_C)`, where

- `r = 10,000 × ln(M(t_exit) / M(t_entry))`, in basis points, `M` the SPY NBBO
  midpoint;
- `t_entry = decisionAt + 1 s` — a frozen latency allowance, because a
  `PROVIDER_RECEIPT` availableAt credits zero distribution latency;
  `M(t_entry)` is the latest SPY quote with event time **and** availableAt
  `≤ t_entry`, refused if older than 2 s;
- `t_exit = t_entry + 15 min`; `M(t_exit)` the latest SPY quote with event time
  `≤ t_exit`;
- `r̄_C` is the mean return of that meta-event's matched C controls (§G),
  measured the same way from each control's own availableAt.

**Mean**, because a trading edge is an expectation. The median difference is
reported beside it and decides nothing. **Positive** `Δ_AC` is the direction
the hypothesis predicts.

## D. Inference

- **Interval:** 95% day-clustered bootstrap — resample trading days with
  replacement, 10,000 replicates, seed `20260927`, percentile interval.
- **Clustering unit:** the trading day. Meta-events on one day share a regime;
  across days they are treated as independent.
- **Day-dependence check:** a weekly block bootstrap (resample calendar weeks).
  If it disagrees with the daily bootstrap about whether zero is excluded, the
  verdict is `FRAGILE`.
- **Same-underlying repetition** is handled by the meta-event unit (B) and the
  day clusters; nothing is additionally down-weighted.
- **Cross-check:** a CR2 cluster-robust interval (days as clusters) is
  reported. It decides nothing.
- **Leave-one-day-out:** if removing any single day moves the primary interval
  to include zero, the verdict is `FRAGILE` — H-001's "a single session supplies
  most of the effect", made mechanical.

## E. Precision, not a magic n

There is no minimum sample size. There is a **precision target**:

- the smallest economically meaningful effect is fixed now at **δ = 3 bp** of
  SPY over 15 minutes — a judgment, stated as one: SPY's 15-minute return has a
  standard deviation of order 15–25 bp and its spread is a fraction of a basis
  point, so an effect below ~3 bp is unlikely to survive the costs of acting on
  it;
- the study is **confirmatory only if the 95% interval's half-width is
  ≤ δ/2 = 1.5 bp**. Wider, and the result is `DESCRIPTIVE`: the estimate and
  interval are published and no support or equivalence claim is made;
- planning estimate, not a threshold: at σ = 15 / 20 / 25 bp that needs
  roughly 380 / 680 / 1,070 effectively independent meta-events — about 3–9 per
  trading day over 123 days. Effective n (meta-events, days) is reported either
  way.

## F. Null versus equivalence

| outcome | verdict |
|---|---|
| interval excludes zero, `Δ_AC > 0`, every criterion in §K met | `SUPPORTED` (but see §K on the truth set) |
| interval excludes zero, `Δ_AC < 0` | `CONTRARY` — reported, never support |
| interval includes zero, and the **90%** interval lies inside **(−1 bp, +1 bp)** (TOST at α = 0.05) | `PRACTICALLY NEGLIGIBLE` |
| interval includes zero, otherwise | `NOT SUPPORTED` — which is **not** "proven false" |
| half-width > 1.5 bp | `DESCRIPTIVE` |

The equivalence margin (±1 bp) is fixed now, a third of δ.

## G. Controls and matching

- **A** — the qualifying events (§H–§I), as meta-events.
- **B** — the same, classified aggressive **selling** (engine side `SELL`).
  Secondary estimand `Δ_AB = mean r_A − mean r_B`.
- **C** — **primary control.** For each A meta-event, up to 5 SPY call
  executions drawn without replacement (seed `20260927`) that are not part of
  any A or B meta-event and match it **exactly** on: trading day; 60-minute ET
  bucket; DTE bucket {0, 1–2, 3–7, 8–30, 31+}; moneyness bucket by K/S at the
  causal SPY midpoint {<0.97, 0.97–0.995, 0.995–1.005, 1.005–1.03, >1.03};
  premium bucket {$50k–100k, $100k–250k, $250k–1M, ≥$1M}; any side
  classification. C answers: does the classification add anything beyond "a
  large call trade like this happened then"?
- **D** — 5 random SPY times (seed `20260927`) on the same day, same 60-minute
  bucket. Secondary estimand `Δ_AD`: is the effect a clock?
- **Volatility regime** is matched by construction through same-day,
  same-hour matching, which holds regime tighter than any tercile would. The
  trailing 30-minute realized volatility of A versus C is reported as a balance
  diagnostic; a standardized mean difference above 0.1 is flagged.
- An A meta-event with **no** exact C match is dropped from `Δ_AC` and counted.
  Nothing is coarsened to find a match. If more than 20% of A meta-events are
  unmatched, the matched set is a selected subset of unknown representativeness
  and the verdict is `DESCRIPTIVE`.

## H. Causal NBBO

Side is inferred by the engine's own `inferSide`, against the quote chosen by
`events/causalQuote.ts`: stamped **strictly before** the trade, **available
by** the trade's availableAt, from the same provider, no older than the
engine's 2 s bound. One-sided, locked or crossed books attach nothing, and the
side is `AMBIGUOUS`. Equal timestamps are never admitted. A provider's
strict-before pairing (ThetaData `exclusive=true`, Databento TCBBO's pre-trade
BBO) is used only after the §17 gate's `causal-quote-alignment` check passes on
that provider's sample.

## I. Classification robustness

- **Primary A:** engine side `BUY` — at or through the causal ask.
- **Never pooled:** `BUY_LEAN`. An effect that appears only when it is folded
  in is `NOT SUPPORTED` here, and may only become a new hypothesis tested on the
  HOLDOUT window.
- **Sensitivity, declared now, reported always, deciding nothing:** staleness
  bounds of 1 s and 5 s; a $100k premium floor; the as-known replay including
  signals later cancelled (§J); the weekly block bootstrap.

## J. Which tape

**Primary:** signals the live system would have formed (the as-known replay
through the V2 reorder buffer and admission rule), **excluding** any whose
final-tape revision is not `FINAL` — `INVALIDATED_BY_CORRECTION`, `REVISED` and
`EVIDENCE_UNRESOLVED` are counted and dropped. The question is about
information in real executions, and a cancelled trade was not one.
**Secondary:** the pure as-known replay, cancelled trades included — what a live
system would have experienced.

## K. Multiple testing, and what "SUPPORTED" requires

- **M15 is the only primary endpoint.** H1 and D1 are exploratory, reported
  without multiplicity correction, and support no claim.
- `Δ_AC` is the only primary estimand. `Δ_AB` and `Δ_AD` are secondary.
- `SUPPORTED` requires **all** of: the primary interval excludes zero with
  `Δ_AC > 0`; the half-width meets §E; `Δ_AB`'s interval excludes zero with
  `Δ_AB > 0` (otherwise the classifier's direction carries no information);
  not `FRAGILE`; not only with `BUY_LEAN`.
- **Carried from H-001 unchanged:** classification error must be measured
  against a truth set. **If no truth set exists, the strongest verdict available
  is `INCONCLUSIVE`, whatever the interval says.** OPRA carries no aggressor
  side, so a truth set is itself a data-acquisition question, recorded in the
  provider decision record.

## L. Eligibility and exclusions

A signal qualifies only if **all** hold:

- underlying SPY; a single-leg call signal; engine side `BUY` (A) or `SELL` (B);
- premium ≥ $50,000;
- every evidence print admitted by `events/detector.ts` (regular reports only —
  no late, out-of-sequence, complex, uninterpreted or cancelled prints);
- session eligibility `INCLUDED` under `H001_V2_SESSION_RULE`
  (`market/researchEligibility.ts`): provider evidence REGULAR, or no session
  evidence and inside the exchange's regular hours by clock inference;
- `decisionAt` between 09:30 and 15:45 ET (12:45 on an early close), so the
  M15 exit falls inside the underlying's regular session;
- contract state not `LAST_TRADING_DAY_ENDED` (`contractSessionAt`);
- availableAt basis not `EVENT_TIME_LOWER_BOUND`;
- not synthetic;
- the dataset's rights manifest permits fetch, raw and normalised persistence,
  research use and retention (`importPermitted`);
- no unfilled sequence gap on its stream inside its formation (§J's
  `EVIDENCE_UNRESOLVED`);
- entry and exit marks both available under §C's rules.

## What makes this untestable today

- **No entitled options-event dataset.** Neither candidate provider is
  purchased, and both manifests are UNVERIFIED on every axis.
- **No SPY equity quote dataset** for the marks — a second acquisition with its
  own rights.
- **No truth set** for aggressor classification (§K).
- **The code semantics are UNVERIFIED.** The §17 gate fails
  `code-semantics-verified` until the OPRA specification is read, and nothing
  may be imported for this study before the gate passes.
