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

## F-13 — The gap table under-reported non-collecting time by ~97% ✅ FIXED

**Found by querying the live Supabase project**, which became reachable after
the earlier findings were written. It is the defect the PR's own
"weakest evidence" note predicted: *a fixture is not a database*.

`CoverageRecorder` extends an open gap in place each 60-second tick. Its
docstring claimed a process dying mid-gap "will under-report the tail by **at
most one tick**". The live data refutes that, over a 4,160-minute span of
recorded signals:

```
signal_history           3,244 rows (all synthetic, 0 real)
collection_gaps              9 rows, 126 minutes total   = 3.03% of the span
distinct gap durations       1   -- every row the SAME ~14 min
longest silence in signal_history with NO gap row:  1,978 min (33 hours)
```

**Every gap being identical is the tell.** That is not outages having a
natural length; it is the signature of freeze-at-sleep. The host sleeps after
15 minutes idle, so:

- the open gap freezes at its last written extent — and its `endedAt` becomes
  a **positive claim** that collection resumed at that instant, which is false;
- on wake `lastTickAt` is `null`, so the first tick establishes a baseline and
  writes nothing, and the next window starts at the **wake** instant.

The sleep interval is therefore attributed to nobody, and an unattributed
interval reads as *observed* to anything computing a rate over it. So the one
table built to stop a flattering hit rate — its own docstring says
*"silently dropping them removes the hard cases and makes any hit rate
computed over the window flattering"* — was reproducing exactly that bias, at
about 97% of the non-collecting time.

This is F-1's failure mode (process-memory state lost across a restart) in the
coverage recorder, and it is **worse in one specific way**: F-1 lost outcomes,
which shows up as absence. This writes a positive claim that is wrong.

**Fix:** `recoverMissedWindow()`, called at startup before the tick loop — a
process cannot know it is about to sleep, but the next one can see the hole and
attribute it. Same shape as `SignalGrader.recover()`. A redeploy shorter than
two minutes is not an outage; a first-ever boot invents nothing, by the same
rule `tick()`'s first call already follows.

**Two things caught in my own work while doing it**, both worth recording:

- The test passed under `tsx` with a field name (`recordableConnected`) that
  does not exist on `CoverageSample`. Only `tsc` caught it — `npm run verify`
  typechecks the test tree for exactly this reason.
- I wrote two bare `catch { /* comment */ }` blocks, and `deadSources.test.ts`
  refused them. It was right: a store read failing at boot means coverage
  recovery silently did not run, which is indistinguishable from having nothing
  to claim. They report now.

**Also corrected from this data:** CLAUDE.md records all four history tables at
zero rows. They are not — the deployment has been persisting to Supabase since
2026-09-16. `signal_outcomes` is genuinely empty, but that is **correct**, not
F-1: all 3,244 signals are synthetic and `register()` refuses synthetic by
design. Two sources appear, `simulation` (2,704) and `seed` (540); `seed` is a
real current path at `index.ts:1800`, not a stale artifact.

---

## F-5 — README advertised a deleted service and unqualified capabilities ✅ FIXED

`README.md` listed **"ML unusual score (GradientBoosting) ✅"** and headed a
deployment section **"Backend + ML → Render.com"**. There is no ML service in
this tree; `ml-service/` was deleted three audits earlier, and CLAUDE.md
records why at length — it trained on `np.random` with the label drawn before
the features. Other ✅ rows outran their evidence in the same way: "Live
options flow feed", "Dark pool prints (24hr delay)", "Sweep/Block/Split
classifier".

Closed by `backend/test/readmeClaims.test.ts`, which fails when documentation
claims code that is not on disk, requires the flow-feed row to say it carries
simulated prints rather than showing a bare tick, and is exercised against the
exact row that shipped — a detector with nothing left to catch stops working
quietly. [CLAIMS_LEDGER.md](./CLAIMS_LEDGER.md) carries each claim with its
evidence and the wording the code can support.

**The status table above said OPEN until 2026-09-23**, after the fix had
landed. A stale row in a status table is the same defect this document is
about, one level up: it is a claim about the code that the code no longer
supports, and nothing was checking it.

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

## F-9 — `excursion` was an endpoint return, not a path excursion ✅ FIXED

`grader.grade()` computes `(exitMark - entryMark) / entryMark` — the return at
the horizon **endpoint**. No path, no high, no low is observed: two marks are
taken, one at each end, and everything between them is unseen. §41 is explicit
that this must not be called an excursion.

The two quantities coincide only when the move is monotone, and where they
differ the difference is always in the flattering direction — a maximum
favourable excursion is by construction at least as large as the endpoint
return. Quoting a best-moment measure as though a position had been held is
the category's characteristic lie, so the old name asserted about this
arithmetic precisely the thing the arithmetic does not do.

**Renamed end to end**, TypeScript and SQL, on 2026-09-23:

| | was | is |
|---|---|---|
| `OutcomeRecord` | `excursion` | `directionalReturnAtHorizon` |
| `TrackRecordRow` | `medianExcursion` | `medianDirectionalReturn` |
| `signal_outcomes` | `excursion numeric` | `directional_return_at_horizon numeric` |

`supabase/migrations/20260923040000_directional_return_at_horizon.sql` applies
the column rename and is **applied to the live database** — F-14's lesson is
that a migration correct on disk and never applied makes every write fail, so
disk and deployment were closed together rather than one and then the other.
`signal_outcomes` was at 0 rows, so no data moved; `signal_history` 4,559,
`collection_gaps` 16 and `signal_write_incidents` 0 are unchanged.

**One over-claim corrected during this audit, and kept here.** It was initially
recorded that the payload carries `labelRule: 'MAX_EXCURSION'` while computing
an endpoint return. It does not: `labelRule` is set only in
`flow-engine/outcome/tracker.ts`, the deprecated standalone tracker that
nothing in `src/` imports — and *that* tracker really does implement a
max-excursion rule, which is why the vendored comments naming it are left
alone. What was true is narrower: two production comments referred to
`MAX_EXCURSION` as though it travelled on the row. Both are corrected.

### The part that was not a rename

The append-only trigger `enforce_outcome_immutability` compares
`old.excursion` against `new.excursion` to decide whether an update is the one
permitted kind — retiring a row so a correction can supersede it. **plpgsql
resolves `old.x` at fire time, not at definition time**, so renaming the column
alone fails nothing at migration time and nothing on the next insert. It fails
on the first *correction*.

Demonstrated rather than reasoned about, by restoring the pre-rename function
body inside a transaction that rolls back:

```
insert with renamed column, OLD function: ACCEPTED
retire with OLD function: 42703 -> record "old" has no field "excursion"
```

The function is redefined in the same migration. `set search_path = ''` is
restated on that definition rather than left to
`20260916060000_function_search_path.sql`: `create or replace function`
replaces a function's *configuration* along with its body, so omitting it
would have silently unpinned what that migration pinned. Verified on the live
project — `proconfig` is still `{"search_path=\"\""}`.

### Verified against the live database, rolled back

Every probe ran inside a block that raises at the end, so all seven inserts
reverted and the four tables are at their prior counts.

```
A insert with new column name: ACCEPTED
B old column "excursion": GONE (42703)
C edit in place: REFUSED
D delete: REFUSED
E supersession (retire): ACCEPTED      <- the path that would have broken
F correction row: ACCEPTED
G search_path pinned: true
```

### The rename broke a rendered number, and the audit is what found it

The frontend still declared `medianExcursion` and `Backtest.tsx` bound it to a
table column, so that column would have rendered **`—` forever** — silently, on
a page merged one PR earlier. Every suite stayed green because
`backend/test/fixtures/backtest.json` is a payload *captured before the
rename*: the fixture and the frontend interface drifted from the backend
together, and a test of one against the other cannot see that.

`backend/test/trackRecordWire.test.ts` closes it by holding three things to the
publisher rather than to each other — the frontend's declared fields, the
recorded fixture's keys, and the fields the table actually renders. Three
mutations bite.

### The guard

`backend/test/outcomeTriggerColumns.test.ts` parses every `create table`,
`add column` and `rename column` across `supabase/` in the order a setup run
applies them, then requires every `old.x` / `new.x` the **last** definition of
the trigger names to be a column that still exists. Three mutations bite: the
trigger left naming `old.excursion`, the rename statement removed, and the
`search_path` pin dropped from the new definition.

It is deliberately a column-level check on *one function*, not a general
schema-versus-code column guard. The F-14 class — a migration correct on disk
and never applied — is not reachable from a test that reads source, and a guard
shaped to look like it closed that class would be worse than none.

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

## F-16 — Rights lineage stops at the API boundary ❌ OPEN

**Measured 2026-09-23.** `SignalRecord` carries `source`, `datasetId` and
`rightsClass` on every persisted row. `FlowEvent` — the wire shape behind
`/api/flow`, the `flow_batch` socket event, and the CSV export in
`FlowFeed.tsx` — carries **none of the three**. `grep -c` for
`rights_class|dataset_id|datasetId` returns **0** in both `frontend/lib/types.ts`
and `flowEngineAdapter.ts`.

So §22's taint propagation holds inside the database and stops at the door.
The store, which nothing exports from, knows each row's provenance; the CSV a
reader actually downloads does not.

**Why the gate that exists does not cover this.** Rights are enforced at
exactly two points: `mayOperateConnector` before a connector starts (DISPLAY)
and `classifySource(…, 'PERSIST')` in the recorder and the mark registry. §23
names that pattern specifically — *"Do not place one rights check only at
connector startup and assume the problem is solved"* — and lists API SERVE,
WEBSOCKET and CSV EXPORT as separate gates. None exists.

**Scope, stated precisely, because overclaiming here would be the same defect.**
This is **not** currently leaking prohibited data. The connector gate refuses
`PROHIBITED` for DISPLAY *before* `start()`, so a prohibited dataset never
produces a print at all — Yahoo is refused and emits nothing. And today every
row on the wire is simulation or chain-derived, both of which the wire *does*
mark, via `synthetic`.

**It is a trap on the path the operator is being asked to fund.** The moment a
licensed feed is connected — which is exactly what `PROVIDER_DECISION_RECORD.md`
asks for — a CSV of real vendor prints leaves the building with no dataset
attribution and no rights class, and §152 is explicit that *"an authenticated
user is not automatically permitted to export licensed raw market data."* That
is the same shape as F-2: correct-looking code with a live trap waiting for the
first real OPRA feed.

**Not fixed in this pass, deliberately.** The fix is a wire-shape change on both
sides of a process boundary plus an export gate, and this repository has just
finished proving (F-9's audit) that a wire change with no cross-boundary guard
silently empties what it touches. It is recorded with its measurement so the
next change to `FlowEvent` carries it rather than a later one rediscovering it.

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

## F-14 — The live database was missing two columns every outcome write sends ✅ FIXED

**Found in the live Supabase project, not by reading source.** `information_schema`
reported `public.signal_outcomes` carrying `entry_mark_source` and
`exit_mark_source` but **no `entry_mark_at` and no `exit_mark_at`**. The
migration that adds them — `supabase/migrations/20260917200000_mark_as_of.sql`
— is on disk and was never applied: `supabase_migrations.schema_migrations`
recorded `20240707000000, 20260916050842, 20260916050854, 20260916052123,
20260916080607` and nothing for it.

`supabaseStore.writeOutcome` inserts both columns unconditionally, so **every**
outcome write to the live database would have failed. Reproduced against the
real project, inside a block that raises at the end so it rolled back:

```
PROBE_RESULT: column "entry_mark_at" of relation "signal_outcomes"
              does not exist (SQLSTATE 42703)
```

It was invisible because nothing has ever been graded there: all 3,244 rows in
`signal_history` are synthetic and `register()` refuses synthetic signals, so
`signal_outcomes` sits at 0 rows. It would have become **total** the moment
F-1's recovery fix made grading actually happen — the first real graded
deployment would have written nothing, forever.

**Fixed** by applying the migration (additive: two nullable `timestamptz`
columns and a `not valid` CHECK — §112 data-preserving). Verified afterwards
against the live project, again inside a rolled-back block, with a real parent
`signal_key` so the foreign key was not a confound:

```
write_shape=ACCEPTED; mark_without_stamp=REFUSED(23514);
reversed_pair=REFUSED(23514); equal_stamps=REFUSED(23514);
ungraded_nomarks=ACCEPTED;
```

All four tables were left at their prior counts (`signal_outcomes` 0,
`signal_history` 3,244, `signal_write_incidents` 0, `collection_gaps` 9).

**Bounded afterwards, so F-14 is not read as the first of several.** Every
column `supabaseStore.ts` names was extracted from source (object-literal keys,
PostgREST filter/order/select arguments, and row-property reads, with comments
stripped so prose cannot contribute identifiers) and checked in **both**
directions on 2026-09-21: 46 column names, all present in the live database,
and all created by some migration on disk. No snake_case identifier in the file
fails to be a column. So the two `*_at` columns were the only drift, in either
direction.

One assumption in that pass was wrong and was caught by running it:
`signal_history.iso` looked like a false positive from the `iso()` helper in the
same file, and it is a real `boolean` column. Filtering it out by eye would have
shrunk the audit by one column silently — the same shape as the `grep -v
"Store.ts"` retraction below.

**What this does not close.** Nothing in the repository can detect this class.
The migration was present and correct on disk; the drift was between disk and
deployment, and no test that reads source can see it. `schemaSetup.test.ts`
holds the code to the *files*, which is a different claim.

---

## F-15 — A failed outcome write discarded the checkpoint, silently ✅ FIXED

`grader.tick()` wrapped `writeOutcome` in a try/catch that set `lastError` —
and then ran `p.remaining.delete(horizon)` **outside** it. So a checkpoint
whose write threw was retired in the same breath as one that succeeded: no
row, no retry, no incident, and not one counter moved.

Reproduced with a store that refuses the first write with F-14's real message:

```
attempt 1  horizon M15  label FLAT
tick1 written : 0      tick2 written (retry?) : 0
M15 rows      : 0      incidents              : 0
stats         : graded 0, ungraded 0, flat 0, tracked 0
```

The checkpoint graded **FLAT** — a real, gradable outcome — and was thrown
away. Every counter reads zero, which is exactly what a deployment with
nothing to grade reports. `lastError` is the only trace, it holds the most
recent message only, and `getSignalHistoryStatus()` scrubs it from the
unauthenticated `/api/health`.

The two findings compound: F-14 makes every write fail, F-15 makes that
indistinguishable from an idle grader.

**Fixed.** The failure path now `continue`s before the delete, so the horizon
stays pending and the next tick retries it; `writeFailures` counts refused
attempts and `writeRetrying` derives how many due checkpoints are still owed a
row — both survive the health scrub. Retrying is unbounded by choice: a retry
cap is a second way to lose a checkpoint silently, and `recover()` already
re-derives the set from durable state after a restart. Logging follows
`noteUnparsedFrame` — the first failure, then every hundredth.

After the fix, the same reproduction: `tick2 written: 1`, one M15 row, label
`FLAT`, `writeFailures: 1`.

6 tests, 3 mutations (restoring the delete → 3 fail; dropping the counter → 2;
neutering `countRetrying` → 1).

---

## Retracted — `signal_write_incidents` has no writer

Recorded mid-pass and **withdrawn before it reached the report.** A grep for
`recordIncident` callers excluded `*Store.ts`, which is precisely where both
callers live: `memoryStore.ts:64` and `supabaseStore.ts:77` (plus a second
site at `:103` for the concurrent-insert race) record a `HISTORY_COLLISION`
from inside `writeSignal`. CLAUDE.md's claim that a collision "is recorded as
an incident" is accurate. The filter that was meant to remove noise removed
the evidence — the same shape as every guard-scope finding in this file, in a
one-off command rather than in a committed test.

---

## Status summary

| ID | Finding | Status |
|---|---|---|
| F-1 | Restart lost every pending outcome | **FIXED**, 9 tests, 5 mutations |
| F-2 | Aggregate record → fabricated executions | **FIXED**, 4 tests, 1 mutation |
| F-3 | Wrong leg / directionless grading | **FIXED**, 6 tests, 3 mutations |
| F-4 | `FlowEvent` uncovered by wire contract | **FIXED**, 2 tests |
| F-12 | Graded history hid signals recovery must resume | **FIXED**, 7 tests, 4 mutations |
| F-13 | Gap table under-reported non-collecting time ~97% | **FIXED**, 6 tests, 3 mutations — found in the live database |
| F-14 | Live DB missing both mark-as-of columns; every outcome write would fail | **FIXED** in the live database — migration applied, verified by rolled-back probe |
| F-15 | Failed outcome write discarded the checkpoint silently | **FIXED**, 6 tests, 3 mutations |
| F-5 | README advertises deleted ML service | **FIXED** — `readmeClaims.test.ts`, 3 tests (status row was stale) |
| F-6 | Tier-4 controls absent from this tree | OPEN (documented) |
| F-7 | No entitled options-event source | OPEN, **external blocker** |
| F-8 | No corrections / cancels / ordering | OPEN |
| F-9 | `excursion` misnamed | **FIXED**, 3 tests, 3 mutations — renamed in TS and SQL, migration applied to the live database |
| F-10 | Universal 20:00Z expiry | **PARTLY FIXED**, 6 tests, 3 mutations; AM-settlement and holidays open |
| F-11 | Plaintext `api_keys.key_value`; disclosed credentials | OPEN, **external** |
| F-16 | Rights lineage stops at the API boundary — wire carries no `dataset_id`/`rights_class` | OPEN, measured 2026-09-23 |
