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

---

## WAVE 1 — DATA TRUTH FIREWALL

**Objective:** make it structurally impossible for synthetic data to reach production silently.

**Files changed:**
- NEW `backend/src/config/provenance.ts` — the Truth Firewall envelope (prompt field names verbatim)
- NEW `backend/src/ingestion/sourceHealth.ts` — measured per-source staleness
- NEW `frontend/lib/provenance.ts`, `frontend/components/ui/ProvenanceBadge.tsx`, `frontend/hooks/useDataMode.ts`
- NEW tests: `backend/test/{provenance,sourceHealth,wave1ExitCriteria,adversarialProvenance}.test.ts`,
  `frontend/lib/provenance.test.ts`, `frontend/components/ui/ProvenanceBadge.test.tsx`
- MOD `backend/src/config/dataMode.ts` (provenance-aware emit guard), `backend/src/ingestion/index.ts`
  (provenance on real connectors, health recording), `backend/src/routes/health.ts` (staleness)
- MOD `frontend/lib/utils.ts` (`syntheticAllowed()`, provenance-stamped generator),
  `frontend/hooks/useFlowFeed.ts` (generators gated), `frontend/components/flow/FlowFeed.tsx` (badge per row),
  `frontend/app/flow/page.tsx` + `app/dark-pool/page.tsx` (banners + honest copy)
- NEW frontend test infra: vitest + jsdom + Testing Library; `verify:frontend:test` added to the gate

**Tests run — actual output:**

```
$ npm run verify
# tests 83 / # pass 83 / # fail 0     (backend, was 31)
# tests 14 / # pass 14 / # fail 0     (flow-engine)
 Test Files  2 passed (2)
      Tests  20 passed (20)            (frontend, new)
 ✓ Compiled successfully               (frontend production build)
VERIFY_EXIT=0
```

**ADVERSARIAL PASS — found a real leak, then closed it.**

First run of a 9-attack probe against the live-mode firewall:

```
held ✅  source spoofing: synthetic payload, real source name    rejection=synthetic_in_live_mode
held ✅  flag stripping: is_synthetic deleted                    rejection=untagged_synthetic_source
held ✅  both flags stripped, synthetic source                   rejection=untagged_synthetic_source
held ✅  casing evasion on source                                rejection=synthetic_in_live_mode
LEAK ❌  unknown generator name, no tags                         rejection=ADMITTED
held ✅  is_demo only (half-tagged)                              rejection=invalid_provenance
held ✅  delayed with no estimate                                rejection=invalid_provenance
held ✅  inferred with no method/confidence                      rejection=invalid_provenance
held ✅  confidence out of range                                 rejection=invalid_provenance
LEAKS: 1
```

**Root cause:** `SYNTHETIC_SOURCES` is a name allowlist, so it fails **open** for every generator
name not yet on it. A generator added later would publish into a live feed untagged.

**Fix:** provenance is now MANDATORY in live mode (`missing_provenance_in_live_mode`). A record
that cannot state where it came from is not publishable as real market data. Added defense in
depth: `source_type: 'generator'` alone forces the DEMO badge even if both booleans are stripped.
Real connectors (tradier, polygon, marketdata, schwab, tastytrade, yahoo) now declare provenance
at their wiring points, so the stricter rule does not silently disable them.

**Re-run after fix: `LEAKS: 0`.** Preserved permanently as `test/adversarialProvenance.test.ts`.

**Two Session-1 tests were updated**, not silenced: they asserted the old fail-open contract
("accepts untagged payloads from real upstream sources in both modes"). The adversarial pass
disproved that contract; the tests now assert the stricter rule explicitly.

**Exit criteria:**

| Criterion | Status |
|---|---|
| A test proves no synthetic event can appear without its flags set | ✅ MET — `wave1ExitCriteria.test.ts` EXIT 1 (5 cases, incl. half-tagged + source-spoofed) |
| A test proves live mode never emits simulation events | ✅ MET — EXIT 2, sweeps 4 sources × 4 tag variants = 16 combinations, all rejected |
| Health endpoint returns real per-source staleness | ✅ MET — EXIT 3 asserts measured staleness, `never_reported` visibility, and self-degradation to `stale` |

**WAVE 1: PASS.**

**Known limitations:**
- Polygon is marked `is_delayed` with a 900 s estimate from its verified free-tier terms; the
  true lag is not measured because no live connection is possible here.
- The badge is wired into `FlowFeed` rows plus the flow and dark-pool pages. Remaining surfaces
  (GEX, heat-map, macro, news, watchlist, power-alerts) still need badges — Wave 5/9.
- `is_delayed` is not yet set by cboe/stooq/fred, which are all delayed sources. Wave 2 assigns
  each provider its real delay characteristics via the `MarketDataProvider` interface.
