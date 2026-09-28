# BASELINE PROOF PACK — Phase −1

**Purpose.** Freeze what is true about this repository *before* the evidence-governed
mandate changes anything, so that later claims can be checked against a recorded
baseline rather than against memory. Nothing here is a plan; everything here is a
measurement taken on the date below.

| | |
|---|---|
| phase | `-1` — freeze current truth |
| git commit | `d2fe2fe57955808ffb26957e7b53b5f01258b06e` |
| branch | `main` (clean working tree, 0 modified files) |
| captured | 2026-09-23 |
| environment | claude.ai cloud container, keyless (`backend/.env` absent), egress-filtered |

---

## 1. Test status — §8 taxonomy, applied strictly

Executed in this container, on this commit, with a clean working tree.

| Suite | Command | Status | Result |
|---|---|---|---|
| backend | `cd backend && npm run verify` | `INDEPENDENTLY_EXECUTED_PASS` | **654 pass / 0 fail**, `tsc --noEmit` clean over `src` + `test` + `tools` |
| frontend | `cd frontend && npm run verify` | `INDEPENDENTLY_EXECUTED_PASS` | **152 pass / 0 fail**, `tsc --noEmit` clean |
| flow-engine module | `cd quantflow-modules/flow-engine && npm test` | `INDEPENDENTLY_EXECUTED_PASS` | **30 pass / 0 fail** |
| frontend production build | `cd frontend && npm run build` | `INDEPENDENTLY_EXECUTED_PASS` | 14 routes emitted, 87.4 kB shared JS, middleware 80.2 kB |
| backend production build | `cd backend && npm run build` | `INDEPENDENTLY_EXECUTED_PASS` | `tsc` → `dist/`, no diagnostics |

**A correction this pack exists to make.** `CLAUDE.md` states the module suite is
24 tests and the backend suite is 430. Both are stale: the measured values are 30
and 654. A repo-reported count is `REPO_REPORTED_PASS` and is not evidence about
the current tree — §2 Level 7 versus Level 3.

Nothing was `BLOCKED_ENVIRONMENT`. Nothing was `NOT_RUN`.

---

## 2. Runtime probe — the process, not the source

`node dist/server.js` on port 3199, read through `/api/health`. §145: only the
process measures a connector.

```
status      : ok
history     : store=memory  durable=false  serviceKey=null  mode=PRIVATE_RESEARCH
sources     : connected 2 | error 4 | disabled 13 | refused 1   (20 total)
sourceNotes : (none)
entitlement : {}            — nothing credentialed, so nothing was asked
markSources : null
recorder    : seen 83, recorded 83, synthetic 83, real 0
grader      : tracked 0, graded 0, ungraded 0, writeFailures 0, writeRetrying 0
recovery    : examined 0, resumed 0, failed 0
coverage    : collecting=false — "no recordable source connected
              (tradier, polygon, marketdata, schwab, tastytrade all disabled)"
```

`/api/track-record` and `/api/backtest` both answer `rows: []` with
`excluded.synthetic = 66` and the note *"No real, permitted, forward-observed
signal has completed a checkpoint yet… it is not an error."*

`collection:doctor --url` verdict: **no — 5 of 8 conditions block collection**
(a source permitted to persist; durable storage; underlying marks; a source
actually delivering; something real in the record).

**Two container facts, recorded so they are not mistaken for code defects.**
`api.coingecko.com` and `cdn.cboe.com` return **HTTP 403 from the agent proxy**
("no rule or allowlist entry allows host"). The connectors reported this
correctly through `describeHttpError` with the blocker's own words — which is
the health channel working, not failing. On an unfiltered host those two would
read differently.

---

## 3. Data maturity — §130, measured

| | |
|---|---|
| real raw option events | **0** |
| synthetic events | 83 recorded this boot; 4,559 rows in the live `signal_history` |
| eligible coverage hours | **0** — `collecting=false` for the whole boot |
| real signals | **0** |
| real graded outcomes | **0** (`signal_outcomes` holds 0 rows in the live database) |
| independent event clusters | **0** |

**Maturity level: M0/M1.** Synthetic only, with real *infrastructure* around it.
Every research phase of the mandate (§169 onward) is gated behind this number
changing, and it cannot change from inside this repository.

---

## 4. Capability maturity — §11, five axes, no single score

| Capability | E | D | R | Q | O | Note |
|---|---|---|---|---|---|---|
| Options flow ingestion | E3 | **D1** | R2 | **Q0** | O2 | engine tested + runtime verified; input is simulated |
| Rights registry | E3 | D3 | **R3** | Q1 | O2 | 13 datasets, verbatim quotes, read-dates, fails closed |
| Entitlement probing | E3 | D2 | R3 | Q1 | O2 | 3 vendors probed; 3 recordable sources `unprobed` with written reasons |
| Signal persistence | E3 | **D1** | R3 | Q0 | O3 | restart recovery tested; nothing real has ever been stored |
| Outcome grading | E3 | **D0** | R3 | Q0 | O3 | mark provenance + as-of enforced; 0 real grades ever produced |
| Coverage manifests | E2 | D1 | R3 | Q0 | O2 | `collection_gaps` has 16 rows, all from synthetic-era windows |
| GEX / positioning | E2 | D2 | R1 | Q0 | O1 | Cboe chain is real but `UNVERIFIED` for display and egress-blocked here |
| Track record / backtest | E3 | **D0** | R3 | **Q0** | O2 | publishes correctly and has nothing to publish |
| ML | **E0** | D0 | R0 | Q0 | O0 | deliberately absent; `ml-service/` deleted |

No row may be summarised as "production ready". The D and Q columns are the
mandate's subject and they are the two that are empty.

---

## 5. Mandate artifacts — present vs absent

| Artifact | State |
|---|---|
| `docs/FORENSIC_AUDIT.md` | **present** — 15 findings, F-1…F-15 |
| `docs/REQUIREMENTS_MATRIX.md` | **present** |
| `docs/CLAIMS_LEDGER.md` | **present** |
| `docs/SYSTEM_INVARIANTS.md` | **present** |
| `docs/RISK_REGISTER.md` | **absent** (§164) |
| `docs/DATA_RIGHTS_MATRIX.md` | **absent** (§20) — rights live in `provenance/rights.ts` on 2 axes, not the mandate's 15 |
| `docs/PROVIDER_DECISION_RECORD.md` | **absent** (§25) |
| `docs/adr/` | **absent** (§163) |
| `research/hypotheses/` | **absent** (§95) |
| `research/rejected/` | **absent** (§98) |
| `proofs/` | **this file is the first** (§7) |

---

## 6. Open findings carried into this mandate

| ID | Finding | State |
|---|---|---|
| F-6 | Tier-4 controls described for a different tree | OPEN (documented) |
| **F-7** | **No entitled real options-event source** | **OPEN — external blocker** |
| F-8 | Corrections/cancels and event ordering not modelled | OPEN |
| F-10 | AM-settled index expiry; half-days/holidays | PARTLY FIXED |
| F-11 | Plaintext `api_keys.key_value`; disclosed credentials in git history | OPEN — **external**, requires vendor-side rotation |

F-1…F-5, F-9, F-12…F-15 are closed with tests and, where applicable,
live-database verification.

---

## 7. Known limitations of this pack

- It measures **this container**: keyless, egress-filtered, single boot. A
  credentialed host would produce a different source board, and two of the four
  `error` sources are errors *of the container*, not of the code.
- The live Supabase project was read but the store's **read paths have never
  executed against a real Postgres** — the management API issues no
  `service_role` key, and the anon key cannot stand in because all four history
  tables are `force row level security` with zero policies, so a test would read
  zero rows and pass for the wrong reason (ROADMAP 1.1d).
- Test counts are from one run. They are not a claim about flakiness.

## 8. Rollback

Nothing was changed to produce this pack. It is additive documentation on a
branch restarted from `d2fe2fe`.
