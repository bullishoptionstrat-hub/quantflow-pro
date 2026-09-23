# PROVIDER DECISION RECORD

**The question.** F-7 is the binding constraint on this entire system: there is
no entitled real options-event source, so every microstructure finding in
`FORENSIC_AUDIT.md` is about code correctness rather than about markets, and
every research phase is blocked. This record exists to turn that from a wall
into a **costed decision the operator can actually make** (§185: prepare the
decision, never make the purchase).

**Status:** decision NOT made. No subscription purchased, no agreement signed,
no account upgraded. Nothing in this document authorises spend.

**Written:** 2026-09-23. **Re-review by:** before any purchase, because every
figure below carries a verification status and most of them are `SEARCH_ONLY`.

---

## 0. Verification status — read this before any number below

| Tag | Meaning |
|---|---|
| `MEASURED` | observed from this repository or a live API call made here |
| `SEARCH_ONLY` | from web search result summaries; **the primary document was not read** |
| `UNVERIFIED` | stated by a secondary source and not corroborated |

**Every vendor price and every licensing clause below is `SEARCH_ONLY`.** The
environment's network policy denied `databento.com`, `thetadata.net`,
`opraplan.com`, `cdn.opraplan.com` and `sec.gov`, so no primary document was
read. Under this repository's own rule — established when the Twelve Data
terms were read, where citing a document *by description* instead of by its
definition produced a wrong citation — **no clause below may be promoted into
`provenance/rights.ts` as a `quotedRestriction` until it has been read from the
publisher's own page and matched literally.** A summariser's paraphrase in that
field would be a fabricated quote in the one place this repo promises there are
none.

---

## 1. The decisive finding, and it is not a price

The naive framing — *"pick a vendor, pay ~$200/month, stream OPRA"* — appears
to be **wrong for this architecture**, for a reason that has nothing to do with
which vendor is chosen.

OPRA separately licenses **Non-Display Use**, and by the definition reported
consistently across sources (`SEARCH_ONLY`), that category covers accessing or
processing OPRA data *"for a purpose other than in support of the data
recipient's display"*, explicitly including **investment analysis**,
**surveillance programs**, and **a trading engine that performs automated
trading, algorithmic trading or program trading** — and it applies **whether or
not the use is made on a device that is also displaying the data**.

Read against this repository: `flowEngineAdapter.ts` → `flow-engine/` →
`score.ts` → `recorder.ts` → `grader.ts` is a program that consumes option
trades and quotes to classify, score, persist and grade them. That is
processing for a purpose other than display. **The terminal also displaying the
prints does not remove the classification.**

Consequences, if the definition holds on reading the primary document:

- The vendor's monthly plan price is **not** the cost. It is one line of it.
- Reported OPRA professional-subscriber real-time cost is **≥ ~$2,000/month**
  (`SEARCH_ONLY`), with non-display fees on top and in three categories.
- **Delayed** OPRA appears to be a different and far cheaper regime —
  non-professional access reported at *"a few dollars to roughly twenty-five
  dollars per month"* (`SEARCH_ONLY`) — and one source states delayed data may
  be displayed publicly without per-user fees.
- Non-Professional Subscriber status is reported to require *"personal
  non-business use"* (`SEARCH_ONLY`), which interacts directly with §21's
  deployment mode: it plausibly covers `PERSONAL_RESEARCH` and plausibly does
  **not** survive `CUSTOMER_FACING` or `PUBLIC_PRODUCT`.

**This is §190's chain arriving as a bill**: an API key is not entitlement,
entitlement is not a right to use, and the right to *display* is not the right
to run an engine over it.

---

## 2. Three provider functions, which need not be one provider (§26)

| Function | What it must do | Real-time required? |
|---|---|---|
| **LIVE OBSERVATION** | generate signals as the tape moves | yes — and this is where the non-display question bites hardest |
| **HISTORICAL RESEARCH** | point-in-time replay for registered experiments | **no** — this is the cheap path, and it is what Phases 7–9 actually need |
| **GROUND-TRUTH VALIDATION** | true side / open-close / package IDs to calibrate the aggressor and complex-link inferences (§52) | no |

**The ordering this suggests is the opposite of the intuitive one.** Live
observation is the most expensive, the most legally loaded, and the *least*
useful right now, because with zero registered hypotheses there is nothing for
a live signal to be evidence for. Historical research is cheap, is not
real-time, and is the input to every phase from §173 onward. A system with no
validated hypothesis does not need a live feed; it needs a testable past.

---

## 3. Candidates

Capability and price columns are `SEARCH_ONLY` throughout.

| Vendor | Options trades | OPRA NBBO | History | Reported price | Notes |
|---|---|---|---|---|---|
| **Databento** (`OPRA.PILLAR`) | yes, consolidated across all 17 venues | yes, incl. CBBO-1m | ~12 years reported | **$199/mo** "Standard" | Reports holding a *derived-use* licence with venues such that end users may use and redistribute derived output without further exchange licensing, subject to non-reverse-engineerability. **If true this is the single most important rights fact in this table** and it must be read from the agreement, not from a blog summary. Usage-based OPRA live pricing discontinued 2025-06-03. |
| **ThetaData** | yes — *"every trade reported by OPRA paired with the last NBBO quote reported by OPRA at the time of trade"* | yes | yes | **$40 / $80 / $160 /mo** retail tiers | The trade-paired-with-NBBO shape is **exactly** what `nbbo.ts` needs and what this repo currently has to infer. A free entry tier is advertised. |
| **Polygon / Massive** | plan-dependent | plan-dependent | plan-dependent | $29–$399/mo ladder, per asset class | **`MEASURED`:** the key held here returns **403 `NOT_AUTHORIZED` — "You are not entitled to this data"** on `/v3/trades/options`. Credentialed, not entitled. Rebrand in progress; published ladder should be re-read. |
| **Tradier** | streaming, brokerage-linked | yes | limited | account-linked | `MEASURED`: no token here. `TRADIER_STREAM` is already `PERMITTED` for both DISPLAY and PERSIST in the registry. Cheapest path to *some* real flow, but brokerage-account-gated. |
| **Cboe delayed CDN** | no — chain snapshots only | no | no | free | `MEASURED`: already integrated, already `UNVERIFIED` for display, and its own terms prohibit auto-extraction. Not a flow source and never will be. |

---

## 4. What decides it, in order

1. **Deployment mode (§21).** `PERSONAL_RESEARCH` and `PUBLIC_PRODUCT` are
   different legal systems. The repo already models this as `BUSINESS_MODE`
   and currently runs `PRIVATE_RESEARCH`. **The operator must state the
   intended mode before a provider is chosen**, because non-professional
   status and redistribution rights both turn on it and neither can be
   retrofitted.
2. **Whether the non-display classification applies.** If it does, live
   real-time OPRA is an order of magnitude more expensive than the vendor
   plans suggest, and the historical-first ordering in §2 becomes clearly
   correct rather than merely cheaper.
3. **Whether Databento's derived-use licence means what the summary says.**
   If it does, it is the difference between a research instrument that can
   publish a track record and one that cannot.
4. **Only then**, price.

---

## 5. Exact user actions (§185/§186 format)

**BLOCKER:** no entitled real options-event source (F-7).

**EVIDENCE:** live boot reports all five `RECORDABLE_SOURCES` down; the
recorder holds 83/83 synthetic; `collection_gaps` says `collecting=false`;
Polygon answers 403 `NOT_AUTHORIZED`.

**WHY IT MATTERS:** every research phase, every calibration, every claim about
predictive value is downstream of this. No engineering here removes it.

**EXACT USER ACTION — one of:**

- **(a) Cheapest real flow, today.** Supply a `TRADIER_TOKEN`. Already
  `PERMITTED` for DISPLAY and PERSIST in the registry; `markSources` would gain
  a second mark source ranked above Twelve Data. Brokerage account required.
- **(b) Research-first.** Open a **ThetaData** or **Databento** account for
  *historical* options trades+NBBO. Not real-time, so the non-display and
  professional-subscriber questions are narrower. This is what Phases 7–9 need
  and the only path that produces a registered experiment.
- **(c) Live.** Before paying any vendor, obtain OPRA's own answer on
  subscriber status and non-display classification for this architecture.
  **That is a question for OPRA or the vendor's licensing desk, not for code.**
- **(d) Nothing yet.** Legitimate. Phase 0 and the F-8/F-10 engineering
  continue without it.

**WORK THAT CONTINUES REGARDLESS:** `RISK_REGISTER.md`,
`DATA_RIGHTS_MATRIX.md`, ADRs, research scaffolding, F-8 (corrections/cancels
and event ordering), F-10 (AM settlement, holiday calendar).

---

## 6. What this record does NOT establish

- **No primary document was read.** Five relevant hosts were denied by the
  network policy. Every price and every clause is `SEARCH_ONLY` and none may
  enter `rights.ts`.
- **No vendor was contacted.** Capability claims are the vendors' own marketing
  as relayed by search summaries — which is precisely the `credentialed ≠
  entitled` gap in written form. A plan page saying "OPRA NBBO" is not an
  entitlement, as this repository already measured against Polygon.
- **No decision is recorded here**, because the deployment mode that would
  decide it has not been stated.
