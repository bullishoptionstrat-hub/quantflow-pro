# PROJECT_STATE.md

Read this first on any new/compacted session, then `NEXT_ACTIONS.md`.

- **Current wave:** 10 of 10 — all waves executed
- **Base commit:** `1c4e2fc` · **Branch:** `claude/quantflow-forensic-audit-64z608`
- **Regression gate:** `npm run verify` — green (exit 0)

## Wave status

| Wave | Result | Note |
|---|---|---|
| W0 Repository Truth | ✅ PASS | 50+ subsystems classified with evidence |
| W1 Data Truth Firewall | ✅ PASS | adversarial pass found + closed a real fail-open leak |
| W2 Provider Foundation | ✅ PASS* | *16 of 17 rate limits UNVERIFIED — vendor docs unreachable |
| W3 Storage + Provenance | ✅ PASS | migration + rollback executed on real Postgres |
| W4 Options Flow Engine | ✅ PASS | integrated flow-engine; not wired to live ingest (no per-print data) |
| W5 GEX / Volatility | ⚠️ PARTIAL | math done + ×100 bug fixed; real chain snapshots BLOCKED |
| W6 Market Structure | ✅ PASS | prefix/repaint properties proven to have teeth |
| W7 Outcome Lab | ⚠️ PARTIAL | grading proven end-to-end; scheduler BLOCKED (no price feed) |
| W8 ML Shadow | ✅ PASS | rng model quarantined; trainer refuses at 0/1000 |
| W9 Alerts/Observability/Security | ✅ PASS | 1000→1 dedup, secret scan, 6/6 RLS |
| W10 Adversarial Hardening | ✅ PASS | found + fixed 2 real grader bugs |

## Verification commands

```
npm run verify              # 243 backend + 14 flow-engine + 29 frontend tests, prod build
npm run verify:migrations   # apply + idempotency + exact rollback (needs Postgres)
npm run verify:secrets      # credential scan
npm run verify:rls          # 6 RLS checks as real unauthorized requests
PYTHON=<venv>/bin/python npm run verify:ml   # 23 ML gate tests
```

## Blocking issues (environmental, not code defects)

1. **Cannot push.** Read-only GitHub App install; 403 on both git and MCP. Delivered as bundles.
   Fix: https://github.com/apps/claude/installations/select_target
2. **No market-data access.** Egress proxy 403s every provider; no API keys. This is what
   BLOCKS W5's real chains, W7's scheduler and W8's training loop.
3. **Credentials leaked in committed zips** (`docs/FORENSIC_AUDIT.md` #7). Human action; no code
   change resolves it.

## Standing decisions

- Provenance field naming follows the master prompt (`is_synthetic`, `is_demo`, …).
  `synthetic` remains a deprecated alias — **removal is the next scheduled cleanup**.
- `quantflow-modules/flow-engine` is REUSED, not rebuilt.
- Anything needing paid data is marked BLOCKED, never approximated.
