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

---

## Invariants this system cannot yet state

Recorded so they are not mistaken for satisfied:

- **Corrections and cancels.** No event type, sequence number or correction
  linkage exists (F-8). "A signal affected by a correction is recomputed or
  invalidated" is not expressible today.
- **Observation denominators.** `collection_gaps` records *outages*. It does
  not record the subscribed universe, strike/expiry coverage, or
  new-contract discovery, so §49's rule — do not report event frequencies as if
  based on complete observation — cannot be mechanically enforced.
- **Research/production feature skew.** There is no offline feature pipeline to
  compare against (§66), because there is no model.

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
