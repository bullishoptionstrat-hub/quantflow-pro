# PROJECT_STATE.md

Read this first on any new/compacted session, then `NEXT_ACTIONS.md`.

- **Current wave:** Wave 0 re-run (v2) complete on the post-merge tree. Waves 1-10 were
  executed earlier against the PRE-merge tree; their conclusions still hold except where
  `REPO_AUDIT.md` -> "Corrections to rows above" marks them stale.
- **Head:** `47fa8c0` · **Branch:** `claude/quantflow-forensic-audit-64z608`
- **Merged:** `origin/main` `2d110b8` (PRs #6-#10) is now an ancestor. It brought a competing
  flow-engine integration, keyless CBOE/OCC connectors, route auth and a narrowed CORS
  allowlist. Both sides were kept: main's real-data pipeline AND this branch's Truth Firewall
  (main had dropped the simulation live-mode gate and bypassed the `addFlowEvent` emit guard).
- **Regression gate:** `npm run verify` — green (exit 0). **385 tests, 0 failures**
  (297 backend + 45 domain + 14 flow-engine + 29 frontend).

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

## Wave 0 v2 (post-merge audit, 2026-08-28)

Re-ran Wave 0 because the earlier audit predated the merge. Verified `CLAUDE.md`'s
load-bearing vendoring claim by diff (**true**: only `.js` extension stripping + the
documented `resetDaily()`), so the module's 14 tests remain a valid baseline for what ships.

Three new defects found in the newly-merged code, all recorded in `docs/FORENSIC_AUDIT.md`
and all **open**:

| # | Severity | What |
|---|---|---|
| 26 | MEDIUM | CBOE chain `asOf` falls back to `now()` — stale snapshots read as current |
| 27 | HIGH | `occ.ts` repeats the `\|\| 0` zero-sentinel AND hides a next-business-day delay |
| 28 | MEDIUM | Auth returns 401 for a Supabase outage — indistinguishable from a bad token |
| 29 | **HIGH** | Socket.IO has no auth and `origin:'*'` — it broadcasts the same data the six `requireAuth` routes protect, so route auth is bypassable |

Also corrected a claim I had made earlier in the session — but only **half** of it was stale.
main replaced the HTTP CORS wildcard with an allowlist; the **Socket.IO** config still has
`origin:'*'` + `credentials:true` and no handshake auth. Chasing that half-correction is what
surfaced #29, which is the most serious finding in this pass.

## Verification commands

```
npm run verify              # 267 backend + 45 domain + 14 flow-engine + 29 frontend, prod build
npm run verify:migrations   # apply + idempotency + exact rollback (needs Postgres)
npm run verify:secrets      # credential scan
npm run verify:rls          # 6 RLS checks as real unauthorized requests
PYTHON=<venv>/bin/python npm run verify:ml   # 23 ML gate tests
```

## Blocking issues (environmental, not code defects)

1. ~~**Cannot push.**~~ **RESOLVED** — push access was granted mid-session; the branch is
   pushed and PR #5 is open (draft).
2. **No market-data access.** Egress proxy 403s every provider; no API keys. This is what
   BLOCKS W5's real chains, W7's scheduler and W8's training loop.
3. **Credentials leaked in committed zips** (`docs/FORENSIC_AUDIT.md` #7). Human action; no code
   change resolves it.

## Standing decisions

- Provenance field naming follows the master prompt (`is_synthetic`, `is_demo`, …).
  `synthetic` remains a deprecated alias — **removal is the next scheduled cleanup**.
- `quantflow-modules/flow-engine` is REUSED, not rebuilt.
- Anything needing paid data is marked BLOCKED, never approximated.
