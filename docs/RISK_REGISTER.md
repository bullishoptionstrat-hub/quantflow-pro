# RISK REGISTER

§164. Categories, not invented numerical scores — a 1-to-10 on "rights
uncertainty" would be a fabricated reading, which is the defect this whole
repository is organised against.

**Severity** is what happens if the risk is realised and nobody notices:
`SILENT` (wrong output that looks right) outranks `LOUD` (something breaks
visibly), because this repo's entire finding history is that silent failures
survive audits and loud ones do not.

| # | Risk | Severity | Detection today | Mitigation | Test | Status |
|---|---|---|---|---|---|---|
| R-1 | **No entitled real options source.** Every claim about markets is unsupported. | `LOUD` — the doctor says so in five lines | `collection:doctor`, `/api/health` coverage, `entitlement` map | none available in code | `collectionDoctor.test.ts`, `entitlement.test.ts` | **OPEN — external.** See `PROVIDER_DECISION_RECORD.md` |
| R-2 | **Credentials disclosed in git history.** Archives were tracked in a public repo. | `SILENT` | none — removing a file from the tip does not remove it from history | rotate at each vendor | `committedSecrets.test.ts` stops the *next* one | **OPEN — external.** No test here can verify rotation |
| R-3 | **Rights taint does not propagate to derived objects** (§22). `SignalRecord` carries `rightsClass`, but a CSV export or a model trained on it does not re-check. | `SILENT` | none | egress gates at export/train/backtest (§23) | absent | **OPEN** |
| R-4 | **Corrections and cancels are not modelled** (F-8). Every print is permanent; a cancelled trade stays in the record. | `SILENT` | none — no feed here delivers them | bitemporal `RawMarketEvent` (§33) | absent | **OPEN — not reachable until R-1** |
| R-5 | **Out-of-order events.** The engine assumes roughly-ascending arrival; `RawPrint` states it as a requirement rather than enforcing it. | `SILENT` | none | watermark + bounded reorder (§42) | absent | **OPEN** |
| R-6 | **Aggressor misclassification is unquantified.** `inferSide` abstains honestly but has never been measured against truth. | `SILENT` — a wrong side propagates into every rate | `AMBIGUOUS` rate is visible | truth-set calibration (§52) | `nbbo` tests cover the *rule*, not its accuracy | **OPEN — needs R-1 and a licensed truth set** |
| R-7 | **Complex-order contamination.** `guessSpread` links on contract geometry and side; temporal proximity is not proof (§59). | `SILENT` | `spreadGuess: UNKNOWN` is published | execution/package IDs | `spreadGuess` tests cover the classifier, not its precision | **OPEN** |
| R-8 | **Coverage denominator bias.** Outages cluster in volatile sessions, so deletion is not random (§83). | `SILENT` — flatters any rate | `collection_gaps` now has a writer | missingness study | `coverage` tests | **PARTLY MITIGATED** |
| R-9 | **Dynamic-universe selection bias** (§82). Adaptive subscription makes unconditional frequencies unrecoverable. | `SILENT` | none | split fixed vs adaptive universe | absent | **OPEN** |
| R-10 | **Restart loses grading.** | `SILENT` | grader stats | `recover()`, persisted jobs | `graderRecovery.test.ts` | **CLOSED** (F-1, F-12) |
| R-11 | **Schema drift between disk and deployment.** A correct migration never applied. | `SILENT` until the first write | none — every guard reads source | apply and probe each migration against the live project | none possible | **OPEN by construction** (F-14) |
| R-12 | **Documentation drift.** Claims the code no longer supports. | `SILENT` | `readmeClaims.test.ts` | — | that test; the F-5 status row and the test counts were both caught this way | **PARTLY MITIGATED** |
| R-13 | **Wire drift between backend and browser.** A page reading a field the API does not send. | `SILENT` — renders `—` forever | `wireContract.test.ts`, `trackRecordWire.test.ts` | hold both sides to the **publisher**, never to each other | those two | **PARTLY MITIGATED** — found live on 2026-09-23 |
| R-14 | **Synthetic leaking into a real rate.** | `SILENT` | `excluded.synthetic` on every payload | `synthetic` flag, type-level quarantine (§75) not yet built | track-record tests | **MITIGATED, not type-enforced** |
| R-15 | **Research overfitting.** No search ledger, no pre-registration, no holdout. | `SILENT` | none | §95–§105 | absent | **OPEN — nothing to overfit yet** |
| R-16 | **Service-role key exposure.** | `LOUD` if caught, `SILENT` if not | `serviceKey.ts` classifies offline | server-only, never in a prompt | `serviceKey` tests | **MITIGATED** |
| R-17 | **Prompt injection via news/scraped text** (§139). | `SILENT` | none | treat external text as data | absent | **OPEN — no LLM consumes it today** |

## The pattern worth naming

Fourteen of seventeen are `SILENT`. That is not an accident of how the table
was written — it is the selection effect this repository keeps rediscovering:
loud failures get fixed by whoever hits them, so the ones that survive to be
written down are the ones that look like working software.
