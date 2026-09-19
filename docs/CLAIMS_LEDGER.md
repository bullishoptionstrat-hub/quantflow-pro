# QuantFlow Pro — Claims Ledger

Every material product claim, the evidence for it in **this** tree, and the
wording the code can actually support.

**Method.** Claims were read out of `README.md` and `TIER4_FINAL_REPORT.md`,
then checked against executable code, a live boot of the backend, and the test
suites. A comment is not evidence. A ✅ in a feature table is not evidence.

**Statuses:** `VERIFIED` · `PARTIALLY_VERIFIED` · `STALE` · `FALSE` ·
`UNVERIFIED` · `REMOVED`

---

## README.md

| # | Claim | Source | Evidence in this tree | Status |
|---|---|---|---|---|
| C-1 | "ML unusual score (GradientBoosting) ✅" | `README.md:139` | No `ml-service/` in tree. No model, no `/score` caller, no `ml_score` field. CLAUDE.md documents the deletion and the reason (`train.py` drew the label before the features, from `np.random` seed 42). | **FALSE** |
| C-2 | "Backend + ML → Render.com" | `README.md:107` | `render.yaml` declares one backend service. No ML slot. | **FALSE** |
| C-3 | "Institutional-grade options flow terminal" | `README.md:3` | Styling and feature count. No entitled options-event source (F-7); no graded real outcome exists. §98 requires measurable criteria for such a label. | **UNVERIFIED** |
| C-4 | "replicating FlowAlgo + InsiderFinance + CheddarFlow + OptionStrat" | `README.md:3` | Those products are built on licensed OPRA event feeds. This deployment has none. | **FALSE** |
| C-5 | "Live options flow feed (Socket.IO) ✅" | `README.md:123` | The socket transport and the gate are real and tested. What flows through it on this deployment is `simulation`. | **PARTIALLY_VERIFIED** |
| C-6 | "Sweep/Block/Split classifier ✅" | `README.md:126` | The classifier runs and is tested. Until F-2 was fixed this session, the SWEEP label on a multi-venue record was manufactured from a decomposition. §24 asks for evidence-bounded naming — "sweep-like cluster" — which remains open. | **PARTIALLY_VERIFIED** |
| C-7 | "Dark pool prints (24hr delay) ✅" | `README.md:129` | `/api/darkpool` serves prints with `source: 'simulation'` absent a vendor feed. The page renders the backend's own notice rather than asserting the delay — that part was fixed earlier. The ✅ still reads as a data capability. | **PARTIALLY_VERIFIED** |
| C-8 | "5 data source connectors ✅" | `README.md:140` | 17 connectors exist; a live keyless boot reports 2 connected, 4 error, 13 disabled, 1 refused. The number is stale in the harmless direction, the *status* is the misleading part. | **STALE** |
| C-9 | "GEX chart (gamma exposure) ✅" | `README.md:128` | Real: reads `/api/gex`, honours `realData`, draws nothing without a chain, carries the provenance badge, and publishes `assumptions.dealerPositioning`. | **VERIFIED** |
| C-10 | "Heat score (InsiderFinance-style) ✅" | `README.md:125` | Deterministic, per-component `score_breakdown` on the wire, clamp is a visible term. It is a heuristic attention score and §30 asks that it be named one. | **VERIFIED (naming open)** |
| C-11 | "Power Alerts (voice + push) ✅" | `README.md:127` | Real, and now marks simulated prints in speech and notification title. | **VERIFIED** |
| C-12 | "Supabase auth (login/register) ✅" | `README.md:138` | Real; middleware gate, socket handshake gate and demo path all tested. | **VERIFIED** |

### Allowed wording

- **C-1/C-2:** remove. There is no model. Any future row must name the
  training data and the validation split (§65).
- **C-3:** replace with the maturity label from §98. On today's evidence this
  deployment is `DATA_COLLECTION`, not `PRODUCTION_DECISION_SUPPORT`.
- **C-5:** "Live flow feed — carries simulated prints unless an entitled
  options-event source is configured."
- **C-7:** "Dark pool panel — renders the vendor's own delay notice; prints are
  simulated absent a licensed feed."

---

## TIER4_FINAL_REPORT.md

This report is dated **2026-08-22** and states its tree as **`/root/arch2`**.
It is evidence about a prior, different tree. Per §6, controls it names that
are absent here are `MISSING_FROM_CURRENT_TREE` — not assumed to live
somewhere else.

| # | Claim | Status in this tree |
|---|---|---|
| C-20 | Experiment registry / preregistration (`research/experiments/`) | **MISSING_FROM_CURRENT_TREE** |
| C-21 | Append-only raw spool (Phase R) | **MISSING_FROM_CURRENT_TREE** |
| C-22 | Market-calendar coverage (Gate 7) | **MISSING_FROM_CURRENT_TREE**. `coverage.ts` deliberately never emits `MARKET_CLOSED` precisely because no calendar exists. |
| C-23 | OSI symbol normalization (Phase F) | **MISSING_FROM_CURRENT_TREE**. Only `occSymbol` *construction* in the adapter. |
| C-24 | Coverage manifests (Phases L/M/N) | **MISSING_FROM_CURRENT_TREE**. `collection_gaps` records outage windows; it does not establish observation denominators (§45, §49). |
| C-25 | "226 executed tests pass" | **STALE**. This tree: 612 backend + 132 frontend. |
| C-26 | Rights findings — Cboe auto-extraction prohibition, four sources whose terms forbid the access method used | **VERIFIED independently.** `provenance/rights.ts` encodes them with quoted restrictions and read dates; the Yahoo connector is refused before `start()` on a live boot. |
| C-27 | "five of eight preregistered hypotheses cannot legally be run" | **UNVERIFIED** — the hypotheses are in the registry that is missing from this tree. |

---

## Claims the code makes about itself, and keeps

These are worth recording as the positive side of the ledger; each is enforced
by a test rather than asserted in prose.

| Claim | Enforced by |
|---|---|
| Synthetic signals never enter the track record | `rights.test.ts`, `trackRecordRows.test.ts` |
| No rate is published below n=30 real graded outcomes | `MIN_PUBLISHABLE_SAMPLE`, `trackRecordRows.test.ts` |
| A connector prohibited for DISPLAY is never started | `connectorGate.test.ts` |
| `/api/health` distinguishes `disabled` / `error` / `refused` | `deadSources.test.ts`, live boot |
| A field a vendor did not send is not zero | `defaultedReadings.test.ts` |
| An M15 row states the interval it was actually measured over | `trackRecordRows.test.ts` |
| A restart does not lose an eligible outcome | `graderRecovery.test.ts` *(added this session)* |
| Aggregate venue metadata creates no fictitious executions | `aggregateNotPrints.test.ts` *(added this session)* |
