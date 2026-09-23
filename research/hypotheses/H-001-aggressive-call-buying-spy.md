# H-001 — Does quote-classified aggressive SPY call buying carry short-horizon information?

**Status:** `FROZEN`, `UNTESTED`.
**Frozen:** 2026-09-23, at a moment when this system holds **zero** real graded
outcomes. Nothing below was chosen after seeing a result, because no result
exists.

§119 asks for one simple question, frozen before testing, published even if
negative. This is that question. It is deliberately not the flow score, not the
sweep detector, and not a multi-feature model — those are §173's business, and
testing them first is how a search gets laundered into a discovery.

---

## Question

Among **SPY** option executions during regular trading hours, classified
`BUY_LIKELY` against a causally valid NBBO, on **simple** (non-complex)
conditions, above a frozen premium threshold — is the distribution of SPY's
**+15 minute** return different from matched controls?

## Economic rationale, stated so it can be wrong

If aggressive option buying carries information, the most likely mechanism is
an informed participant paying the spread for convexity ahead of a move. SPY is
the hardest case for that story — deepest, most hedged, most arbitraged — which
is *why* it is first. A weak effect here is more informative than a strong
effect in an illiquid name, where it would be indistinguishable from the
market-maker inventory story.

**The null this is built to be beaten by:** aggressive option buying clusters
around volatility, and volatility is autocorrelated. Any apparent edge may be
nothing but "something was already happening."

## Frozen definitions

| | |
|---|---|
| universe | SPY only |
| session | regular hours, per `market/calendar.ts`; `UNKNOWN` dates excluded, never assumed open |
| side | `BUY_LIKELY` only — **`BUY_LEANING` excluded**, because the whole question is whether the classification carries information and a leaning label mixes two claims |
| conditions | simple only; `POTENTIAL_COMPLEX` and above excluded |
| premium | ≥ $50,000 per signal |
| primary endpoint | SPY underlying return, `decisionAt` → `decisionAt + 15m`, sign-adjusted for the implied direction |
| horizon | **M15 only.** M15/H1/D1 from one signal are three readings of the same signal, not three samples (§104) |
| exclusions | synthetic; `EVENT_TIME_ONLY`; rights-refused; any signal whose window overlaps a `collection_gaps` row |

## Matched controls (§106) — all four, not a subset

1. **A** — the signals above.
2. **B** — equally large aggressive SPY option trades classified `SELL_LIKELY`.
3. **C** — matched random SPY *option-event* times, same session, same hour.
4. **D** — matched random SPY *underlying* times, same session, same hour.

**The question C and D exist to answer:** does the detector add anything beyond
"a large option trade happened", and beyond "it was this time of day"? If A ≈ C,
the signal is a clock.

## Failure criterion, written before any data

The hypothesis is **rejected** if any of these holds:

- the 95% CI for the A-vs-C difference includes zero;
- A and B are indistinguishable (the classifier carries no directional
  information, whatever the returns do);
- the effect survives only when `BUY_LEANING` is folded back in;
- a single session or a single week supplies most of the effect;
- effective sample (§103) after clustering by `underlyingDayId` is < 30, whatever
  the raw row count says;
- the effect does not survive plausible aggressor-classification error (§114),
  measured against a truth set — **and if no truth set exists, the result is
  `INCONCLUSIVE`, not `SUPPORTED`.**

## Stopping rule

Data collection stops at a **pre-committed calendar date**, not when
significance appears (§113). No interim look decides anything.

## What makes this untestable today

Every one of these, and the list is the point:

- **zero real signals** — the recorder holds synthetic only;
- **no entitled options source** (F-7), so there is no path to one;
- **no truth set**, so classification error is unquantified and the last failure
  criterion cannot even be evaluated;
- **`markSources` lists one vendor**, and it is entitled to 2 of 10 symbols over
  its socket — SPY is **not** one of them, so the underlying mark for this exact
  hypothesis arrives only over a REST path paced to ~19 minutes, which is longer
  than the horizon being measured.

That last one is worth sitting with: **the first hypothesis this system would
want to test is one its only mark source cannot currently price at the
resolution the test requires.** That is not a reason to pick an easier question.
It is a measurement of how far away the research program is, and it belongs in
the record rather than in a plan.
