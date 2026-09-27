# QuantFlow Pro — System Invariants

Properties that must hold regardless of which connectors are configured, which
business mode is running, or what the UI is showing. Each names the test that
enforces it, or says plainly that none does.

An invariant with no test is a comment. Those are marked **UNENFORCED** rather
than quietly listed alongside the others.

---

| ID | Invariant | Enforced by | Status |
|---|---|---|---|
| **INV-001** | Synthetic data never enters the real track record. | `rights.test.ts`, `signalStore.test.ts`, `trackRecordRows.test.ts`; `SignalGrader.register()` refuses synthetic outright | **ENFORCED** |
| **INV-002** | A quote stamped after a trade never classifies that trade. | `nbboLookahead.test.ts` | **ENFORCED** |
| **INV-003** | A field a vendor did not send never silently becomes zero. | `defaultedReadings.test.ts` (ledger, both directions), `missingIsNotZero.test.ts`, `absentQuoteIsNotZero.test.ts` | **ENFORCED** |
| **INV-004** | Aggregate venue metadata never generates fictitious child executions. | `aggregateNotPrints.test.ts` — behaviour **and** a source scan banning the shape | **ENFORCED** *(this session)* |
| **INV-005** | One observed trade is never counted twice. | Partially: `identity.ts` content hash + `HISTORY_COLLISION` incident cover duplicate *signals*. No cross-provider trade dedup exists, because no second event provider exists. | **PARTIAL** |
| **INV-006** | Rights-denied data cannot persist into official research. | `rights.test.ts`, `recorder.test.ts`, `connectorGate.test.ts` | **ENFORCED** |
| **INV-007** | An entitlement failure cannot show a source as healthy for that capability. | `entitlement.test.ts`; `/api/health` carries `entitlement` per source and never overwrites `sources` | **ENFORCED** |
| **INV-008** | A signal's decision time never precedes the evidence it used. | `identity.test.ts`, `outcomeDecision.test.ts` (throws + DB CHECK). Extended this session to the **entry mark**: a mark stamped after the decision beyond `maxEntryMarkLookaheadMs` is refused. | **ENFORCED** |
| **INV-009** | A restart never permanently loses an eligible outcome. | `graderRecovery.test.ts` — including a guard that startup actually *calls* recovery | **ENFORCED** *(this session)* |
| **INV-010** | A non-directional structure never enters a directional accuracy metric. | `graderDirection.test.ts` — `STRADDLE_STRANGLE` grades UNGRADED; direction comes from the dominant leg | **ENFORCED** *(this session)* |
| **INV-011** | An incomplete observation is never reported as zero events. | `coverage.test.ts` — `OBSERVED_EMPTY` vs `NOT_OBSERVED` are separate verdicts and `collection_gaps` is written | **ENFORCED** |
| **INV-012** | A heuristic score is never presented as a probability. | `wireContract.test.ts` (no `ml_score`, no ML confidence renderer); `score_breakdown` published per component | **ENFORCED** |
| **INV-013** | Tomorrow's open interest never influences today's signal. | Nothing reads next-day OI, so the violation is not currently reachable — but no test asserts it, and §31 wants the volume/OI feature renamed so it cannot imply opening interest. | **UNENFORCED** |
| **INV-014** | Old documentation cannot activate a nonexistent feature. | `renderBlueprint.test.ts` (a variable read by no code fails), `schemaSetup.test.ts` (docs must name `supabase/migrations`). Does **not** cover README feature tables — see F-5. | **PARTIAL** |
| **INV-015** | A historical research result always identifies its code, data and coverage versions. | `SignalRecord` carries `source`, `datasetId`, `rightsClass`, `decisionBasis`; outcomes carry mark source and stamp. **No** `engineVersion`, `scoreVersion`, `configHash` or `codeCommit` is persisted (§35, §36). | **UNENFORCED** |


### Event truth, sessions, contracts, research and rights (Event Model V2, 2026-09-27)

IDs follow the directive's numbering. Every row names a test that fails when the
invariant is broken — each was confirmed by applying the plausible defect and
watching the named test fail (commit messages record the mutation passes).

| ID | Invariant | Enforced by | Status |
|---|---|---|---|
| **INV-EVENT-001** | A cancellation never makes the original observed event disappear. | `eventModelFixtures.test.ts` (every fixture: each appended trade is in the FINAL view and in `events()`), `eventModelProperties.test.ts` (stored events are frozen; `Reflect.set` refused) | **ENFORCED** |
| **INV-EVENT-002** | The final corrected tape can differ from the as-known tape, and neither overwrites the other. | fixtures 05, 06, 08, 20 (`ACTIVE` as known, `CANCELLED` final); FINAL is asserted equal to AS_KNOWN_AT(last arrival) for every fixture and 150 generated logs | **ENFORCED** |
| **INV-EVENT-003** | Late and out-of-sequence events are explicitly classified. | fixtures 03, 04, 09, 12: provider codes → `reportLifecycle`; arrival lateness → `LATE_EVENT` from the reorder buffer; the detector refuses both | **ENFORCED** |
| **INV-EVENT-004** | No event is finalised before its `availableAt`. | every fixture asserts `finalizedAt ≥ availableAt` for every emission; 300 generated streams in `eventModelProperties.test.ts` | **ENFORCED** |
| **INV-EVENT-005** | Provider sequence / order uncertainty is never silently treated as chronological certainty. | "order that cannot be established is not tie-broken" (a CNCL over two same-instant reports disputes both); emissions carry `orderBasis: TIE_BROKEN_BY_ID` | **ENFORCED** |
| **INV-SESSION-001** | Feed availability is not product tradability. | `sessionAuthority.test.ts`: OPRA window `SUPPORTED` while SPY is `UNKNOWN` (07:45); SPX `OPEN` while OPRA is `OUTSIDE_FEED_WINDOW` (21:00) | **ENFORCED** |
| **INV-SESSION-002** | Product tradability is not research eligibility. | `sessionAuthority.test.ts`: SPX `OPEN` in its curb session, an extended-hours trade `EXCLUDED` from H-001-v2 | **ENFORCED** |
| **INV-SESSION-003** | Provider session evidence outranks clock inference. | fixtures 14, 16; `sessionAuthority.test.ts` (identifier `1` at 10:00 ET is `EXCLUDED`; clock inference only on basis `NONE`, and only where the rule allows it) | **ENFORCED** |
| **INV-SESSION-004** | The OPRA ETH transitional encoding stays interpretable while both formats are valid. | fixture 15 (identifier at its default `0` beside `v` → `EXTENDED`, not a conflict); fixture 16 (a conflict needs an explicit, non-default regular value) | **ENFORCED** — on SEARCH_ONLY semantics; see `OPRA_EVENT_SEMANTICS.md` |
| **INV-CONTRACT-001** | Last trading time is product- and effective-date-specific. | `sessionAuthority.test.ts`: at 10:00 ET on 2026-10-16 SPX (AM) is `LAST_TRADING_DAY_ENDED` while SPXW (PM) is `OPEN`; SPXO before 2026-11-09 is `UNKNOWN`; unknown products carry no fabricated instant | **ENFORCED** — on UNVERIFIED rules |
| **INV-RESEARCH-001** | No holdout result is viewed without an exposure-ledger entry. | `researchIntegrity.test.ts`: the ledger's shape and closed role vocabulary, and that no row touches H-001-v2's confirmatory or holdout window. A file cannot stop a person opening data; it can make the record of doing so mandatory and checkable | **PARTIAL** — process, mechanically checked where a file can be |
| **INV-RESEARCH-002** | One economic event cannot become several observations because it generated several prints. | `aggregateNotPrints.test.ts` (INV-004) at the adapter; `researchIntegrity.test.ts` for the meta-event unit H-001-v2 freezes (`research/metaEvents.ts`) | **ENFORCED** |
| **INV-RIGHTS-001** | Technical accessibility does not promote a rights classification. | `historicalImport.test.ts` "a download is not a permission": `PERMITTED` without the permitting words, or on SEARCH_ONLY evidence, is a manifest problem and blocks the import gate | **ENFORCED** |

---

## Invariants this system cannot yet state

Recorded so they are not mistaken for satisfied:

- **Corrections and cancels on the LIVE path.** Event Model V2 represents
  them (INV-EVENT-001–005) for historical and fixture events, and signal
  revisions say what a correction means for each kind of research. The live
  path still enters as `RawPrint`, has no reorder buffer, and persists no V2
  events — it has no OPRA source to need them (§29). Until the first live
  OPRA adapter produces V2, "a live signal affected by a correction is
  revised" is not expressible for live data.
- **Observation denominators.** `collection_gaps` records *outages*. It does
  not record the subscribed universe, strike/expiry coverage, or
  new-contract discovery, so §49's rule — do not report event frequencies as if
  based on complete observation — cannot be mechanically enforced.
- **Research/production feature skew.** There is no offline feature pipeline to
  compare against (§66), because there is no model.
- **Vendor-data retention.** "No vendor Data is retained beyond the duration
  its licence permits" is not expressible, and the reason is not neglect.
  Twelve Data's 16.1 defers the duration to the subscription and 2.3 defers it
  to the Documentation — defined in Section 1 as the guide at
  `twelvedata.com/docs` — which names no retention timeframe at all, so the
  permitted duration has no value to enforce (read 2026-09-21; see
  `rights.ts`). **And it is in direct tension with an invariant that is
  enforced**: `enforce_outcome_immutability` refuses every `UPDATE` and
  `DELETE` on `signal_outcomes` except the single retirement path, so a
  retention sweep cannot be added without deciding which of the two guarantees
  yields. Recorded together because discovering that tension *while* writing
  the sweep is how one of them gets quietly weakened. The shape that resolves
  it, if a duration is ever established: expire the raw `entry_mark` /
  `exit_mark`, which are the vendor's Data, and keep `label` and
  `directional_return_at_horizon`, which are Derived Data under 2.2(c) — a
  ratio recovers no absolute price, though that ratio beside a *retained*
  entry mark recovers the exit exactly,
  so the marks have to go for the derivation to qualify. Not built: 16.2's
  30-day deletion obligation binds only on termination, `signal_outcomes` holds
  zero rows, and any window chosen today would be invented rather than derived.

---

## How to add one

An invariant enters this table **with its test in the same change**. The
recurring failure in this repository is not a missing rule — it is a rule that
exists in prose, or in code nobody calls: `listUngraded()` was implemented
twice, declared on the interface, exercised by two tests, and called by
nothing; `recordGap()` shipped with three CHECK constraints and no writer;
`dominantLegOf()` was written for a defect and applied only to the code path
nothing imports.

So a test that drives the behaviour is the minimum, and where the risk is
"correct but never called", a guard asserting the **wiring** belongs beside it.
