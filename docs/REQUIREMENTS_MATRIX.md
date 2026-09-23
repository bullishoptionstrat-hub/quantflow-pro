# QuantFlow Pro — Requirements Matrix

Immutable IDs for material requirements. **Code existing is not verification.**
A requirement is `VERIFIED` only when a test drives it or a run demonstrated
it; `IMPLEMENTED_UNVERIFIED` is the honest status for everything else.

**Statuses:** `UNASSESSED` · `EXISTS_UNVERIFIED` · `DEFECT` · `IMPLEMENTING` ·
`IMPLEMENTED_UNVERIFIED` · `VERIFIED` · `BLOCKED_EXTERNAL` · `DEFERRED` ·
`REJECTED_WITH_REASON`

Last verified: **2026-09-19**, against `claude/quantflow-pro-forensic-audit-cnmsrv`.

---

## TRUTH — claims match evidence

| ID | Requirement | Location | Tests | Status |
|---|---|---|---|---|
| TRUTH-001 | No UI surface renders fabricated market data | `frontend/` — all `Math.random()` generators deleted | `wireContract.test.ts` | VERIFIED |
| TRUTH-002 | Simulated prints are marked per row, not per deployment | `FlowFeed.tsx`, `synthetic` on the wire | `wireContract.test.ts` | VERIFIED |
| TRUTH-003 | README feature table matches implemented capability | `README.md` | none | **DEFECT** (F-5) |
| TRUTH-004 | Product claims are generated from a capability registry | — | — | UNASSESSED (§7) |
| TRUTH-005 | Every value carries its epistemic class (OBSERVED/INFERRED/PROXY/…) | partial: `synthetic`, `side: AMBIGUOUS`, `moneyness: UNKNOWN`, `venue_allocation` | — | IMPLEMENTING (§8) |

## DATA — entitlement and availability

| ID | Requirement | Location | Tests | Status |
|---|---|---|---|---|
| DATA-001 | Credentialed ≠ entitled; entitlement is probed, not inferred | `ingestion/entitlement.ts` | `entitlement.test.ts` | VERIFIED |
| DATA-002 | Entitlement is probed per **capability**, not per provider | `entitlement.ts` probes one endpoint per source | — | **DEFECT** (§10) — a working equity endpoint must not imply options trades |
| DATA-003 | At least one entitled, rights-permitted options-event path exists | — | — | **BLOCKED_EXTERNAL** (F-7) |
| DATA-004 | A down source never presents itself as data | connectors report health per cycle | `deadSources.test.ts`, `twelveDataHealth.test.ts` | VERIFIED |
| DATA-005 | Absent readings are null, never zero | `optionalNumber.ts` + ledger | `defaultedReadings.test.ts` | VERIFIED |

## RIGHTS

| ID | Requirement | Location | Tests | Status |
|---|---|---|---|---|
| RIGHTS-001 | Every dataset classified per mode and per capability, failing closed | `provenance/rights.ts` | `rights.test.ts` | VERIFIED |
| RIGHTS-002 | A DISPLAY-prohibited connector is never started | `mayOperateConnector()` | `connectorGate.test.ts` | VERIFIED |
| RIGHTS-003 | Rights evidence records terms URL, quote and read date | `rights.ts` entries | `rights.test.ts` | VERIFIED |
| RIGHTS-004 | Rights split beyond DISPLAY/PERSIST (FETCH, TRAINING, REDISTRIBUTE, RETENTION…) | two axes only | — | UNASSESSED (§11) |
| RIGHTS-005 | Business mode is explicit and gates rights | `resolveBusinessMode()` throws on malformed | `rights.test.ts` | VERIFIED |

## TIME — point-in-time correctness

| ID | Requirement | Location | Tests | Status |
|---|---|---|---|---|
| TIME-001 | `decisionAt = max(lastEventAt, receivedAt, emittedAt)`, never first print | `persistence/identity.ts` | `identity.test.ts`, `outcomeDecision.test.ts` | VERIFIED |
| TIME-002 | A future-stamped quote never classifies an earlier trade | `flow-engine/nbbo.ts` | `nbboLookahead.test.ts` | VERIFIED |
| TIME-003 | An entry mark never postdates the decision beyond registration latency | `grader.ts` `maxEntryMarkLookaheadMs` | `graderRecovery.test.ts` | VERIFIED *(this session)* |
| TIME-004 | `availableAt` is tracked distinctly from event and receive time | — | — | UNASSESSED (§19) |
| TIME-005 | Out-of-order events cannot silently rewrite a finalized signal | watermark assumes ascending arrival | — | **DEFECT** (F-8, §20) |
| TIME-006 | Product-aware expiry/calendar, not a universal 20:00Z | three hardcoded sites | — | **DEFECT** (F-10, §33) |

## FLOW / NBBO — microstructure semantics

| ID | Requirement | Location | Tests | Status |
|---|---|---|---|---|
| FLOW-001 | One upstream record is one observed execution | `flowEngineAdapter.ts` | `aggregateNotPrints.test.ts` | VERIFIED *(this session)* |
| FLOW-002 | Venue evidence is distinguishable from observed venue diversity | `venue_evidence` / `venue_allocation` | `wireContract.test.ts` | VERIFIED *(this session)* |
| FLOW-003 | Classification names are bounded by evidence ("sweep-like", not "sweep") | `SWEEP`/`BLOCK`/`SPLIT` retained | — | UNASSESSED (§24) |
| FLOW-004 | Trade condition codes are retained and interpreted | `conditions` carried, not interpreted | — | UNASSESSED (§23) |
| FLOW-005 | Aggressor inference returns evidence, not just a side | side + engine penalty only | `nbboLookahead.test.ts` | UNASSESSED (§22) |
| FLOW-006 | Corrections and cancels have a defined policy | — | — | **DEFECT** (F-8, §21) |
| FLOW-007 | Contract identity preserves adjusted/nonstandard contracts | `occSymbol` constructed from parts | — | UNASSESSED (§18) |

## SCORE

| ID | Requirement | Location | Tests | Status |
|---|---|---|---|---|
| SCORE-001 | Deterministic, per-component breakdown that sums to the score | `flow-engine/score.ts` | `engine.test.ts` | VERIFIED |
| SCORE-002 | Named a heuristic attention score, never confidence/probability | field is `heat_score` | `wireContract.test.ts` (no ML confidence) | PARTIAL (§30 naming) |
| SCORE-003 | Volume/OI never implies opening interest | `score.ts` uses OI as a ratio input | — | UNASSESSED (§31) |
| SCORE-004 | Scoring formula is versioned | — | — | UNASSESSED (§36) |

## OUTCOME

| ID | Requirement | Location | Tests | Status |
|---|---|---|---|---|
| OUTCOME-001 | Grading survives a process restart | `SignalGrader.recover()` | `graderRecovery.test.ts` | VERIFIED *(this session)* |
| OUTCOME-002 | Grading is durable-worker shaped, not timer-shaped | in-process 60s tick + startup recovery | `graderRecovery.test.ts` | PARTIAL (§38 — recovery exists; an always-on worker does not) |
| OUTCOME-003 | Each mark records source, rights class and as-of | `Mark` | `markSources.test.ts`, `grader.test.ts` | VERIFIED |
| OUTCOME-004 | Nominal horizon and actual measured interval are both stored | `entry_mark_at` / `exit_mark_at` + `MeasuredInterval` | `trackRecordRows.test.ts` | VERIFIED |
| OUTCOME-005 | Non-directional structures excluded from directional metrics | `undirectedStructure()` | `graderDirection.test.ts` | VERIFIED *(this session)* |
| OUTCOME-006 | Endpoint return is not called an excursion | `OutcomeRecord.directionalReturnAtHorizon`, column `directional_return_at_horizon` | `outcomeTriggerColumns.test.ts` | **MET** (F-9 closed 2026-09-23) |
| OUTCOME-007 | An UNGRADED outcome always states a reason | store CHECK + throw | `signalStore.test.ts` | VERIFIED |

## RESEARCH

| ID | Requirement | Location | Tests | Status |
|---|---|---|---|---|
| RESEARCH-001 | No rate published below n=30 real graded outcomes | `MIN_PUBLISHABLE_SAMPLE` | `trackRecordRows.test.ts` | VERIFIED |
| RESEARCH-002 | `/api/backtest` is an outcome scanner and says so | `persistence/backtest.ts` | `backtest.test.ts` | VERIFIED (§50) |
| RESEARCH-003 | Experiment registry with frozen splits | — | — | UNASSESSED (§52, F-6) |
| RESEARCH-004 | Search ledger of every configuration tried | — | — | UNASSESSED (§53) |
| RESEARCH-005 | Coverage manifests sufficient to establish denominators | `collection_gaps` only | `coverage.test.ts` | PARTIAL (§45) |
| RESEARCH-006 | Repeated-measure and clustering treated as dependent | note published; no cluster IDs | `trackRecordRows.test.ts` | PARTIAL (§56, §57) |

## SEC / OPS

| ID | Requirement | Location | Tests | Status |
|---|---|---|---|---|
| SEC-001 | No credential is committed | `.gitignore`, no archive exceptions | `committedSecrets.test.ts` | VERIFIED |
| SEC-002 | Disclosed credentials rotated at the vendor | — | — | **BLOCKED_EXTERNAL** (F-11, §83) |
| SEC-003 | `api_keys.key_value` is not plaintext | plaintext, unused | — | **DEFECT** (F-11, §81) |
| SEC-004 | Socket feed gated on the same terms as REST | `authenticateSocket()` | `socketAuth.test.ts`, `socketHandlers.test.ts` | VERIFIED |
| SEC-005 | Public health payload leaks no credential | `httpError.ts` scrubbing | `healthLeak.test.ts` | VERIFIED |
| OPS-001 | Collection state is visible, not assumed | `/api/health` history + coverage + recovery | `coverage.test.ts` | VERIFIED |
| OPS-002 | Grader health dashboard (pending/overdue/late per horizon) | `GraderStats` + `recovery` | — | PARTIAL (§86) |
| OPS-003 | Backups: RPO/RTO defined and a restore tested | — | — | UNASSESSED (§89) |
| OPS-004 | Timers release the event loop | `.unref()` across `src/` | `dailyBudgetResets.test.ts` | VERIFIED |
