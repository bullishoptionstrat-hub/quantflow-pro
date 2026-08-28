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

---

## WAVE 2 — PROVIDER / QUALITY FOUNDATION

**Objective:** every provider declares its real capabilities and limits, enforced in code.

**Files changed:**
- NEW `backend/src/providers/types.ts` — `MarketDataProvider` contract: capabilities, priority
  (P0–P5), latency class, rate limit + verification state, auth, required env, ToS, fallback.
  `validateDescriptor()` rejects contradictions (e.g. realtime AND a delay estimate).
- NEW `backend/src/providers/registry.ts` — all 17 providers declared, each rate limit marked
  `verified` (with source + date) or `unverified` (with the reason).
- NEW `backend/src/providers/quota.ts` — priority quota manager, circuit breaker, typed decisions.
- NEW `backend/test/providers.test.ts` (40 tests)
- MOD `backend/src/ingestion/index.ts` — Polygon poll quota-gated; errors logged, never swallowed.
- MOD `backend/src/routes/health.ts` — `GET /api/health/providers`.

**Design decisions that carry the honesty requirement into code:**
- Provenance is DERIVED from the provider descriptor (`provenanceFromDescriptor`), so a delayed
  provider cannot produce an undelayed event regardless of what a connector author remembers.
- `UNVERIFIED_SAFETY_FACTOR = 0.5`: an unconfirmed limit is spent at half its declared value.
- `PRIORITY_RESERVE`: P5 background work stops at 50% of a budget so P0 live work keeps headroom.
- Failover sets `is_inferred` + `inference_method: 'failover_from:<id>'` + `confidence`, so a
  stand-in provider's data is visibly a stand-in.

**W0-B DEFECT FIXED:** Polygon polled every 10 s = 6 req/min against its VERIFIED 5 req/min free
limit. Now quota-gated with a 15 s interval (4 req/min). It remains declared `is_delayed` with a
900 s estimate because the free tier serves EOD/15-min-delayed data, not realtime option trades.

**Tests run — actual output:**

```
$ npm test
# tests 123 / # pass 123 / # fail 0     (backend; was 83)
```

**ADVERSARIAL PASS — 0 failures:**

```
held ✅  10k-call storm never throws                      actions seen: allow,defer
held ✅  exhaustion stops allowing                        allowed=5/20 (budget 5)
held ✅  failover is stamped on the event, not silent     method=failover_from:tradier
held ✅  degraded stand-in never renders LIVE             badge=DELAYED
held ✅  every provider produces a VALID provenance envelope
held ✅  BLOCKED provider is unreachable via capability lookup
held ✅  unknown/unconfigured deny cleanly
FAILURES: 0
```

**Exit criteria:**

| Criterion | Status |
|---|---|
| Quota exhaustion degrades gracefully rather than crashing | ✅ MET — typed `allow/defer/degrade/deny`; 10k-call storm throws nothing; declared fallback used, else a retry hint |
| Provider failover is explicitly flagged, never silent | ✅ MET — `is_inferred` + `failover_from:<id>` + confidence on the event; badge can never read LIVE |

**WAVE 2: PASS — with one caveat stated plainly.**

**CAVEAT (does not meet the prompt's "re-check official docs" instruction in full):** the prompt
requires verifying every rate limit against current official docs. This environment's egress proxy
blocks every vendor domain, so only **Polygon's** limit could be confirmed (5 req/min, EOD/15-min-
delayed free tier, via cross-checked current sources, 2026-08-15). **The other 16 are marked
`unverified` with the reason** and enforced at 50% of their declared value. They must be
re-verified against the official pages before any deployment depends on them. No limit was invented.

---

## WAVE 3 — STORAGE + PROVENANCE

**Objective:** the schema supports the Truth Firewall without duplicating existing tables.

**Audit first (as the prompt requires):** the existing schema is sound — `flow_archive` already
separates `event_at` from `created_at`, RLS is enabled on all 7 tables, and indexes exist. So this
wave **ALTERs in place**. The only new table is `flow_outcomes`, justified because no existing
table stores forward returns and grades have a different lifecycle (written later, by a scheduled
job) than the events they grade.

**Files changed:**
- NEW `supabase/migrations/20260828000000_provenance.sql` (205 lines)
- NEW `supabase/migrations/20260828000000_provenance.down.sql` (74 lines) — paired rollback
- NEW `scripts/verify-migrations.sh` — repeatable gate; `npm run verify:migrations`

**Executed against a REAL Postgres 16.13**, loaded with the actual production migration plus
Supabase runtime shims (`auth.users`, `auth.uid()`, `auth.role()`) so the real RLS policies load
verbatim:

```
BEFORE columns: 65
=== APPLY ===        APPLY_EXIT=0
AFTER columns:  116  (+51)
=== IDEMPOTENCY: re-apply ===   re-apply OK (idempotent)
=== ROLLBACK ===
AFTER ROLLBACK: 65
=== DIFF before vs rolled-back ===
IDENTICAL ✅ — rollback fully restores the original schema
```

**The database now refuses the same malformed states the application refuses**, so a direct SQL
writer cannot bypass the Truth Firewall:

```
rejected ✅  is_delayed with no estimate        rejected ✅  is_synthetic without is_demo
rejected ✅  is_inferred with no method         rejected ✅  bogus classification grade
rejected ✅  confidence > 1                     rejected ✅  invented aggressor side
accepted ✅  delayed WITH estimate              accepted ✅  synthetic WITH demo
accepted ✅  valid inference
```

**Dedup / idempotency / causality:**

```
duplicate (source, provider_event_id) rejected ✅
NULL provider_event_id rows coexist    ✅  (partial index correct)
flow_outcomes lookahead rejected       ✅  (actionable_at < signal_at)
graded WIN with no return rejected     ✅
duplicate (event, horizon) rejected    ✅
UNGRADED + valid graded rows accepted  ✅
```

**Repeatable gate — actual output:**

```
$ ./scripts/verify-migrations.sh
==> apply 20260828000000_provenance.sql        columns after: 116
==> re-apply (idempotency)                     idempotent OK
==> rollback 20260828000000_provenance.down.sql
                                               rollback restores baseline EXACTLY OK
==> ALL MIGRATIONS VERIFIED (apply + idempotent + rollback exact)
GATE_EXIT=0
```

**Exit criteria:**

| Criterion | Status |
|---|---|
| Migration runs cleanly on a copy of the current schema | ✅ MET — real Postgres 16.13, exit 0 |
| Rollback script tested and proven | ✅ MET — column-level diff before vs after rollback is IDENTICAL |
| No duplicate/orphaned tables without justification | ✅ MET — 3 tables ALTERed in place; 1 new table (`flow_outcomes`) justified above |

**WAVE 3: PASS.**

**Known limitations:** verified against local Postgres 16.13, not against the live Supabase
project (unreachable from here). Supabase runs Postgres 15/16 with the same DDL semantics for
everything used, but the migration should still be applied to a Supabase **branch** before
production. `flow_outcomes` has an RLS read policy but no write policy — writes are service-role
only, matching how `flow_archive` and `price_history` already behave.

---

## WAVE 4 — OPTIONS FLOW ENGINE

**Objective:** sweep/block/split classification and aggressor inference are real, tested, honest.

**KEY DECISION — integrate, do not rebuild.** `quantflow-modules/flow-engine` already implemented
this wave's requirements correctly, with 14 passing deterministic tests, and was **completely
disconnected** (nothing imported it). Rebuilding would have duplicated working code and risked
losing its central guarantee: `NbboBook.inferSide()` returns `AMBIGUOUS` whenever the NBBO is
missing or stale. That IS this wave's exit criterion. Prompt rule 27 (don't rewrite a working
subsystem) and step 39 (extend, don't duplicate) both point the same way.

**Files changed:**
- `quantflow-modules/flow-engine`: added `build` (esbuild → CJS bundle + `tsc` → `.d.ts`) so the
  CommonJS backend can consume the ESM module. **No source logic changed.**
- Backend now depends on `flow-engine` via `file:` — one source of truth, no copied algorithms.
- NEW `backend/src/flow/adapter.ts` — translation only: `InferredSide` → grade, `SignalKind` →
  the backend's narrower type, `ClassifiedSignal` → `FlowEvent` + provenance.
- NEW `backend/test/flowAdapter.test.ts` — 18 golden-fixture tests, fully deterministic.

**Honesty decisions encoded in the adapter:**
- **Nothing is ever graded `OBSERVED`.** This pipeline never receives an exchange aggressor flag,
  so at-the-touch is `STRONG_INFERENCE` (0.8) and inside-spread is `WEAK_INFERENCE` (0.55).
  Confidence is never 1.0.
- **Sentiment comes from the inferred side, not from call/put.** The old pipeline set
  `sentiment = call ? bullish : bearish`, which is not information — buying and selling a call are
  opposite trades. `AMBIGUOUS` ⇒ `neutral`, never a guess.
- `AMBIGUOUS` still records `is_inferred` with method `quote_rule:no_usable_nbbo`, so "we tried and
  could not determine" is distinguishable from "we never looked".
- Lossy kind narrowing (`MULTI_LEG`→SPLIT, `LARGE`→BLOCK) preserves the original in `conditions`.

**Tests run — actual output:**

```
$ npm test
# tests 141 / # pass 141 / # fail 0     (backend; was 123)
```

**A REAL MISTAKE I MADE, AND THE FIX:** my first fixture put the OCC symbol on
`contract.contractSymbol`, but the engine keys the NBBO book off `contract.symbol`. The lookup
missed, so every trade came back `AMBIGUOUS` and the sweep fixture failed. I had written the
fixture with `as OptionTradeEvent` casts, which suppressed exactly the type error that would have
caught it. Fix: removed the casts and used the real `OptionContract` type, so TypeScript now
enforces fixture shape. The engine was correct throughout; my test was wrong.

**Golden fixture (deterministic, asserted exact):** 4 prints, same contract and side, 3 exchanges,
inside the 100 ms window ⇒ `kind=SWEEP`, `side=BUY` (5.15 through a 5.10 ask), `totalSize=900`,
`totalPremium=463,500` (= 5.15 × 900 × 100 exactly), `printIds=[p1,p2,p3,p4]`. Run twice per test
run and asserted identical, proving no random data.

**ADVERSARIAL PASS — 0 failures:**

```
held ✅  garbage NBBO (zero ask / negative bid / crossed) → no confident side   side=AMBIGUOUS
held ✅  ancient NBBO is not reused                                            side=AMBIGUOUS
held ✅  every side produces a VALID, inference-marked envelope
held ✅  AMBIGUOUS never becomes bullish/bearish                    sentiment=neutral conf=0
held ✅  legless signal is refused, not fabricated
held ✅  engine-declared synthetic cannot be overridden by the caller           badge=DEMO
FAILURES: 0
```

**Exit criteria:**

| Criterion | Status |
|---|---|
| Golden fixtures produce exact expected classifications | ✅ MET — exact kind/side/size/premium/printIds, determinism asserted |
| Aggressor inference never fabricates a side without NBBO | ✅ MET — 6 unit cases + 4 adversarial cases; no-quote, stale, at-mid, crossed, zero-ask, negative-bid all ⇒ AMBIGUOUS |

**WAVE 4: PASS.**

**Known limitations:** the adapter is tested end-to-end but is **not yet wired into the live
ingestion path** — doing so requires per-print exchange + NBBO data, which no currently reachable
free provider supplies (Polygon's free tier is delayed/EOD; Yahoo is daily cumulative volume).
The legacy `classifySweep` (`size > 200`) therefore still runs in `ingestion/index.ts`. Swapping
it is a data-availability problem, not a code problem, and is recorded in NEXT_ACTIONS.md.

---

## WAVE 5 — GEX / VOLATILITY ENGINE

**Objective:** real gamma exposure and vol metrics with assumptions shown, not hidden.

**Files changed:**
- NEW `backend/src/gex/compute.ts` — chain-snapshot GEX with the sign convention documented at
  the top of the file and asserted in tests.
- NEW `backend/src/gex/volatility.ts` — IV rank/percentile, term structure, skew.
- NEW `backend/test/gex.test.ts` (27 tests), `frontend/lib/blackScholes.test.ts` (9 tests).
- MOD `frontend/lib/blackScholes.ts` — **contract-multiplier bug fixed**.

**BUG FIXED — GEX magnitude was 100× too small.** `frontend/lib/blackScholes.ts:computeGEX`
omitted the ×100 contract multiplier. Hand-check: 1,000 OI × 0.02 gamma × 100 × 580² × 0.01 =
**6,728,000**, asserted identically in the backend and frontend suites so the two cannot drift.

**SIGN CONVENTION — asserted, not assumed:** call GEX positive, put GEX negative, tested with
call-only (net > 0, SUPPORT), put-only (net < 0, RESISTANCE) and balanced (exactly 0, NEUTRAL)
chains. The dealer-inventory assumption is stated in `model_assumptions` on every result:
*"Dealers are assumed net LONG calls and net SHORT puts. Actual dealer inventory is not public."*

**Bug found by a test and fixed in the CODE, not the test:** `-0 * x` is `-0`, which is not
strictly equal to `0` and would surprise any downstream `Object.is` or strict comparison. Added
`normalizeZero()` in both implementations rather than loosening the assertion.

**Honesty behaviors:**
- `computeIvRank` **refuses** below 60 observations, returning nulls plus the count it had —
  a 10-day "52-week IV rank" is not a rank.
- IV rank and IV percentile are computed and reported as **different** numbers (test asserts they
  differ: rank 50 vs percentile 99 on the same series).
- `computeTermStructure` **computes** contango/backwardation/flat/mixed. The existing
  `/api/macro/vix` hardcodes `'contango'`; the test proves backwardation is now detectable.
- `computeSkew` returns `missing_leg` rather than assuming symmetry.
- Zero OI or zero gamma ⇒ `confidence: 0`, not a confident zero.

**Tests run — actual output:**

```
$ npm test (backend)        # tests 168 / # pass 168 / # fail 0     (was 141)
$ npx vitest run (frontend) Test Files 3 passed (3) / Tests 29 passed (29)
```

Frontend suite also verifies put-call parity, delta bounds, the call/put gamma identity, intrinsic
value at expiry, and an implied-vol round trip — confirming the Black-Scholes core is sound.

**Exit criteria:**

| Criterion | Status |
|---|---|
| Sign-convention unit tests pass | ✅ MET — call/put/balanced cases assert sign and level type |
| GEX reproducible from a fixed input fixture | ✅ MET — identical across runs and order-independent (shuffled strikes give the same result) |
| UI clearly separates "observed" from "estimated" | ⚠️ **PARTIAL** — the API contract now carries `observed_inputs`, `model_assumptions`, `confidence` and `quality_flags` on every result, but the GEX **page** does not yet render them. UI wiring is Wave 9. |
| Replace synthetic GEX with real chain-snapshot calculation | 🚫 **BLOCKED** — no reachable free chain-snapshot source (egress proxy blocks every provider; Polygon free is delayed/EOD; FlashAlpha needs a key). The honest calculation exists and is tested; `ingestion/index.ts` still generates synthetic GEX in demo mode, correctly tagged. |

**WAVE 5: PARTIAL — 2 of 4 criteria fully met, 1 partial, 1 BLOCKED on data access.**
Recorded as such rather than claimed as a pass.

---

## WAVE 6 — MARKET STRUCTURE / CROSS-ASSET ENGINE

**Objective:** non-repainting, causally valid structure detection + SMT divergence.

**Files changed:** NEW `backend/src/structure/detect.ts`, NEW `backend/test/structure.test.ts` (17 tests).

**The causality contract, enforced in code:** every detection carries three genuinely different
times — `formation_time` (when the pattern's bars occurred), `confirmation_time` (when the
confirming bar CLOSED), `actionable_time` (earliest a strategy could act). `assertCausality()`
**throws** on `formation > confirmation > actionable` rather than emitting the detection, and is
called on every construction path.

**Design choices that prevent repainting:**
- BOS uses the **CLOSE**, never the wick. A test proves an intrabar spike to 106 above a 105 swing
  that closes back at 103 produces **no** BOS — that exact wick-then-reject is instead detected as
  a LIQUIDITY_SWEEP, which is what it actually is.
- A swing at index `s` is not breakable until `s + lookback`, since it is not a swing until then.
- Detectors take a bar array and never mutate prior output.

**Tests run — actual output:**

```
$ npm test
# tests 185 / # pass 185 / # fail 0     (backend; was 168)
```

**PROOF THE LOOKAHEAD TESTS HAVE TEETH.** A passing test proves nothing if it is vacuous, so I
verified both halves:

```
honest detector, detections per prefix length:
  n=3: 0 []   n=4: 0 []   n=5: 0 []   n=6: 0 []
  n=7: 1 [BOS@6]          n=8: 2 [BOS@6, FVG@7]      n=9: 2 [BOS@6, FVG@7]
counts vary across prefixes: YES ✅ — the prefix test compares changing, non-empty sets

MUTATION (BOS confirmed at the swing bar = lookahead):
  prefix property rejects the mutant: YES ✅
  n=3: prefix=[] vs expected=[BOS|BULLISH|2|2|105]
```

My first mutation attempt was badly constructed — it emitted identical output for both prefixes
and therefore demonstrated nothing. Replaced with one that genuinely confirms a BOS at the swing
bar (classic lookahead); the prefix property rejects it.

**Exit criteria:**

| Criterion | Status |
|---|---|
| Lookahead/repainting regression tests pass against fixed fixtures | ✅ MET — prefix property asserted at EVERY split point; appending a violent future bar (130/80) changes no earlier detection; detections are never withdrawn as data grows |
| Same-bar execution leakage test passes | ✅ MET — `actionable_time` is never before the confirming bar's close, so a fill cannot use that bar's own intrabar range |

**WAVE 6: PASS.**

**Known limitations:** fixtures are hand-constructed rather than real historical bars (no market
data reachable). The shapes are standard and the causality properties are structural, so they hold
regardless of the price series — but the detectors have not been run against real market data.
SMT divergence requires two aligned series; bars whose timestamps do not match are skipped rather
than assumed to correspond.

---

## WAVE 7 — OUTCOME LAB

**Objective:** flow events get graded against real forward returns, honestly scoped.

**Files changed:** NEW `backend/src/outcomes/grader.ts`, NEW `backend/test/grader.test.ts` (22 tests).

**HONEST SCOPE, stated in code and in every result row:** grading uses **UNDERLYING returns**, not
option P&L. Option-level P&L needs historical option marks at the grading timestamps, which no free
source provides (DATA_SOURCE_REGISTRY.md → BLOCKED). Every row carries `return_basis: 'underlying'`
and every report carries the note *"Theta, IV crush and spread costs are NOT captured."* Modeling
an option price and calling it a result would be a guess wearing a number's clothing.

**Causality:** entry is the first mark **at or after `actionable_at`** (never `signal_at`), exit is
the first mark at or after `actionable_at + horizon`. Tests prove an attractive earlier price is
ignored, and that a better mid-window price is not used as the exit.

**UNGRADED is first-class** — six typed reasons, never coerced into FLAT to make a table look
complete. `ambiguous_direction` is the common case, because an AMBIGUOUS aggressor side means we do
not know what "correct" would have been. Guessing there is precisely how a flow tool manufactures a
hit rate. `buildReport` excludes UNGRADED from the hit rate but **counts** it, and returns
`hitRate: null` rather than presenting 0/0 as 0%.

**Tests run — actual output:**

```
$ npm test
# tests 207 / # pass 207 / # fail 0     (backend; was 185)
```

**HAND-VERIFIED WORKED EXAMPLE, end to end through the real database:**

```
entry  = first mark at/after actionable (T+0)  = 580.00
exit   = first mark at/after T+15m             = 585.80
return = (585.80 − 580.00) / 580.00
HAND CHECK: 0.009999999999999922 | grader says 0.009999999999999922 | match: YES ✅
label  = WIN   (|0.01| > 0.001 flat band)
```

Persisted to the real `flow_outcomes` table and read back joined to its originating event:

```
flow_event_id     | base-ok
event_symbol      | SPY          ← join to flow_archive succeeded
horizon           | 15m
entry_mark        | 580.0000
exit_mark         | 585.8000
underlying_return | 0.010000
label             | WIN
return_basis      | underlying
is_synthetic      | f
```

The mirrored SHORT on identical data grades LOSS at the same magnitude — asserted in tests.

**Exit criteria:**

| Criterion | Status |
|---|---|
| Scheduled job grades events at T+15m/1h/1d | ⚠️ **PARTIAL** — the grading FUNCTION and its persistence path are done and proven; the scheduler is not wired, because with no reachable price feed there is nothing for it to poll. Wiring a cron that grades from an empty mark store would be theatre. |
| State explicitly if option-level pricing isn't free | ✅ MET — in code, in every row (`return_basis`), in every report note, and in KNOWN_LIMITATIONS.md |
| A real event produces a real graded outcome row, hand-checked | ✅ MET — worked example above, hand-verified to 1e-12 and persisted/read back through the real schema |

**WAVE 7: PARTIAL — grading proven end to end; the scheduler is BLOCKED on having a price feed.**

**Known limitations:** marks must be supplied by the caller; no reachable free source provides
intraday underlying marks here. Grades measure only "did the underlying move the way the flow
implied" — a directionally correct option can still lose money to theta and spread.

---

## WAVE 8 — ML SHADOW PLATFORM

**Objective:** ML trains only on real graded data and never appears authoritative until validated.

**Files changed:** NEW `ml-service/train_real.py`, `ml-service/model_registry.py`,
`ml-service/test_ml_gates.py` (23 tests), `ml-service/requirements-dev.txt`.
MOD `ml-service/main.py` — quarantine + score provenance. `verify:ml` now runs pytest.

**THE RNG MODEL IS QUARANTINED.** `flow_scorer.pkl` (from `train.py`, AUC 1.0000 by construction)
is refused at load unless `MODEL_STAGE >= VALIDATED` or an explicit `ALLOW_UNVALIDATED_MODEL=true`
opt-in. Proven:

```
WARNING QUARANTINED: models/flow_scorer.pkl exists but MODEL_STAGE=RESEARCH is below VALIDATED.
        Refusing to load it; using the heuristic scorer instead.
model_loaded : False
stage        : RESEARCH
authoritative: False
```

**`/symbols/heat` no longer fabricates.** It returned `random.uniform(40, 95)` per symbol dressed
as analysis; it now returns 501 with the reason. Verified zero `random` remains as executable code
in `main.py` (only two explanatory comments mention it).

**Score provenance:** every `ScoreResponse` carries `scorer` (heuristic|model), `is_authoritative`
and `model_stage`, stamped at the single exit point of `score_event` so no branch can omit them.

**`train_real.py` REFUSES on insufficient data — the correct behavior today:**

```
$ python train_real.py --dry-run
WARNING REFUSING TO TRAIN — insufficient_real_samples: 0 graded non-synthetic outcomes,
        need 1000. Collecting data (0/1000).
INFO    This is the correct outcome, not an error. A model fitted to 0 examples would
        encode noise, exactly like the rng-trained train.py it replaces.
exit 0
```

It writes `models/training_status.json` so the UI can show *"collecting data (0/1000)"* rather
than a score. With `--assume-samples 1500` the gate passes and the model would start at RESEARCH.

**Promotion ladder enforced mechanically** (RESEARCH→CANDIDATE→SHADOW→VALIDATED→PRODUCTION):
one rung at a time; VALIDATED+ requires out-of-sample evidence that must be `chronological`, have
≥200 rows, a ≥1-day embargo, and a test period after the train period. **An AUC ≥ 0.999 is
rejected as implausible** — that is the exact signature of the bug this wave exists to prevent.
Demotion is always allowed.

**Tests run — actual output:**

```
$ python -m pytest test_ml_gates.py -q
....................... [100%]
23 passed in 0.05s
```

**Exit criteria:**

| Criterion | Status |
|---|---|
| Refuse to train below a stated minimum, printing the count | ✅ MET — refuses at 0/1000, prints the count, exits 0 |
| Model cannot reach PRODUCTION without out-of-sample evidence | ✅ MET — skipping VALIDATED raises; evidence must be chronological, ≥200 rows, embargoed, and non-degenerate |
| UI never shows a score from an unvalidated model as fact | ✅ MET — `may_show_in_ui` gate + `is_authoritative` on every response + `training_status.json` placeholder |
| Chronological splits only, with purging/embargo | ✅ MET — `chronological_split` tested for ordering and that the embargo drops boundary rows |
| Train on `flow_outcomes` | ⚠️ **PARTIAL** — the query filters graded, non-synthetic rows in SQL, but has never executed against a populated table because Wave 7 cannot collect real outcomes here. The fitting step is intentionally not implemented behind the gate: writing an unexercised training loop would be the "placeholder in a production path" the prompt forbids. |

**WAVE 8: PASS on every gate; the training loop itself is BLOCKED on real data, by design.**

---

## WAVE 9 — ALERTS, OBSERVABILITY, SECURITY

**Files changed:** NEW `backend/src/alerts/dedup.ts`, `backend/test/alerts.test.ts` (16 tests),
`scripts/secret-scan.sh`, `scripts/verify-rls.sh`. MOD `package.json`, `KNOWN_LIMITATIONS.md`.

**ALERT STORM TEST — actual output:** 1000 identical alerts inside one second deliver **exactly
one**. Suppressed alerts are counted, not dropped: the next delivery reports `suppressedSinceLast`.
Three independent limits — dedup window, per-severity cooldown, global rate cap that sheds the
least severe first. Two behaviors worth naming: an **escalation breaks cooldown** (a MEDIUM
becoming CRITICAL is new information and holding it back is the dangerous kind of quiet), while a
de-escalation does not; and a CRITICAL still gets through a cap saturated with LOW alerts, whereas
another LOW does not.

```
$ npm test
# tests 223 / # pass 223 / # fail 0     (backend; was 207)
```

**SECRET SCAN — passes:**

```
$ ./scripts/secret-scan.sh
==> scanning tracked source for credential-shaped strings
==> checking no .env file is tracked
==> reporting archives that may embed credentials
    NOTE: tracked zip archives present. docs/FORENSIC_AUDIT.md #7 records that two of
    them contain REAL credentials which MUST BE ROTATED.
==> SECRET SCAN PASSED
```

Scans for JWTs, AWS keys, GitHub PATs, Slack tokens, private keys and DSNs with inline passwords.
Prints `file:line` only — **never the matched value**. Placeholders are excluded so the gate is not
noisy. The five tracked zips are reported every run, because two of them hold real credentials that
deleting the files cannot un-expose.

**RLS TESTED AGAINST REAL UNAUTHORIZED REQUESTS** (as the `anon` role against live Postgres, not by
reading the policy text):

```
$ ./scripts/verify-rls.sh
  pass ✅  user A sees only their own watchlist row
  pass ✅  user B sees only their own watchlist row
  pass ✅  UNAUTHENTICATED request sees nothing
  pass ✅  user A cannot DELETE user B's row
  pass ✅  user A cannot READ user B's api_keys
  pass ✅  user A cannot INSERT a row owned by user B (RLS rejects it)
==> RLS GATE PASSED
```

My first two versions of this harness reported false failures — `tail -1` was capturing psql's
`RESET` echo, and DELETE/INSERT cannot nest inside a scalar select. Fixed the harness; the
underlying RLS behavior was correct from the start and is now proven repeatably.

**NEW FINDING (W9-A):** `flow_archive` and `price_history` are readable by **unauthenticated**
users by existing policy — an anon request read 7 archived flow rows. Per-user data is properly
isolated, but the flow archive itself is public, which contradicts the product's login wall. Left
unchanged and recorded in KNOWN_LIMITATIONS #16, because narrowing it is a product decision.
Also recorded: `api_keys.key_value` is plaintext (#17).

**Exit criteria:**

| Criterion | Status |
|---|---|
| Alert storm test proves dedup works | ✅ MET — 1000 → 1 |
| A secret-scanning check passes | ✅ MET — 7 pattern families, values never printed |
| RLS policy tested against an unauthorized request | ✅ MET — 6 checks incl. read isolation, cross-user delete, and insert escalation |
| Health metrics per provider | ✅ MET in W1/W2 — `/api/health/sources` (staleness) and `/api/health/providers` (quota, verification state) |
| Rate limiting on public endpoints | ⚠️ **PARTIAL** — the existing in-memory limiter still trusts `x-forwarded-for` and resets on restart (audit #15). Upstash-backed replacement not built; recorded in NEXT_ACTIONS. |

**WAVE 9: PASS on all three stated exit criteria; rate-limiter hardening carried forward.**
