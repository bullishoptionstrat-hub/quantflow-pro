# QuantFlow Pro — Forensic Audit

**Audit date:** 2026-09-19
**Tree:** `claude/quantflow-pro-forensic-audit-cnmsrv`, from `847a8fa`
**Method:** every finding below was reproduced by running code in this tree.
Comments, prior reports and README prose were treated as claims to be checked,
never as evidence. Where a claim could not be checked without credentials this
document says so rather than resolving it.

This is Phase 0 of the mandate: establish what is true before changing
anything. Findings 1–3 were fixed in this session; the rest are recorded with
status and evidence and are not fixed here.

---

## 0. Test baseline, executed

| Suite | Result |
|---|---|
| `backend` (`npm run verify`) | **612 pass / 0 fail**, typecheck clean |
| `frontend` (`npm run verify`) | **132 pass / 0 fail**, typecheck clean |
| `quantflow-modules/flow-engine` | **30 pass / 0 fail** (run while fixing F-10; CLAUDE.md says 24, which is stale) |

The backend suite was 587 at session start and one test failed:
`socketHandlers.test.ts` loads `socket.io-client` from `frontend/node_modules`.
That is an environment coupling, not a code defect — it passes once the
frontend is installed. It is worth naming because a backend suite that cannot
run without a sibling package installed will fail in CI for a reason that looks
like a product bug.

---

## F-1 — A process restart permanently lost every pending outcome ✅ FIXED

**Severity:** critical. This is the single reason a track record could not
accumulate, independent of credentials, rights or storage.

`SignalGrader.pending` is an in-memory `Map`. Nothing repopulated it at
startup. `listUngraded()` was implemented in **both** stores, declared on the
`SignalStore` interface and exercised by two tests — and called by **nothing**
in `src/` or `tools/`.

**Reproduced.** A grader registered against a surviving store, then discarded
and rebuilt (which is exactly what durable storage gives you across a restart):

```
recorded signals awaiting grading : 2
grader #1 tracked                 : 2
grader #2 tracked after restart   : 0
outcomes written at M15 due       : 0
signals STILL awaiting grading    : 2
control (re-registered) outcomes  : 2
```

The signal row survives in `signal_history` with no outcome, forever, and
nothing ever looks at it again. On Render's free tier — the documented
deployment target, which sleeps after 15 minutes of inactivity, and 15 minutes
is also the shortest horizon — this is close to every checkpoint the system has
ever scheduled.

**Two latent traps found while fixing it:**

- `listUngraded` asked for fewer than **four** live outcomes — the size of the
  `OutcomeHorizon` union, which includes the never-graded `EXPIRY`. The open
  set could therefore never drain. Inert while nothing called it; with recovery
  wired in it would have re-registered every finished signal on every boot.
- An entry mark stamped **after** the decision was unguarded. The age is a
  subtraction, so a mark from the future made it negative and passed the
  too-early check — the same hole `nbbo.ts` had when a quote stamped after the
  trade produced a negative age.

**Fix:** `SignalGrader.recover()`, wired into `startSignalHistory()`, with a
source-scan guard asserting the wiring. Recovery never re-takes an entry mark:
it reuses the one persisted on an existing outcome row, or the signal grades
UNGRADED with the reason stated. The loss becomes visible rather than silent —
the same argument `collection_gaps` makes about outages. `recovery` is
published on `/api/health`; the number that matters is
`resumed - withEntryMark`.

---

## F-2 — One aggregate record became several "observed" executions ✅ FIXED

**Severity:** critical for research integrity. This is INV-004.

`ingestPrint` split a record carrying `exchanges: [A, B, C]` and `size: 60`
into three trade events of 20, one per venue, under the comment *"a multi-venue
fill is several prints, one per venue — that is what makes it a sweep"*. That
is an assumption written as arithmetic.

**Reproduced.** One upstream record in:

```
upstream records ingested      : 1 (id=AGG1, size 60, 3 venues)
printIds on the signal         : ["AGG1-0","AGG1-1","AGG1-2"]
observed executions claimed    : 3
distinct venues on the signal  : 3
order_type (classification)    : SWEEP
```

It fabricated the print count, the size at each venue, three event identities
and their simultaneity. **And the classification itself**: the engine's sweep
test is `new Set(trades.map((t) => t.exchange)).size >= 2`, so the
decomposition manufactured the exact evidence the `SWEEP` label is built on.

**Why it survived:** `flowEngineAdapter.test.ts` asserted it as the contract —
*"one print id per venue"*, *"size is split across venues"*. The defect was not
an oversight; it was pinned by a test.

**Scope, stated precisely:** the only producer of multi-venue records in this
tree was the **simulation**. The Tradier stream sets the singular `exchange`
and the four chain-snapshot connectors pass a one-element list. So no real
source ever triggered it. It was a live trap on the primary data path, waiting
for the first genuine OPRA-style feed — which is precisely what Phase 1 of the
mandate exists to obtain.

**Fix:** one record is one event. The venue list is kept as evidence
(`venue_evidence`, `venue_allocation: OBSERVED | UNKNOWN`) rather than
discarded or converted into fills. The simulation now emits genuinely separate
executions, because that is what it is actually modelling. Verified on a live
boot: 67 rows, all `venue_allocation: OBSERVED`, all 21 SWEEPs backed by two or
more separately observed executions.

---

## F-3 — Multi-leg signals were graded from the wrong leg, and strangles graded directionally at all ✅ FIXED

**Severity:** high. This is INV-010, and it is a defect CLAUDE.md records as
*already fixed*.

`SignalGrader.register()` read `rec.legs[0]`. The engine stores legs in the
order their contract+side groups were first seen, so that is whichever leg
printed first.

**Reproduced** on CLAUDE.md's own fixture — a bought $102k SPY call alongside a
bought $2.2k put, the put printing five milliseconds earlier:

```
legs[0]        : P $2200
dominantLegOf  : C $102000
underlying move: +2% (favours the $102k call leg)
graded label   : NEGATIVE  excursion: -0.0200
```

`dominantLegOf()` was written for exactly this defect. It lives in
`flow-engine/outcome/types.ts`, used only by the standalone `OutcomeTracker` —
which **nothing in `src/` imports**. The fix landed in the deprecated path; the
production path kept the bug. This is the general hazard of a module vendored
for reference: a fix can be applied to the copy nobody runs.

**The second half.** Even the *dominant* leg is the wrong basis here. Two long
wings is a long strangle: a position on movement, not on direction. Grading it
bullish or bearish from its larger leg puts a directionless position into a
directional hit rate.

**Fix:** direction comes from the highest-premium leg, and `STRADDLE_STRANGLE`
grades UNGRADED with the reason stated. Risk reversals stay graded (long one
wing, short the other — genuinely directional), and so does `UNKNOWN`, because
refusing everything the classifier could not name would empty the track record
over a coverage gap rather than a finding.

---

## F-4 — `FlowEvent` was the one wire shape never checked against a payload ✅ FIXED

`wireContract.test.ts` exists specifically to catch "a page reading a field the
API does not send". `assertDeclaredFieldsExist` guarded `GEXLevel`,
`GEXResponse` and `DarkPoolPrint` — and never `FlowEvent`, which CLAUDE.md
names as *the* flow wire contract and which the whole suite was built around.

The same shape as a guard scoped to a directory the offender was not in, which
this repository has now found several times.

---

## F-12 — A long graded history hid every signal a restart had to resume ✅ FIXED

**Severity:** critical, and self-inflicted. It is F-1's own failure mode
reintroduced one layer down by F-1's fix.

`SupabaseSignalStore.listUngraded` takes the **oldest** `limit * 4` real
signals and filters by outcome count *afterwards*. A graded signal never
leaves `signal_history`, so that prefix becomes permanently fully-graded — and
once it exceeds the fetch window, every pending signal sits beyond it and the
method returns **empty**.

Before F-1 this was inert twice over: nothing called `listUngraded`, and its
`< 4` count could never exclude anything so the filter was a no-op. F-1 made it
load-bearing **and** made the filter real. Recovery would then resume nothing
on a healthy deployment with pending checkpoints, and report `examined: 0` as
though there were none.

**Reproduced**, in the shapes PostgREST actually returns, with a stub that
honours `order`/`limit`/`gte`:

```
2,000 graded signals + 100 pending  ->  listUngraded(500) returned 0
                                        (expected 100)
```

**Fix:** `listUngraded(limit, sinceMs?)`. The grader passes a window derived
from its own table — `HORIZON_OFFSETS_MS.D1 + maxLatenessMs` — because a signal
older than that has no checkpoint left that could produce anything but
UNGRADED, and scanning for it would make boot a function of how much history
exists rather than how much is pending. Both stores honour it, because a
fixture against one proves nothing about the other.

**How it was found, which is the point.** The PR that introduced F-1's fix
named this method as its weakest-evidence part — "covered against the
in-memory store and by nothing that has touched a real database" — and shipped
it. That is verbatim the lesson the CLAUDE.md ledger's last entry records about
the previous review: *naming a risk is not covering it*. The fixture was
written on the next pass instead of before the merge, and it found a real
defect immediately.

---

## F-5 — README advertises a deleted service and unqualified capabilities ❌ OPEN

`README.md:139` lists **"ML unusual score (GradientBoosting) ✅"**. There is no
ML service in this tree; `ml-service/` was deleted, and CLAUDE.md documents why
at length — it trained on `np.random` with the label drawn before the features.
`README.md:107` still heads a deployment section **"Backend + ML → Render.com"**.

Other ✅ rows that outrun the evidence: "Live options flow feed", "Dark pool
prints (24hr delay)", "Sweep/Block/Split classifier". See
[CLAIMS_LEDGER.md](./CLAIMS_LEDGER.md) for each claim with its evidence and the
wording the code can support.

---

## F-6 — Every control named in TIER4_FINAL_REPORT.md is absent from this tree ❌ OPEN

`TIER4_FINAL_REPORT.md` (dated 2026-08-22, against tree `/root/arch2`) is a
report about a **different tree**. Searched for, and not present here:

| Control the report describes | In this tree |
|---|---|
| `research/experiments/` (experiment registry, preregistration) | **absent** |
| Append-only raw spool (Phase R) | **absent** |
| Market-calendar coverage (Gate 7) | **absent** |
| OSI symbol normalization (Phase F) | **absent** (only `occSymbol` construction in the adapter) |
| Coverage manifests (Phases L/M/N) | **absent** — `persistence/coverage.ts` + `collection_gaps` is a narrower thing: it records outage windows, not observation denominators |
| `ml-service/` | **absent** (deliberately deleted) |

Per §6 of the mandate these are `MISSING_FROM_CURRENT_TREE`. The report should
not be read as describing this codebase. Its **rights findings** (Cboe's
auto-extraction prohibition, the four sources whose terms forbid the access
method used) are corroborated independently by `provenance/rights.ts` in this
tree and remain live.

---

## F-7 — No entitled real options-event source exists ❌ OPEN, EXTERNAL

Measured from a live boot of this tree (keyless):

```
sources: 20 reported
  connected : simulation, cboe
  error     : cboe_options, occ, coingecko, stooq
  disabled  : tradier, polygon, flashalpha, marketdata, schwab,
              tastytrade, twelvedata, fmp, finnhub, eventregistry,
              fred, reddit, newsapi          (13, no credentials)
  refused   : yahoo                          (data rights, not a fault)
```

`RECORDABLE_SOURCES` — the five the doctor will consider for PERSIST — is
`tradier, polygon, marketdata, schwab, tastytrade`. None is contributing.
CLAUDE.md records that on the credentialed deployment Polygon's plan returns
**403 `NOT_AUTHORIZED`** for `/v3/trades/options`: credentialed, not entitled.

**This is the binding constraint on the entire mandate** (§100, §111). Until an
entitled options-trade or options-quote path exists, every microstructure
finding in this document is about code correctness, not about market data. No
amount of engineering here removes it.

---

## F-8 — Corrections and cancels are not modelled ❌ OPEN

`grep` for correction/cancel semantics in `flow-engine/types.ts` and
`flowEngineAdapter.ts` returns nothing. `RawPrint` has no `eventType`, no
`sequence`, no correction linkage. Every received print is treated as
permanent.

Not reachable today — no feed here delivers corrections — and it becomes a
correctness requirement the moment one does (§21). Related: there is no
out-of-order handling either; the engine's watermark assumes roughly-ascending
arrival, which `RawPrint.ts`'s own comment states as a requirement rather than
enforcing.

---

## F-9 — `excursion` is an endpoint return, not a path excursion ❌ OPEN

`grader.grade()` computes `(exitMark - entryMark) / entryMark` — the return at
the horizon endpoint. No path, no high/low, is observed. §41 is explicit that
this must not be called excursion; `directionalReturnAtHorizon` is the accurate
name.

**One over-claim corrected during this audit.** I initially recorded that the
payload carries `labelRule: 'MAX_EXCURSION'` while computing an endpoint
return. It does not: `labelRule` is set only in
`flow-engine/outcome/tracker.ts`, the deprecated standalone tracker. What is
true is narrower — two production comments (`persistence/types.ts:116`,
`persistence/backtest.ts:25`) refer to `MAX_EXCURSION` as though it travels on
the row, and it does not. A naming and comment defect, not a live mislabel.

---

## F-10 — A universal 20:00Z expiry, in three places ⚠️ PARTLY FIXED

`score.ts`, `outcome/tracker.ts` and `flowEngineAdapter.ts` each parsed
`${date}T20:00:00Z` under the comment "~4pm ET close".

**Measured, because the size of this matters to what it deserves:**

```
2026-01-16T20:00:00Z -> 15:00 ET        (EST — an hour early)
2026-06-19T20:00:00Z -> 16:00 ET        (EDT — correct)

DTE bucket flips (2/7/21/45 days): 33 of 20,572 sampled trade instants = 0.16%
max score swing when it flips:     3 of 100
```

So the comment is false for about five months a year, and the arithmetic
barely moves. It was fixed anyway, on the narrow grounds that it is **exactly
fixable without a calendar to maintain** — the IANA database ships with Node —
and that a false comment is its own defect here.

`flow-engine/expiry.ts` is the one home, imported by all three call sites
(which had also disagreed with each other about rounding). It resolves 16:00
`America/New_York` by asking the tz database which UTC offset lands there,
rather than encoding this year's DST rule as arithmetic.

**Still open, and deliberately not guessed at:**

- **AM-settled index options.** SPX monthlies stop trading the preceding
  Thursday and settle from Friday's open, so their last tradeable instant is
  about a day earlier than this returns. SPXW weeklys are PM-settled and are
  correct. Separating them needs per-product settlement data this tree does
  not carry.
- **Half-days and holidays.** An early close is 13:00 ET. A holiday calendar
  is a thing to maintain, and CLAUDE.md records what happened the last time one
  was assumed instead: a `MARKET OPEN` indicator green on Thanksgiving.

**A note on the guard, since it is the interesting part.** The first version
carried a date-shape regex in front of the lookup. The mutation that deleted it
failed **no test** — the round-trip check already rejects everything it would
have. An unreachable guard is a check with nothing to check, so it was removed
rather than kept for comfort, and the rejection test was widened to prove the
remaining guard does the work.

---

## F-11 — `api_keys.key_value` is plaintext, and the table is unused ❌ OPEN

`supabase/schema.sql:44` and `schema.sql:26` both declare `key_value text not
null`. CLAUDE.md documents that nothing reads or writes this table and that it
cannot work without making ingestion per-user. A plaintext credential column
that no code uses is still a plaintext credential column in a schema someone
will eventually run (§81).

**Also open, and larger:** the credentials committed inside the root archives
are disclosed and must be rotated **at the vendors**. CLAUDE.md is explicit
that removing the files from the tip does not remove them from history, and
that this is an act outside the repository that no test here can perform or
verify (§83).

---

## Status summary

| ID | Finding | Status |
|---|---|---|
| F-1 | Restart lost every pending outcome | **FIXED**, 9 tests, 5 mutations |
| F-2 | Aggregate record → fabricated executions | **FIXED**, 4 tests, 1 mutation |
| F-3 | Wrong leg / directionless grading | **FIXED**, 6 tests, 3 mutations |
| F-4 | `FlowEvent` uncovered by wire contract | **FIXED**, 2 tests |
| F-12 | Graded history hid signals recovery must resume | **FIXED**, 7 tests, 4 mutations |
| F-5 | README advertises deleted ML service | OPEN |
| F-6 | Tier-4 controls absent from this tree | OPEN (documented) |
| F-7 | No entitled options-event source | OPEN, **external blocker** |
| F-8 | No corrections / cancels / ordering | OPEN |
| F-9 | `excursion` misnamed | OPEN |
| F-10 | Universal 20:00Z expiry | **PARTLY FIXED**, 6 tests, 3 mutations; AM-settlement and holidays open |
| F-11 | Plaintext `api_keys.key_value`; disclosed credentials | OPEN, **external** |
