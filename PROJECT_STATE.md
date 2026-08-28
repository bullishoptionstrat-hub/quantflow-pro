# PROJECT_STATE.md

Read this first on any new/compacted session, then `NEXT_ACTIONS.md`.

- **Current wave:** 0 (Repository Truth) — COMPLETE
- **Base commit:** `1c4e2fc` · **Branch:** `claude/quantflow-forensic-audit-64z608`
- **Regression gate:** `npm run verify` — green (exit 0)

## Done

| Wave | Status | Evidence |
|---|---|---|
| Session 1 (pre-wave audit + 3 safe fixes) | COMPLETE | `docs/FORENSIC_AUDIT.md`, 31 backend tests |
| W0 Repository Truth | COMPLETE | `REPO_AUDIT.md`, this file, `IMPLEMENTATION_LEDGER.md` |

## Next

W1 Data Truth Firewall → W2 Provider Foundation → W3 Storage → W4 Flow Engine →
W5 GEX → W6 Market Structure → W7 Outcome Lab → W8 ML Shadow → W9 Security → W10 Adversarial.

## Blocking issues (environmental — not code defects)

1. **Cannot push.** Read-only GitHub App install; 403 on both git and MCP. Work is delivered
   as git bundles. Fix: grant write at https://github.com/apps/claude/installations/select_target
2. **No market-data access.** Egress proxy 403s every provider; no API keys. Waves 4-7 are
   buildable and fixture-testable but **cannot be validated against live data here**.
3. **Credentials leaked in committed zips** (`docs/FORENSIC_AUDIT.md` #7). Rotation is a
   human action; it is not resolved by any code change in these waves.

## Standing decisions

- Provenance field naming follows the master prompt (`is_synthetic`, `is_demo`, …).
  `synthetic` is kept as a deprecated alias for one wave. `docs/EVENT_MODEL_V2.md` reconciled.
- `quantflow-modules/flow-engine` is REUSED for Waves 4/7, not rebuilt — it already satisfies
  the aggressor-inference and outcome-grading honesty contracts.
- Any feature needing paid data is marked BLOCKED, never approximated.
