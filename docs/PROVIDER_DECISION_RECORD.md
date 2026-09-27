# PROVIDER DECISION RECORD

**The question.** F-7 is the binding constraint on this entire system: there is
no entitled real options-event source, so every microstructure finding in
`FORENSIC_AUDIT.md` is about code correctness rather than about markets, and
every research phase is blocked. This record exists to turn that from a wall
into a **costed decision the operator can actually make** (§185: prepare the
decision, never make the purchase).

**Status:** decision NOT made. No subscription purchased, no agreement signed,
no account upgraded. Nothing in this document authorises spend.

**Written:** 2026-09-23; **re-reviewed 2026-09-27 (§7)**. **Re-review by:** before any purchase, because every
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

---

## 7. Re-review 2026-09-27 — conformance against the research requirements (§16)

**Primary sources: still unreachable.** Re-probed 2026-09-27 13:21Z —
`www.opraplan.com`, `www.cboe.com`, `databento.com`, `www.thetadata.net`,
`docs.thetadata.us`, `www.sec.gov` each `CONNECT tunnel failed, response 403`;
`registry.npmjs.org` `200` as the control. **Nothing below is
`PRIMARY_VERIFIED` and nothing may enter `rights.ts` from this section.**

### The status vocabulary, extended

| status | meaning here |
|---|---|
| `PRIMARY_VERIFIED` | read in the primary document by this system, text matched literally — **none** |
| `PROVIDER_VERIFIED` | read in the vendor's own documentation by this system — **none** |
| `OPERATOR_REPORTED` | the operator audit of 2026-09-27 reports reading it at the source; **not read here**, so treated as `UNVERIFIED` for every code and registry purpose |
| `SEARCH_ONLY` | surfaced by a summarising search tool |
| `UNVERIFIED` | recalled |
| `LEGAL_INTERPRETATION_REQUIRED` | the question turns on what a clause means for this use |
| `DOCUMENTED_CAPABILITY_ONLY` | a provider page reportedly offers it; no sample has been pulled, no entitlement tested |

Operator-reported facts carried into this section, each `OPERATOR_REPORTED`:
OPRA Non-Display Use fees of $2,000/month per enterprise (Categories 1 and 2)
and $2,000 per platform (Category 3); OPRA's definition of "current" as within
the preceding 15 minutes, with no usage or device fees for delayed data;
Databento's TCBBO pairing each trade with the consolidated BBO immediately
before the trade's effect, with event and receive timestamps and publisher and
instrument identities; Databento's position that historical data (24h+)
generally needs no live exchange licence, except for redistribution;
ThetaData Standard at $80/month and Pro at $160/month, and `trade_quote` with
`exclusive=true` requiring the quote timestamp to be strictly before the trade;
ThetaData's subscriber agreement permitting internal research and restricting
furnishing OPRA data to others.

### The matrix — against H-001-v2 and Event Model V2, not against feature count

Each cell: `AVAILABLE` / `DERIVED` / `MISSING` / `AMBIGUOUS`, then its evidence.
Rows are ordered by how much of the study depends on them.

| requirement (why it matters) | Databento OPRA (`trades`, `tcbbo`, `definition`) | ThetaData (`trade_quote` exclusive, `trade`, `quote`) |
|---|---|---|
| **Cancels, late and out-of-sequence reports** (Event Model V2 exists for this; without them the final tape cannot be built) | `AMBIGUOUS` — whether OPRA message types reach the normalised schemas is not established; recalled that the normalised trade record carries flags, not OPRA types — **the first thing a sample must answer** | `AMBIGUOUS` — a `condition` field is reported; whether it is OPRA's message type or a vendor enumeration, and whether cancelled trades are delivered or silently removed, is not established |
| **Strictly pre-trade NBBO** (H-001-v2 §H) | `AVAILABLE`, `DOCUMENTED_CAPABILITY_ONLY` (TCBBO, operator-reported) | `AVAILABLE`, `DOCUMENTED_CAPABILITY_ONLY` (`exclusive=true`, operator-reported) |
| **Receive timestamp** (availableAt; H-001-v2 excludes `EVENT_TIME_LOWER_BOUND`) | `AVAILABLE`, `DOCUMENTED_CAPABILITY_ONLY` (operator-reported) | `AMBIGUOUS` — not established. **If MISSING, every ThetaData event is `EVENT_TIME_LOWER_BOUND` and H-001-v2 cannot use it as a sole source without a new version.** |
| **Trade event timestamp and its resolution** | `AVAILABLE`, `DOCUMENTED_CAPABILITY_ONLY` | `AVAILABLE` — millisecond of day reported; `UNVERIFIED` |
| **Provider sequence** (gaps, duplicates, reporting order for positional cancels) | `AMBIGUOUS` — recalled, not established for OPRA | `AMBIGUOUS` — listed as a focus by the audit, not established |
| **Venue / participant** | `AVAILABLE` (publisher id), `DOCUMENTED_CAPABILITY_ONLY` | `AVAILABLE` (trade exchange), `UNVERIFIED` |
| **Contract identity** | `AVAILABLE` (definition schema), `UNVERIFIED` | `AVAILABLE` (root, expiration, strike, right), `UNVERIFIED` |
| **Session identifier / `v`** | `AMBIGUOUS` — not established whether the post-2026-09-21 field or `v` is carried; irrelevant to H-001-v2's pre-2026-08 window | `AMBIGUOUS` — same |
| **Historical coverage of 2026-01-02..2026-08-14** | `AVAILABLE` (history reported to span years), `SEARCH_ONLY` | `AVAILABLE` by tier, `SEARCH_ONLY` |
| **SPY underlying quotes for the marks** (H-001-v2 §C) | `MISSING` from the OPRA dataset — a separate equities dataset, with its own rights | `AMBIGUOUS` — stock quotes reported on some tiers; not established |
| **Aggressor-side truth set** (H-001-v2 §K) | `MISSING` — OPRA carries no aggressor side | `MISSING` — same |

### What the matrix decides, and what it cannot

**Technical fidelity, independent of price:** it cannot be ranked yet, and
saying otherwise would be ranking by documentation. Both vendors document a
strict pre-trade quote. Everything that separates them — whether OPRA's own
message types (and so cancels and late reports) survive into the delivered
records, whether a receive timestamp exists, whether sequence numbers are
delivered — is `AMBIGUOUS` for both, and is exactly what the §17 small-sample
gate (`backend/src/events/importGate.ts`) is built to answer from one or two
real days. The first row decides the most: a source that delivers trades
without their cancel and late-report codes cannot build the final corrected
tape at all, whatever its quotes look like.

**Cost and ease, separately:** operator-reported retail prices put ThetaData
($80–$160/month) below Databento ($199/month, `SEARCH_ONLY`). For historical
data OPRA's non-display fees are reported not to apply (delayed is not
"current"), which removes the largest cost from §1 for the research path. None
of this is combined with fidelity into one score.

**Neither is purchasable on this record.** Both research manifests
(`research/manifests/`) are `UNVERIFIED` on every axis, with redistribution
`LEGAL_INTERPRETATION_REQUIRED`, and `importPermitted` refuses both. The
decision packet §28 asks for comes after the exit gate, and the gate cannot
pass while the primary documents are unread.
