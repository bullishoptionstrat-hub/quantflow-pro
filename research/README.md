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
- **R5** §D's CR2 cross-check "decides nothing" and is not implemented; a report
  built on this module must add it or say it is absent.

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
balance diagnostic (decides nothing) and the D control (secondary).
