# QuantFlow Evidence Engine — Tier-4 Final Report

**Date:** 2026-08-22
**Tree:** `/root/arch2` (`quantflow-pro` v3.0.0), baseline commit `fb515d2`
**Mandate:** convert the Tier-3 truth substrate into a system that can begin
collecting **trustworthy point-in-time options microstructure history**.

---

## 1. Verdict in one paragraph

The truth substrate is real and now enforced in three places — types, tests, and
database constraints. 226 executed tests pass, `npm run verify` exits 0, and
every gate that could be proven without credentials has been proven with a run,
not a description. **But the headline finding of this session is not an
engineering one.** A primary-source review of data rights found that four of the
sources QuantFlow already consumes carry published terms prohibiting the exact
access method the code uses, and that five of the eight preregistered hypotheses
cannot legally be run on the current sources. That is the binding constraint on
this product, and it is larger than anything in the codebase.

---

## 2. The finding that changes the plan

From `cboe.com/delayed_quotes/`, capitalisation theirs:

> "IT IS STRICTLY PROHIBITED TO DOWNLOAD DELAYED QUOTE TABLE DATA FROM THIS WEB
> SITE BY USING AUTO-EXTRACTION PROGRAMS/QUERIES AND/OR SOFTWARE. CBOE WILL BLOCK
> IP ADDRESSES OF ALL PARTIES WHO ATTEMPT TO DO SO."

That sentence names the access method `gexEngine.ts` uses to obtain its option
chain. Three more, verified the same way:

- **FINRA** Terms of Use restriction (e) prohibits "data mining, scraping or
  harvesting tools (including robots)". Restriction (m) prohibits use "in
  conjunction with any machine learning, neural network, deep learning,
  predictive analytics or other artificial intelligence computer or software
  program" — which reaches the ML service directly.
- **OCC** prohibits "(p) use or launch any automated system, including 'robots',
  'spiders', or 'offline readers'".
- **Yahoo** (terms updated 2026-08-04) prohibits automated access outright,
  **including for private use**.

And the one most builders get wrong: **OPRA requires an executed Vendor
Agreement for external retransmission even of DELAYED data.** The fee waiver
waives fees, not the agreement.

Corroborating observation, not inference: our own probe of the Cboe chain
returned **HTTP 429** for both `SPY` and `_SPX` during this session, consistent
with the stated blocking. It was not retried or routed around.

Full quoted findings, source URLs and terms versions: **`docs/MARKET_DATA_RIGHTS.md`**.

### What this costs

| Feature | Built? | Status |
|---|---|---|
| GEX engine (Black-Scholes gamma, assumption surface) | Yes, working | Chain source prohibited — needs a licensed feed |
| DIX / sector DPI | Yes, working | FINRA (e) blocks retrieval; (m) blocks any modelled version |
| OCC clearing panels | Yes, working | Automated retrieval prohibited; private position unstated |
| 0DTE / put-call | Yes, working | Same Cboe terms |
| Public commercial surface | Not enabled | Refused by code (Gate 6) |

The **engines are not wasted** — each is source-agnostic behind a fetch layer.
What must change is sourcing, not architecture.

---

## 3. Gate 6 — rights enforcement is code, not a memo

`packages/domain/src/dataRights.ts` (264 lines, 13 tests). Every dataset carries
a `RightsClass` per business mode, the quoted restriction, the terms URL and the
terms version.

```ts
const mode = resolveBusinessMode();          // fails closed to PRIVATE_RESEARCH
assertRights("CBOE_DELAYED_CHAIN", mode);    // throws RightsViolationError
```

Proven behaviours:

- every dataset classed `PROHIBITED` is refused in `PUBLIC_COMMERCIAL`
- Yahoo is refused in `PRIVATE_RESEARCH` too, because its prohibition is written
  against the *access method*, for any purpose
- `COMMERCIAL_RIGHTS_UNVERIFIED` never counts as permitted in either mode —
  uncertainty resolves to refusal, not to "probably fine"
- a blank or trivial `rightsBasis` override does **not** unlock a dataset; the
  override requires a substantive justification string, which becomes the record
- `resolveBusinessMode` rejects typos (`"PUBLIC"`, `"yes"`) rather than degrading
  to the permissive branch
- the thrown message **quotes the terms**, so whoever hits it sees the actual
  restriction rather than "not allowed"

---

## 4. What was built this session

| Module | Lines | Tests | Phase / Gate |
|---|---|---|---|
| `decisionTime.ts` | 188 | 11 | Gate 1 |
| `fingerprint.ts` | 145 | 11 | Gate 2 |
| `quoteContext.ts` | 323 | 17 | Phases H/I/J/K |
| `dataRights.ts` | 264 | 13 | Gate 6 |
| `optionSymbol.ts` | 285 | 20 | Phase F |
| `coverage.ts` | 384 | 19 | Phases L/M/N |
| `experiment.ts` | 405 | 21 | Phases S/T/U |
| `gapLedger.ts` | 212 | 19 | Phase Q |
| `marketTime.ts` (extended) | 219 | — | Gate 7 |
| `rawSpool.ts` | — | 8 | Phase R |
| `gexEngine.ts` | — | live-verified | GEX v5 |
| `preregistrations.ts` | — | 10 | Phase T |

Plus two migrations (`20260821`, `20260822`) and four documents.

---

## 5. Gate 1 — decision time

`decision_at = max(last_event_at, last_received_at) + classifierLatencyMs`.

The naive `first_event_at` is wrong for exactly the reason the mandate gives: a
signal assembled from a 500 ms burst was not actionable at the burst's first
tick. Using `first_event_at` grants the backtest 500 ms of free information and
makes every excursion measurement optimistic.

Enforced in three layers:

- **types** — `computeDecisionAt()` throws `DecisionTimeError` on an inverted
  timeline
- **tests** — 11, including the mandate's exact 500 ms burst case
- **database** — `CHECK (decision_at >= last_event_at >= first_event_at)`

`isForwardObservation()` uses strict `>`; equality is rejected, because an
observation at exactly the decision instant is not forward of it.
`computeExcursion()` returns `undefined`, never `0`, when there is nothing to
measure — a zero excursion and an unmeasurable one are different facts.

Legacy rows that predate the columns are flagged `LEGACY_AMBIGUOUS_DECISION_TIME`
rather than back-filled with a guess.

---

## 6. Gate 2 — content fingerprint

`signalContentHash()` is a deterministic SHA-256 over the immutable economic
fields, with canonical normalisation (sorted keys, `toFixed(9)` numbers, sorted
arrays, `undefined` → `null`).

`reconcileWrite(existing, incoming)` returns one of three verdicts:

| Verdict | Meaning |
|---|---|
| `INSERT` | new content |
| `IDEMPOTENT_REPLAY` | same id, same content — safe |
| `HISTORY_COLLISION` | **same id, different content** — recorded, never overwritten |

The third is the point. Treating every duplicate id as idempotent silently
accepts a rewrite of history. Collisions land in `signal_write_incidents`.

Proven: raw-event **arrival order** does not change identity; quality-flag order
does not change identity; a changed premium, side, or leg does.

---

## 7. Gate 3 — outcome immutability

A graded outcome cannot be edited or deleted. Supersession is the only path, and
it preserves both revisions:

- `enforce_outcome_immutability()` trigger rejects in-place label changes
- `DELETE` is rejected
- `superseded_at` (plain timestamp, retires the row) is separate from
  `superseded_by` (FK, linked after insert)

That split solved a real chicken-and-egg deadlock: a partial unique index keyed
on `superseded_by IS NULL` made it impossible to insert the new revision (the old
one was still live) and impossible to mark the old one (the new one did not
exist). Splitting the two columns breaks the cycle.

Proven against a real PostgreSQL 16 instance: label flip rejected, `DELETE`
rejected, supersession preserving both revisions (0.25 → −0.10).

---

## 8. Gate 4 — classification honesty

`SWEEP` became `SWEEP_LIKE`, enforced by a `CHECK` constraint. We infer a sweep
from observable multi-venue near-simultaneous prints; we do not observe an order
router's intent. The `_LIKE` suffix is the difference between a measurement and a
claim. Ten legacy rows were migrated; the original value is retained in
`legacy_kind`.

---

## 9. Gate 5 — research data is not public by default

Tier-3 shipped `signals_public_read` and `outcomes_public_read` with
`USING(true)`. Signal rows are reconstructable OPRA-derived microstructure. Those
policies were **dropped**; RLS is now default-deny on all five tables, and the
service role is the only research path.

One approved public surface exists: `v_public_signal_stats`, which emits counts
and rates only and returns `INSUFFICIENT_SAMPLE` below n=30.

Proven, and proven the *right* way. A naive local test is misleading: without a
table-level `GRANT`, the local `anon` role is refused at the privilege layer
(`permission denied for table signals`), which proves nothing about RLS. Supabase
grants `anon` SELECT by default, so **RLS must be what stops the read there**.

The proof therefore grants `anon` SELECT first, exactly as Supabase does, and
*then* checks:

```
grant select on signals, signal_outcomes, coverage_manifests,
                data_gaps, signal_write_incidents to anon;
set role anon;

          tbl           | count
------------------------+-------
 signals                |     0
 signal_outcomes        |     0
 coverage_manifests     |     0
 data_gaps              |     0
 signal_write_incidents |     0

 legacy_public_policies |     0
```

And the approved view suppresses the small sample rather than publishing it:

```
 classification | horizon | n_total | n_graded | hit_rate_graded | suppression_reason
----------------+---------+---------+----------+-----------------+---------------------
 SWEEP_LIKE     | D1      |       1 |        1 |                 | INSUFFICIENT_SAMPLE
```

---

## 10. Gate 7 — market calendar coverage

`marketTime.ts` now carries an explicit `FALLBACK_COVERED_YEARS = [2025, 2026,
2027]` and `assertCalendarCoverage()`, which throws `CalendarCoverageError`
outside that range rather than silently applying a stale holiday table to a year
it does not know. All ET conversion uses `Intl.DateTimeFormat` with
`America/New_York` — never a hardcoded UTC-4, which is wrong for four months of
every year.

---

## 11. Phase F — OSI symbol normalization (a real defect found and fixed)

The prior parser was:

```
/^([A-Z^]{1,6})(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/
```

Three defects, each **silent**:

1. **Adjusted-series roots contain digits** (`SPY1`, `2SPY`, `AAPL2` after a
   corporate action). `[A-Z^]{1,6}` rejected them, so a non-fungible deliverable
   returned `null` — indistinguishable from corrupt input. Adjusted series must
   be excluded, but excluded *loudly*, as a counted outcome.
2. **Cboe's underscore index roots** (`_SPX`, `_VIX`) were rejected outright.
3. **Strike identity round-tripped through a float**: `parseInt(raw)/1000` then
   `toFixed(3)`. The OSI strike field is an integer number of thousandths; that
   integer is the identity, and the float is a rendering of it.

`optionSymbol.ts` fixes all three. Rejections are **values with reasons**, never
`null` or a throw, so every dropped row is attributable. `parseOsiBatch()` keeps
`adjustedExcluded` **separate from** `rejected` — conflating them is how parser
drift hides behind an expected exclusion count.

20 tests, including leap-day validation against the actual year (2028-02-29
parses; 2026-02-29 is rejected), sub-dollar strikes, five-figure index strikes,
weekly roots staying distinct from their monthly parent, and a **100,000-case
adversarial fuzz** that must never throw (it doesn't; fewer than 100 random
strings look valid).

`oiConsensus.ts` now delegates to it and logs the exclusion/rejection tally.

**Honest limitation:** the live differential check against a real Cboe payload
(`backend/scripts/verify-osi-parser.ts`) could not run — HTTP 429, see §2. The
parser rests on unit tests and the fuzz, not on a live payload comparison.

---

## 12. Phases H/I/J/K — quote context and aggressor inference

`QuoteBook` plus `resolveQuoteContext()` classify how well a trade can be matched
to a quote: `EXACT_PRICE_MATCH`, `TIMESTAMPED_QUOTE_MATCH`, `RECENT_MATCH`,
`QUOTE_DIFFERENT`, `LOCKED`, `CROSSED`, `MISSING`, `UNKNOWN`.

The load-bearing rule: **`quoteAgeMs` is NULL unless the quote carries a
`bidSourceTs`.** A vendor timesale that bundles a bid/ask without a quote
timestamp is not timestamp-aligned NBBO, and calling it that is the specific
error the mandate names. Unknown age hard-caps aggressor confidence at 0.5.

`inferAggressor()` returns `BUY | SELL | MID | UNKNOWN` with confidence,
methodology, evidence, **and stated weaknesses**. 17 tests.

---

## 13. Phases L/M/N — coverage manifests

Full treatment in **`docs/RESEARCH_PROTOCOL.md` §1**. Summary:

`CORE_RESEARCH` (frozen panel, claims permitted) vs `DISCOVERY` (dynamic,
claims forbidden), with an orthogonal `SamplingBasis` so a frozen panel is never
described as a market sample.

`assertResearchGradeCoverage()` refuses a sample that spans two manifests, cites
an unknown manifest, contains a symbol outside its manifest, or contains an
observation dated outside the manifest's window. `membersAsOf(t)` reads the
manifest in force *then* — the survivorship guard.

Mirrored in Postgres by an `EXCLUDE USING gist` constraint that makes overlapping
manifests structurally impossible, a mint-once trigger, and a `BEFORE INSERT`
trigger on `signals` rejecting any signal outside its cited manifest's window.
19 tests.

---

## 14. Phase Q — data gap ledger

`OBSERVED_EMPTY` (we were collecting, nothing happened — this is data) vs
`NOT_OBSERVED` (we were not collecting — this is an absence of data).

The distinction matters in a *flattering* direction: outages cluster in volatile
sessions, because rate limits bite hardest when volume spikes. Silently dropping
them removes exactly the periods where a signal would be tested hardest.

`assertCollectionIntegrity()` refuses a research window with any non-benign gap
unless a tolerance is explicitly declared, and says why:

> *Aggregating across this window would present an outage as market quiet.*

`MARKET_CLOSED` is benign and does not reduce coverage. Overlapping gaps are
merged, not double-counted; gaps are clipped to the query window. 19 tests.

---

## 15. Phase R — append-only raw spool

CRC32 + length-prefixed NDJSON with torn-tail recovery. 8 failure-injection tests
against a **real filesystem** — truncated records, corrupted CRC, partial writes.
A torn tail truncates cleanly at the last valid record rather than corrupting the
segment or silently returning garbage.

---

## 16. Phases S/T/U — experiment registry and preregistration

Full treatment in **`docs/RESEARCH_PROTOCOL.md` §3**. The registry makes four
failure modes mechanically hard: HARKing, unreported multiplicity, holdout burn,
and silent negatives. 21 tests.

**Eight hypotheses preregistered 2026-08-22**, all with forward windows
(collection opens 2026-09-01; holdout 2027-03-01 → 2027-06-01), 39 declared
specifications across the eight families.

**Five of eight are BLOCKED on data rights.** They are retained in the count
rather than dropped, because dropping them would make the surviving programme
look cleaner than the one we actually designed.

**No result exists for any hypothesis**, and this is asserted by test: every seal
is `SEALED`, every status is `PREREGISTERED`, every verdict is `undefined`.

---

## 17. GEX v5 — live-verified, and honestly qualified

Real Black-Scholes gamma. `bsGamma()` returns `undefined` — not `0` — on
degenerate input. Units are documented in the code:
`dollarGamma = gamma × OI × 100 × spot² × 0.01`.

Live run (before the 429s): **SPY, 8,225 contracts, net −$5.71B per 1% move, data
confidence 0.751.**

`GexDataConfidence` is explicitly a *data* confidence, kept separate from any
trading confidence, so a well-measured number over a thin chain cannot be read as
a strong signal.

**The assumption-sensitivity result is the important part:**

| Positioning assumption | Net GEX |
|---|---|
| `CONVENTIONAL` | **−$5.71B** |
| `INVERTED` | **+$5.71B** |

An exact sign flip, driven entirely by an assumption that cannot be verified from
public data. Every GEX number QuantFlow publishes must carry this, and
`QF-GEX-001`'s decision rule requires reporting the result under all three
assumptions. *A finding that exists only under one unverifiable assumption is
reported as assumption-dependent, never as an edge.*

---

## 18. Cross-source OI — a negative result, kept

OCC and Cboe agreed to **0.000% across 7,328 SPY contracts / 22,028,876 OI**, and
byte-identically on QQQ.

Byte-identical totals across ~13,800 contracts is **not** what two independent
measurements look like. The overwhelmingly likely explanation is that Cboe
republishes OCC cleared OI. This is encoded as `sourcesLikelyIndependent: false`
and stated in the provenance block:

> *Agreement here validates our PARSERS, not the underlying number. Do not
> present it as independent corroboration.*

This is a negative result about a feature that was built, and it is retained.

---

## 19. Simulation quarantine

Production emits **zero** synthetic events — test-proven, not asserted. `DEMO`
mode tags every event `synthetic: true`. This addresses the `arch2` reality that
Session 1 missed by auditing the wrong tree (see `docs/TIER4_BASELINE.md` §1).

---

## 20. Backup — an untested backup is not a backup

Two real defects were found only by performing an actual restore drill:

1. `pg_dump --schema=public` emits `CREATE SCHEMA public`, which collides with
   the schema every database already has.
2. It references extension functions (`public.uuid_generate_v4`) **without**
   carrying the `CREATE EXTENSION` statements that define them, because
   extensions live outside `public`.

Both are invisible on Supabase, whose projects pre-provision `public` and the
extensions. They surface only during actual recovery — which is the worst
possible time to discover them.

A third defect was a race: `gunzip -c | grep -q` SIGPIPEs `gunzip`
intermittently under `pipefail`. Fixed by decompressing to a temp file first.

The workflow now captures the extension list alongside the dump and the drill
restores into a throwaway Postgres.

---

## 21. Verification results

```
npm run verify

  domain      162 tests  162 pass  0 fail
  backend      50 tests   50 pass  0 fail
  flow-engine  14 tests   14 pass  0 fail
  tsc --noEmit -p backend/tsconfig.scripts.json   EXIT 0
  python -m compileall ml-service                 EXIT 0

  TOTAL 226 tests, 0 failures.   EXIT 0
```

Baseline at `fb515d2` was 91 executable tests. Tier-4 added 135.

---

## 22. Database gate proofs — executed

`scripts/gate-proofs.sql` runs every DB-layer gate against a real PostgreSQL 16
instance. Each statement is either an operation that **must succeed** or one that
**must be refused**; the refusals are the proof, so the script runs with
`ON_ERROR_STOP off` and prints them.

Executed 2026-08-22 against a database rebuilt from `supabase/migrations/*.sql`.
**Every gate behaved as specified.** Abridged output:

```
GATE 1a  decision_at before last_event_at
         ERROR: violates check constraint "signals_decision_after_evidence"
GATE 1b  decision_at = last_event + 104ms                                ACCEPTED
GATE 1c  last_event_at before first_event_at
         ERROR: violates check constraint "signals_decision_after_evidence"
GATE 1d  event_at column comment: "DEPRECATED - ambiguous (\"first print in the
         cluster\"). Never use for research windows; use decision_at."

GATE 2a  same id / different content -> HISTORY_COLLISION incident recorded
GATE 2b  invented incident type      ERROR: check constraint "incident_type_valid"
GATE 2c  original signal unchanged:  g1-ok | 55200 | hash-g1-ok

GATE 3a  flip a graded label in place
         ERROR: outcome ... is GRADED (evaluated_at=...) and immutable.
                To correct it, insert a new outcome row with supersedes=...
GATE 3b  DELETE a graded outcome
         ERROR: signal_outcomes is append-only: DELETE on outcome ... rejected
GATE 3c  supersession preserves BOTH revisions:
           rev 1 | POSITIVE |  0.25 | SUPERSEDED | regrade: corrected mark ...
           rev 2 | NEGATIVE | -0.10 | LIVE       |
GATE 3d  a second LIVE row for (signal, horizon)
         ERROR: duplicate key violates unique constraint "uq_outcomes_live"

GATE 4a  classification 'SWEEP'      ERROR: check "signals_classification_valid"
GATE 4b  g1-ok | legacy_feed_kind=SWEEP | classification=SWEEP_LIKE

GATE 5   (see section 9 — all five tables return 0 rows to anon WITH SELECT granted)

L1  overlapping CORE_RESEARCH manifest
    ERROR: conflicting key value violates exclusion constraint "coverage_no_overlap"
L2  adjacent (tiling) manifest                                           ACCEPTED
L3  DISCOVERY manifest over the same window                              ACCEPTED
L4  CORE_RESEARCH + DYNAMIC_ATTENTION  ERROR: check "coverage_core_not_dynamic"
L5  trivial change reason        ERROR: check "coverage_change_reason_substantive"
L6  edit a minted member list
    ERROR: coverage_manifests is mint-once: manifest cov-core-v1 cannot change its
           member list, universe, sampling basis or start instant.

N1  signal decision_at outside its cited manifest
    ERROR: signal n1-bad has decision_at 2026-08-01 14:00:00+00 outside manifest
           cov-core-v1 window [2026-09-01 00:00:00+00, 2026-12-01 00:00:00+00)
N2  the same signal inside the window                                    ACCEPTED
N3  signal citing an unknown manifest
    ERROR: signal n3-bad cites unknown coverage manifest cov-core-v99

Q1  inverted gap interval        ERROR: check constraint "gap_window_ordered"
Q2  valid gap                                                            ACCEPTED
Q3  invented gap kind            ERROR: check constraint "gap_kind_valid"
Q4  trivial gap reason           ERROR: check constraint "gap_reason_substantive"
```

**23 DB-layer assertions: 16 refusals that had to be refused, 7 operations that
had to succeed. All 23 behaved as specified.**

Two honest notes on the environment:

1. `20240707000000_initial_schema.sql` **cannot apply locally** — it references
   `auth.users`, which exists only on Supabase. A local run needs stubs: the
   `auth` schema, the `anon` / `authenticated` / `service_role` roles, and the
   `pgcrypto` + `uuid-ossp` extensions.
2. These proofs are against local PostgreSQL 16, **not** the hosted Supabase
   project — no credentials exist. The migrations are identical, but hosted
   behaviour is *expected*, not *observed*, until the script is run there.

---

## 23. Credential wall — what could not be done, and why

No Tradier, Supabase, or R2 credentials exist in this environment. The following
are **physically impossible here** and are reported as such rather than
simulated:

| Item | Requires |
|---|---|
| Phases A–D — live Tradier stream audit | Tradier credentials |
| Phase O — empirical stream capacity | A live stream |
| Phases W–Y — FlowEngine shadow on real events, forward collection | A live stream |
| Gates 8, 9, 14 | Live stream + hosted Supabase |
| Hosted RLS observation | Supabase project credentials |
| Off-site backup copy | R2 credentials |

Nothing was fabricated to fill these. A test that has not run is reported as not
run.

---

## 24. New critical defects found this session

Ranked by consequence.

1. **Data rights prohibit the access method for four live sources** (§2). This is
   the largest finding of the engagement and it is not an engineering defect —
   it is a sourcing one. It blocks five of eight hypotheses and any public
   commercial surface.
2. **OSI parser silently dropped adjusted series and index roots** (§11). Real
   contracts vanished into `null` alongside corrupt input, with no counter
   distinguishing them.
3. **Strike identity round-tripped through a float** (§11). Contract identity —
   the join key for OI consensus, GEX, and every reconstruction — depended on
   floating-point behaviour.
4. **Coverage was never recorded**, so no study could prove a fixed denominator
   (§13). Now enforced in code and in the database.
5. **Gaps were never recorded**, so an outage was indistinguishable from a quiet
   market (§14).
6. **No experiment registry existed at all** — the search size, holdout state and
   negative results had nowhere to live (§16).

---

## 25. What is still true and unresolved

Six open questions that cannot be closed from published documents. Each is a
written question to a named party, not a research task:

| # | Question | Blocks |
|---|---|---|
| 1 | Do FINRA's Terms of Use reach `cdn.finra.org`, or only `finra.org`? | DIX legitimacy |
| 2 | Does FINRA restriction (m) prohibit *training on*, *inference over*, or both? | Entire ML roadmap |
| 3 | Does OCC's automated-system prohibition permit internal, non-commercial retrieval? | OCC panels |
| 4 | Is there a licensed Cboe chain product at a self-hosted price point? | GEX viability |
| 5 | Cost and eligibility of an OPRA Vendor Agreement for delayed-only display | Any public options display |
| 6 | May GICS sector labels be displayed in a commercial product? | Sector rotation UI |

---

## 26. Honest limitations of everything built here

A protocol that sounds airtight is the most dangerous kind, so:

- **None of this creates an edge.** Every gate can only reject a false finding.
  None can manufacture a true one.
- **Process rigour over prohibited data is still prohibited.** The registry does
  not solve §2.
- **The registry checks timestamps, not memories.** It cannot detect a hypothesis
  formed from prior exposure to similar data.
- **`declaredFamilySize` is self-reported.** The registry corrects against the
  larger of declared and actual, but cannot know about a search never recorded.
- **Nothing has seen forward data.** Every research module is tested on
  constructed inputs. The protocol is proven *correct*; it is not yet proven
  *useful*, and will not be until the first holdout is opened in March 2027.
- **DB gates are proven locally, not on Supabase.** Hosted RLS behaviour is
  expected, not observed.
- **The OSI parser is not live-differential-verified** (§11).

---

## 27. Ranked recommendations

1. **Send rights questions 1, 2 and 5.** They gate the three largest features.
   Everything downstream is speculative until they are answered. This is the
   highest-value action available and it costs three emails.
2. **Do not enable `BUSINESS_MODE=PUBLIC_COMMERCIAL`.** The default already
   refuses; leave it there.
3. **Price a licensed chain source for GEX.** The engine is source-agnostic —
   only the fetch layer changes. This converts a blocked feature into a working
   one without a rewrite.
4. **Replace the Yahoo price lookup.** Prohibited *and* fragile (v7 returns 401,
   Stooq returns 404). Weakest link on both axes.
5. **Start forward collection on the three runnable hypotheses.** `QF-FLOW-001/2/3`
   depend only on Tradier, whose private-research position is clean. Collection
   is the asset being built and nothing above blocks it.
6. **Get Tradier credentials into a staging environment** so Phases A–D and O can
   actually be measured rather than deferred a fourth time.
7. **Run `scripts/gate-proofs.sql` against the hosted Supabase project** once
   credentials exist, so the RLS claim becomes observed rather than expected.
8. **Commit this work.** It is uncommitted on top of `fb515d2` because branch
   policy has not been stated.

---

## 28. Scorecard

| Gate / Phase | Status | Evidence |
|---|---|---|
| Gate 0 — baseline | **PASS** | `fb515d2`, 91 tests, `verify` exit 0 |
| Gate 1 — decision time | **PASS** | 11 tests + DB constraint |
| Gate 2 — fingerprint | **PASS** | 11 tests + unique index + incident table |
| Gate 3 — outcome immutability | **PASS** | DB-proven: edit refused, DELETE refused, both revisions kept |
| Gate 4 — classification honesty | **PASS** | `CHECK`; 10 rows migrated |
| Gate 5 — RLS default deny | **PASS** | anon WITH SELECT granted sees 0 rows on 5 tables |
| Gate 6 — data rights | **PASS** | 13 tests + `MARKET_DATA_RIGHTS.md` |
| Gate 7 — calendar coverage | **PASS** | throws outside covered years |
| Gates 8, 9, 14 | **BLOCKED** | no credentials — §23 |
| Phase F — OSI normalization | **PASS** (not live-verified) | 20 tests incl. 100k fuzz |
| Phases H/I/J/K — quote context | **PASS** | 17 tests |
| Phases L/M/N — coverage | **PASS** | 19 tests + `EXCLUDE` constraint |
| Phase Q — gap ledger | **PASS** | 19 tests |
| Phase R — raw spool | **PASS** | 8 failure-injection tests |
| Phases S/T/U — experiments | **PASS** | 21 + 10 tests, 8 preregistrations |
| Phases A–D, O, W–Y | **BLOCKED** | no live stream — §23 |
| GEX v5 | **PASS** (source blocked) | live run; assumption surface |

**14 gates/phase-groups passed with executed evidence — 226 tests plus 23 DB-layer
assertions. 5 blocked by credentials. 5 of 8 hypotheses blocked by data rights.**

---

## 29. The one-sentence summary

The evidence engine works and is now enforced in types, tests and the database —
but before another line of collection code is written, someone needs to send six
emails, because five of the eight things we set out to measure cannot legally be
measured on the sources we are using.

---

### Documents produced

| File | Purpose |
|---|---|
| `docs/MARKET_DATA_RIGHTS.md` | Quoted terms findings, per-dataset classification, open questions |
| `docs/RESEARCH_PROTOCOL.md` | Coverage, gaps, experiments — how a number becomes believable |
| `docs/TIER4_BASELINE.md` | Gate 0: which tree, what `verify` covers, what it does not |
| `docs/TIER4_FINAL_REPORT.md` | This document |
| `scripts/gate-proofs.sql` | Re-runnable DB gate proofs |
