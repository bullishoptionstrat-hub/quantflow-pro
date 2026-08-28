# IMPLEMENTATION_LEDGER.md

Append-only. Every material change with **actual command output** as proof.
A wave with an unmet exit criterion is recorded BLOCKED — never as a pass.

---

## Session 1 (pre-wave) — Forensic audit + 3 safe fixes

**Commits:** `2274264`, `c1df9be` · **Files:** see `docs/FORENSIC_AUDIT.md` §"Safe fixes"

**Changed:** `backend/src/config/{env,dataMode}.ts` (new), `backend/test/*.test.ts` (new, 3 files),
`backend/tsconfig.{all,test}.json` (new), root `package.json` (new — `npm run verify`),
`backend/src/{server.ts,ingestion/index.ts,routes/chain.ts}` (modified).

**Tests run:** `npm run verify`

```
# tests 31 / # pass 31 / # fail 0        (backend: env 13, dataMode 13, provenance 5)
# tests 14 / # pass 14 / # fail 0        (flow-engine, pre-existing)
✓ Compiled successfully                  (frontend prod build, 15 routes)
VERIFY_EXIT=0
```

**Result:** PASS. **Limitations:** provenance tagging is backend-only (no UI/API propagation, no
`is_demo`) — closed in W1. **Remaining:** credential rotation (#7) is a human action.

---

## WAVE 0 — REPOSITORY TRUTH

**Objective:** know what actually exists before changing anything.

**Files created:** `REPO_AUDIT.md`, `PROJECT_STATE.md`, `KNOWN_LIMITATIONS.md`,
`DATA_SOURCE_REGISTRY.md`, `NEXT_ACTIONS.md`, `IMPLEMENTATION_LEDGER.md` (this file).
**No source code changed in this wave** — Wave 0 is inspection only.

**Inspected:** all `package.json` × 5, `requirements.txt`, all 4 `tsconfig.json`, both
`render.yaml`, `vercel.json`, `.env.example`, all 3 SQL schema copies + migration, all 7 backend
routes, all 13 connectors + `ingestion/index.ts`, both middleware, WebSocket handlers
(`server.ts:51-76`, `lib/socket.ts`, `hooks/useFlowFeed.ts`), ml-service `main.py` + `train.py`,
`quantflow-modules/{flow-engine,firecrawl}`, 15 frontend routes, all 5 committed zips, git
history across all branches.

**Build/test status — actual output:**

```
$ npm run verify
> quantflow-pro-backend@1.0.0 typecheck  → tsc -p tsconfig.all.json    (clean, exit 0)
> quantflow-pro-backend@1.0.0 test       → # tests 31 / # pass 31 / # fail 0
> quantflow-pro-backend@1.0.0 build      → tsc                          (clean, exit 0)
> flow-engine@1.0.0 typecheck + test     → # tests 14 / # pass 14 / # fail 0
> qf-firecrawl@1.0.0 typecheck           → tsc --noEmit                 (clean, exit 0)
> frontend typecheck + build             → ✓ Compiled successfully (15 routes)
VERIFY_EXIT=0
```

**ML trainer, actual output (reproducing finding #4):**

```
$ python train.py
INFO Generating 10000 synthetic training samples…
INFO Training GradientBoostingClassifier…
              precision    recall  f1-score   support
      normal       1.00      1.00      1.00      1498
     unusual       1.00      1.00      1.00       502
    accuracy                           1.00      2000
INFO ROC-AUC: 1.0000
```

**Proof the AUC is structural, not learned:**

```
size_vol_ratio unique values in TRAINING: [0.2]  | nunique = 1     ← constant feature
fill_ratio corr with label: -0.0157                                ← pure noise
size_norm range | unusual: (5.412, 8.517)
size_norm range | normal : (0.693, 4.605)
=> classes are non-overlapping on size alone: True                 ← one threshold separates
```

**New findings this wave (beyond Session 1's 22):**

- **W0-A · `connectors/yahoo.ts` is very likely BROKEN in production.** Yahoo has required
  crumb + cookie on `query1/v7/*` since 2023 (VERIFIED-SEARCH-2026-08); the connector sends only
  a `User-Agent`. Compounding: it re-emits *daily cumulative* `opt.volume` as a new trade every
  3 minutes (inflating premium totals), stamps `timestamp: now`, and infers C/P via
  `contractSymbol.includes('C')` — latently wrong for any ticker containing "C".
- **W0-B · Polygon poll rate exceeds its own free tier.** `ingestion/index.ts:426` polls every
  10 s = **6 req/min against a 5 req/min free limit**, on an endpoint whose free tier serves
  end-of-day/15-min-delayed data rather than realtime option trades (VERIFIED-SEARCH-2026-08).
- **W0-C · Repo now carries five zip archives, not three.** `Archive.zip` and
  `quantflow-pro-main.zip` arrived in `1c4e2fc`; both rescanned — **no real credentials**
  (`quantflow-pro-main.zip` holds only a placeholder `.env.example`). Finding #7's rotation list
  is unchanged.

**Subsystem classifications:** 50+ recorded in `REPO_AUDIT.md` with file:line evidence.

**Exit criteria:**

| Criterion | Status |
|---|---|
| Every major subsystem classified with evidence, not guesses | ✅ MET — `REPO_AUDIT.md` |
| Current build/test status documented with real output | ✅ MET — above, exit 0 |

**WAVE 0: PASS.**

**Known limitations of this wave:** 9 connectors are classed UNVERIFIED because no key exists and
the egress proxy 403s every provider — their classification is *code-read only*, and Wave 2 must
re-verify each against its official docs before quota logic depends on it.
