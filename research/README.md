# research/

§95 and §98. **Empty on purpose, and the emptiness is load-bearing.**

There are zero real graded outcomes in this system. `signal_outcomes` holds 0
rows; every one of the 4,559 signals in `signal_history` is synthetic. So there
is nothing to test, and `rejected/` is empty because nothing has been rejected
rather than because nothing has failed.

**The template exists now precisely because the data does not.** §95 requires a
hypothesis be frozen *before* validation is examined, and the cheapest moment to
write an honest failure criterion is while there is no result to be disappointed
by. A pre-registration written after the first look is not a pre-registration.

- `hypotheses/` — one file per frozen question. Frozen means the failure
  criterion was written before any result existed.
- `rejected/` — hypotheses that failed. **Never deleted.** They are the
  denominator of the search (§100): one strategy out of five hundred looking
  excellent is not the same evidence as one pre-registered strategy looking
  excellent, and the only way that stays visible is if the other 499 are still
  on disk.

**2026-09-27.** Three additions, all before any real data:

- `hypotheses/H-001-v2-…` — H-001 re-frozen with an exact stop date, a unit of
  analysis, an estimand, an inference plan, a precision target instead of
  n ≥ 30, an equivalence margin, matched controls and a strictly causal quote.
  v1 is preserved unchanged; both files are pinned by hash in
  `backend/test/researchIntegrity.test.ts`.
- `DATASET_EXPOSURE_LEDGER.csv` — every look at data, with its role
  (DEVELOPMENT / VALIDATION / HOLDOUT / CONTAMINATED). A role is never reset.
  Today every row is synthetic or operational, and none touches H-001-v2's
  windows — which a test asserts.
- `SEARCH_LEDGER.csv` — every registered version, superseded ones included.
- `manifests/` — the rights a research dataset carries, per axis. Both
  candidates are UNVERIFIED on every axis; nothing may be imported against them.

**2026-09-28.** H-001-v2's §L eligibility rules are code:
`backend/src/research/h001Eligibility.ts`, written from the frozen text before
any data exists, so an exclusion cannot be tuned to a result. It answers
`INCLUDED` (with group A or B), `EXCLUDED`, or `UNKNOWN` — a rule that could not
be established keeps a candidate out and is counted apart from a failure — and
it reports every failing rule, not the first. One reading is recorded here
because the hypothesis file is pinned and cannot carry it: §L's "09:30 to 15:45
ET" is implemented from its own stated reason, "so the M15 exit falls inside the
underlying's regular session", with §C's one-second latency included, so a
decision at exactly 15:45:00 (exit 16:00:01) is out. Marks, controls and
meta-events stay in their own modules.

**2026-10-05.** §C's marks are code: `backend/src/research/h001Marks.ts`
measures `r = 10,000 × ln(M(t_exit) / M(t_entry))` from a signal's
`decisionAt` or a control's own availableAt, with the entry quote both stamped
and known by `t_entry` and no older than 2 s, the exit on the final tape, and
the latest book taken as the book (one-sided, crossed or disagreeing books
refuse the mark rather than fall back). §C's latency and horizon now have one
home, which the eligibility window reads.

**Open, and not decided in code:** §C bounds the entry quote's age and states
**no bound for the exit**. A feed that goes quiet lets a quote from the entry
minute stand in for `M(t_exit)`, and the return reads as flat. The age is
returned on every measurement (`exitAgeMs`) rather than refused, because
adding a bound is amending a preregistered rule. No data has been accessed for
H-001-v2, so the hypothesis may still be amended in place (with its hash pin
updated in the same diff) — that is the operator's decision to make.

**2026-10-06.** The decision rule is code: `backend/src/research/h001Verdict.ts`
turns the matched differences into a §F verdict — day-clustered bootstrap
(10,000 replicates, seed 20260927), the §E precision target, the §G 20%
unmatched rule, both §D fragility checks, the §F table and the §K conditions.
Five readings it had to make, each open to challenge before any data is read:

- **R1** "Percentile interval" is computed with type-7 linear interpolation.
- **R2** When the primary interval excludes zero above but Δ_AB's does not, the
  verdict is `NOT SUPPORTED` (the §F "otherwise" row), with the unmet condition
  named.
- **R3** Without a truth set, every claim-bearing verdict — including
  `CONTRARY`, `PRACTICALLY NEGLIGIBLE` and `NOT SUPPORTED` — becomes
  `INCONCLUSIVE`, with the would-be verdict kept as `uncappedVerdict`. A
  classifier of unknown accuracy can hide an effect as easily as fake one.
  `DESCRIPTIVE` makes no claim and is not capped.
- **R4** Leave-one-day-out re-runs the same seeded bootstrap without the day;
  the weekly bootstrap clusters by Monday-start calendar week.
- **R5** §D's CR2 cross-check "decides nothing", so the verdict module does not
  compute it. Since 2026-10-12 it lives in `h001Cr2.ts` and the report carries
  it beside the verdict (see that entry); a test holds that the verdict never
  reads it.

**2026-10-06.** §G's primary control is code: `backend/src/research/h001Controls.ts`
draws up to five C controls per A meta-event, without replacement, seed
20260927, from SPY call executions on the final tape that belong to no A or B
meta-event and match exactly on day, hour, DTE, moneyness and premium — and
emits the `primary` differences and `unmatchedA` count `h001Verdict.ts` reads.
Seven readings it had to make, each open to challenge before any data is read:

- **M1** The "60-minute ET bucket" is the ET clock hour of the anchor
  (10:00–10:59), not a session-anchored hour (09:30–10:29).
- **M2** DTE is whole calendar days from the anchor's market date to the expiry
  date, so `{0}` means "expires today".
- **M3** Every bucket is lower-inclusive — the premium row's "≥$1M" fixes the
  convention, and one convention is used on every axis.
- **M4** "The causal SPY midpoint" is the latest SPY quote stamped and known by
  the anchor, no older than 2 s (§H's rule and bound). None: no key, no match.
- **M5** An A meta-event is keyed by its first signal (the one §B measures it
  from): contract, cluster premium, decisionAt. A control is keyed by its own
  contract, `price × size × 100` and availableAt. The asymmetry — a signal's
  cluster premium against one execution's premium — is §G's text, not a choice.
- **M6** "Without replacement" is within one A meta-event's draw; an execution
  may control several A meta-events. One PRNG stream is consumed in A order
  (date, start, id) with each pool ordered by event id, so the draw is a
  function of the data alone.
- **M7** "Measured the same way" means every §L rule that does not define
  group A — final tape and ACTIVE, detector-admitted, regular session, contract
  open, availability basis, not synthetic, the same decision window, both §C
  marks. Executions failing any are removed **before** the draw.

Not implemented, and a report must say so: the 30-minute realised-volatility
balance diagnostic (decides nothing).

**2026-10-06.** §G's D control is code: `matchClockControls` draws five random
SPY times per A meta-event, same day and same hour, and emits the paired
`r_A − r̄_D` that Δ_AD is computed from; `h001SecondaryInterval` reports Δ_AD
with the primary's own day-clustered bootstrap and decides nothing (§K). Five
readings, each open to challenge before any data is read:

- **D1** A time is a uniform integer millisecond over the part of the A
  meta-event's ET clock hour where §L could admit a decision — at or after the
  open, early enough that the M15 exit reaches the close (09:30–09:59 in the
  09:00 hour, 15:00–15:44:59 in the 15:00 hour, 12:00–12:44:59 on a 13:00 close).
- **D2** Times are not kept away from A or B meta-events: §G says "random SPY
  times".
- **D3** A time with no §C mark is dropped and counted, never redrawn. If none of
  an A meta-event's five measure, it has no D comparison and is counted.
- **D4** Δ_AD is paired like Δ_AC — the mean of `r_A − r̄_D` — rather than a
  difference of group means like Δ_AB.
- **D5** D has its own PRNG stream (seed 20260927), consumed in A order, five
  draws per A meta-event whatever the window, so neither C's draw nor another
  A meta-event's window moves a D time. Drawn with replacement in milliseconds.

**D5, sharpened.** "Its own PRNG stream" means D's draws are separate from
C's, so adding or removing a C control never moves a D time. It does **not**
mean independent: both are seeded `20260927` (§G names one seed), so D's
uniforms are the same number sequence C's draw consumes. Each estimate is
unaffected on its own; what is shared is position in the stream — the k-th
uniform C consumes is the k-th D consumes. That does not line up per A
meta-event (C draws nothing for an unmatched one; D always draws five), and C's
pools are ordered by content-hash event id, which carries no time order, so the
sharing is harmless. Recorded so it is not read as
independence; changing it would mean choosing a second seed §G does not name.

**2026-10-12.** The analysis is one function: `backend/src/research/h001Analysis.ts`
(`runH001Analysis`) takes candidate signals, the FINAL_CORRECTED tape and one
provider's SPY quotes, and returns the whole report — §L per candidate with
counts per rule, §B meta-events, §C returns, §G's C and D draws, the §F/§K
verdict and Δ_AD. Until now each part was tested alone and nothing called them
together, so there was no single "analysis" for §A's code-freeze hash to name.
Five readings it had to make, each open to challenge before any data is read:

- **X1** Meta-events are formed per group, A with A and B with B. A meta-event
  mixing a buy and a sell has no group and could enter neither estimand. An A
  and a B meta-event may overlap in time.
- **X2** The meta-event window is §C's 15-minute horizon, read from its one home.
- **X3** §L's marks are the signal's own, measured from its decisionAt. A
  meta-event is measured from its first signal, which §L admitted with both.
- **X4** A single-leg signal's contract is its evidence's one instrument. §L
  already excludes evidence spanning two contracts; the throw is a backstop.
- **X5** "Not part of any A or B meta-event" is the evidence of every absorbed
  signal, not only each meta-event's first. A BUY_LEAN execution in no
  meta-event **is** eligible as a C control — §G draws from "any side
  classification".

The report carries `absent`: every diagnostic the frozen text names and this
code does not compute (§I's staleness sensitivities, §J as-known secondary,
§K's H1/D1; §D's CR2, §I's $100k floor and §G's volatility balance until
2026-10-12). All of them decide nothing, so the verdict is
complete without them; the report is not, and says so.

**2026-10-12.** §D's CR2 cross-check is code: `backend/src/research/h001Cr2.ts`,
and the report carries it as `cr2`, computed on exactly the matched differences
the verdict reads. It decides nothing, says so on the payload (`decides:
false`), and the verdict module never imports it. Δ_AC is a pooled mean, so the
model is intercept-only and CR2 has a closed form, `V = Σ_g S_g² / (N²(1 −
n_g/N))`. The tests check that form three ways that do not share its
derivation: with one observation per day it gives s²/N; with equal-sized days
it gives G/(G−1)·CR0; and on unequal days it matches a brute-force evaluation
of the general matrix formula. Two readings:

- **R6** The critical value is Student t with Bell–McCaffrey (Satterthwaite)
  degrees of freedom under a homoskedastic working model. That is the pairing
  Imbens & Kolesár (2016) recommend for CR2. §D names the estimator and no
  reference distribution. With equal-sized days the degrees of freedom are
  exactly G − 1, the usual alternative. They fall below G − 1 as days become
  unequal, which widens the interval. The report carries the value used.
- **R7** Fewer than two days gives no interval. One cluster has no
  between-day variation to estimate, which is the same floor the bootstrap
  uses.

**2026-10-12.** §I's $100k premium-floor sensitivity is code. The report's
`sensitivities.premiumFloor` re-runs the whole pipeline on only the candidates
whose premium is at least $100,000. It reports the counts, the verdict and the
CR2 interval, and it carries `decides: false`. A test holds that the primary
part of the report is byte-identical to the pipeline run alone. A sensitivity
that could move the primary would be a second primary analysis. Two readings:

- **S1** The floor replaces §L's $50k at the candidate step, so meta-events are
  re-formed. A $70k signal that opened a window no longer opens it; the next
  qualifying signal does. The $70k signal's prints may then enter the C pool,
  but they can never match a control slot: every surviving A meta-event's
  premium bucket is at least $100k, and a print's premium cannot exceed its
  cluster's.
- **S2** A sensitivity is the whole pipeline, including the controls, the
  verdict rule and the §K cap, so its verdict can be compared with the
  primary's.

**Still absent, and why.** The §I staleness bounds of 1 s and 5 s are §H's: the
causal-NBBO age used when the engine *classifies* a print, which happens before
a signal exists. The composer receives signals that are already classified, so
re-running at 1 s or 5 s needs signal sets formed under those bounds as input.
That is a question of how the data is supplied, not something the composer can
compute. §C's entry-mark bound is also 2 s, but it is a different rule; §I's
section is classification robustness, so it is not read as §C's.

**2026-10-12.** §G's balance diagnostic is code: `backend/src/research/h001Balance.ts`.
The report's `balance` field carries the trailing 30-minute realised volatility
of the matched A meta-events against their C controls. It gives the
standardized mean difference and flags an SMD above 0.1 in absolute value. It
decides nothing, and the verdict module never imports it. Controls and A
matches now carry the instant §C measured them from (`anchor`), so each unit's
window is its own. The readings:

- **V1** RV is √Σr² over the 30 one-minute log returns of the SPY midpoint, in
  bp. The grid is 31 marks ending at the unit's §C entry instant.
- **V2** Each grid mark obeys §C's entry rule: stamped and known by the
  instant, no older than 2 s, and a two-sided, uncrossed book. A stale mark
  repeats a price, which reads as zero return and biases volatility low, the
  flattering direction for a balance check.
- **V3** A unit with any refused mark is unmeasurable. It is counted and never
  filled. This covers every event in a session's first 30 minutes when no
  quotes exist before the open.
- **V4** The comparison is over matched pairs. An A meta-event with no
  measurable window, or with no measurable control, leaves the comparison
  together with its controls. Each A has weight 1 and each of its k controls
  weight 1/k.
- **V5** SMD = (mean_A − mean_C) / √((var_A + var_C) / 2), with both variances
  on the (Σw − 1) divisor. It is flagged when |SMD| > 0.1, because imbalance in
  either direction is imbalance.

