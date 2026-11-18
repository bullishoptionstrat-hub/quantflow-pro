# Program status

As of 2026-11-18, on branch `claude/tender-wozniak-0jgmkx`. This file records what exists and how far each part has been checked. It is not a roadmap (`docs/ROADMAP.md` is). Nothing below is evidence that any setup has an edge.

## Status labels

Exactly these labels are used:

- **IMPLEMENTED AND VERIFIED**: code exists, tests run here, and it has run against the real input it is built for.
- **IMPLEMENTED, NOT RUNTIME-VERIFIED**: code and tests exist, and it has never run against real input.
- **PARTIALLY IMPLEMENTED**: some of the stated scope exists.
- **BLOCKED BY DATA**: cannot proceed without a data source this deployment does not have.
- **BLOCKED BY ENVIRONMENT**: cannot proceed from this container (network policy, missing binary or key).
- **REQUIRES USER DECISION**: waits on a choice only the user can make (spend, rights, merge).
- **NOT STARTED**.

## Capability matrix

| Capability | Status | Evidence / gap |
|---|---|---|
| Bar import (`backend/src/market/barImport.ts`, `docs/BAR_IMPORT.md`) | IMPLEMENTED, NOT RUNTIME-VERIFIED | Tested on seeded synthetic CSVs in `backend/test/fixtures/bars/`. No user CSV of real bars has been imported. |
| Structure engine (`backend/src/structure/`) | IMPLEMENTED, NOT RUNTIME-VERIFIED | Prefix-equals-batch look-ahead guard on fixtures and seeded walks. No real bars. |
| Setup engine, Sweep and Reclaim / Sell the Rip (`backend/src/setups/`) | IMPLEMENTED, NOT RUNTIME-VERIFIED | `setupEngine.test.ts`, `setupLookahead.test.ts`; ten-mutation pass below. Parameters are untuned. |
| Setup replay (`npm run research:setup-replay`) | IMPLEMENTED, NOT RUNTIME-VERIFIED | Byte-identical report on two runs over the synthetic fixtures. Signal events only: no P&L, hit rate or win rate. |
| Live bars (Phase A) | BLOCKED BY ENVIRONMENT | The network policy refuses the vendor host, and there is no key. |
| Setup engine fed by live data | BLOCKED BY DATA | Depends on Phase A or a user import. |
| Outcome grading of setups / ledger (Phase D) | NOT STARTED | Needs a bar source first. |
| `/setups` page and `POST /api/setups/replay` | IMPLEMENTED, NOT RUNTIME-VERIFIED | `setupsRoute.test.ts` (route output equals the CLI's for the fixture, body cap, named refusals, no store writes, `requireAuth` only) and `frontend/test/setupReplay.test.tsx`. Not opened in a browser against a running backend; no real bars. |
| Replay idea → ticket link (`frontend/lib/replayIdea.ts`) | IMPLEMENTED, NOT RUNTIME-VERIFIED | `frontend/test/replayIdea.test.tsx`, including a tighten-only invariant over 400 generated tickets. The recorded fixture has no ACTIONABLE idea, so the link has only been exercised on a constructed one. |
| Bar-import preflight (`backend/src/market/barPreflight.ts`, `POST /api/setups/preflight`, PREFLIGHT panel on `/setups`) | IMPLEMENTED, NOT RUNTIME-VERIFIED | `backend/test/barPreflight.test.ts` (recorded fixture held to the route) and `frontend/test/barPreflight.test.tsx`. Synthetic and hand-built CSVs only. |
| Journal sync to Supabase | NOT STARTED | |
| TradingView webhook to ticket prefill | NOT STARTED | |
| Real options-event source for the flow engine | REQUIRES USER DECISION | `docs/PROVIDER_DECISION_RECORD.md`: cost and OPRA non-display licensing. |
| Setup engine PR #139 | MERGED | Merge commit `df1c711`. |
| Merge of the setups-page PR | REQUIRES USER DECISION | Opened as a draft; not merged. |

## Free-data feasibility

Classes (the user's definitions):

- **A**: verified free. Terms and availability were read from a primary source here and permit the intended use at no cost.
- **B**: user-imported. Data the user supplies themselves.
- **C**: limited, delayed or incomplete free data.
- **D**: paid or entitled data.
- **E**: not yet verified. Terms or availability were not read from a primary source here; any claim about it is unverified.

| Source | Class | Note |
|---|---|---|
| User CSV of 1-minute bars | B | The only path used by this milestone. Provenance `USER_IMPORT`. |
| Twelve Data free tier (bars) | E | Host refused by the network policy from this container; terms for bar retention not re-read for this use. |
| Any other free intraday bar source | E | None read here. |

No source is class A today: nothing was verified free from a primary source here.

Rights findings for the sources the backend already uses live in `backend/src/provenance/rights.ts` and `docs/DATA_RIGHTS_MATRIX.md`; this table covers only bar data for the setup engine.

## Mutation pass (setup engine)

Each mutation was applied once to `backend/src/setups/sweepReclaim.ts`, run against `setupEngine.test.ts` and `setupLookahead.test.ts` only, then restored with `git checkout --`.

| Mutation | Result |
|---|---|
| Wick (no reclaim) as reclaim | killed: "a wick with no reclaim starts no idea" |
| SMT absent passes | killed: "missing SMT blocks", "unaligned SMT blocks" |
| Gross R instead of net | killed: "under 2R net of costs" |
| Missing costs read as zero | killed: "missing costs block" |
| Events visible one bar early (`knownAt` from the event bar) | killed: look-ahead guard and 12 others |
| Expiry ignored | killed: "a trigger after expiry is not taken" |
| Attempt ledger ignored | killed: "a second attempt ... after a ledger round-trip" |
| First touch as trigger | killed: valid progression and 3 others |
| Midrange check dropped | killed: "midrange, compression and no range each block" |
| Un-invalidation (INVALIDATED re-evaluated) | survived every behavioural test (only the rules pin failed); closed by "a terminal idea stays terminal" |

The rules pin (`the rules are pinned to SETUP_RULES_VERSION`) fails on every edit to the engine, so it is not counted as a kill.

## Handoff

- Next, in order: a read-only `/setups` page and import route over the same engine; journal sync to Supabase; TradingView webhook to ticket prefill; then Phase D once any bar source exists.
- The setup definitions (`backend/src/setups/sweepReclaim.ts` header) are proposed interpretations, versioned by `SETUP_METHOD_VERSION`. Changing a rule means bumping `SETUP_RULES_VERSION`.
- Before trusting a replay on real data, import a real CSV and check its gap list and rejected rows in the report.

## Mutation pass (setups page and route)

Each mutation was applied once, run against `backend/test/setupsRoute.test.ts` or `frontend/test/setupReplay.test.tsx` only, then restored.

| Mutation | Result |
|---|---|
| Body cap raised fourfold | killed: "a body over the cap is refused with 413" |
| Route fills a missing cost with 0 | killed: "missing costs are refused by name" |
| Route mounted on `requireAuthOrDemo` | killed: "mounted on requireAuth ... never the demo tier" |
| Unknown body fields accepted | killed: "a missing CSV, a non-string CSV and an unknown field are each named" |
| Page defaults the timestamp convention to OPEN | killed: "empty: every required field is named" |
| Page drops the empty-cost check | killed: all four page tests (the required-list text the tests match changes) |
| Refusal reasons not rendered | killed: "error: a refusal is listed reason by reason" |
| Route imports the store | killed: "the route and the replay write nothing" |

## Replay outcome grading (2026-11-18)

`backend/src/research/setupOutcome.ts` grades each ACTIONABLE idea from the same imported bars: the first bar opening at or after the ACTIONABLE `knownAt` that touches the target (`TARGET_FIRST`, +net R) or the invalidation (`STOP_FIRST`, -1R on the gate's cost basis). A bar touching both is `AMBIGUOUS_SAME_BAR`; bars ending first is `OPEN`; gaps inside the window are counted, not bridged. No hit rate or mean R below 30 decided ideas (`MIN_PUBLISHABLE_SAMPLE`). It lives in `research/`, so `SETUP_RULES_VERSION` is unchanged. Not P&L: fills, slippage past the stop and size are not modelled. The synthetic fixture produces no ACTIONABLE idea, so every published number so far is suppressed; agreement with the engine's `COMPLETED` bar is tested through the real state machine.

| Mutation (one at a time, `setupOutcome.test.ts` or `setupReplay.test.tsx`) | Result |
|---|---|
| Trigger bar read | killed (3 tests) |
| Same-bar touch of both read as target | killed: "a bar touching both is AMBIGUOUS" |
| Stop scored 0R | killed: "stop first is -1R" |
| Gross R at target | killed (2 tests) |
| Sample floor 29 | killed: "no rate below 30" |
| Ambiguous counted toward the floor | killed (2 tests) |
| Gaps not reported | killed: "a gap ... is reported" |
| SHORT stop read as LONG | killed: "SHORT mirrors LONG" |
| OPEN scored as a loss | killed: "bars ending first is OPEN" |
| Missing net R graded | killed: "... is NOT_GRADED" |
| Page renders a rate when suppressed | killed (2 tests) |

## Replay idea to ticket (2026-11-18)

An ACTIONABLE replay idea with a finite entry, invalidation and target on the right sides of each other gets an "Open as ticket" link on `/setups`. The link fills, on an empty ticket only, the instrument (when it is a preset), direction, setup ID, entry, stop and one target price. The setup ID is the idea's content hash, so the journal's one-attempt rule (`firstAttempt`) applies to it like any typed ID. It answers no gate, picks no model, writes no narrative, leaves the target's liquidity kind unanswered and supplies no budget, cost or slippage. The ticket shows where the numbers came from and that they are history, not a live quote. A link whose fields fail the same checks it was built with is refused whole. The saved record carries `origin` (`REPLAY_IDEA`, hash, setup, method version, ACTIONABLE time); no gate reads it.

| Mutation (one at a time, `replayIdea.test.tsx`) | Result |
|---|---|
| Any state links, not only ACTIONABLE | killed (2 tests) |
| Geometry not checked | killed (4 tests) |
| Setup ID overwrites a typed one | killed (1) |
| Entry overwrites a typed one | killed (1) |
| Target kind answered EXTERNAL | killed (1) |
| Prefill answers `firstAttempt` PASS | killed (2) |
| Link version not checked | killed (1) |
| Page drops the setup ID | killed (1) |
| Direction overwrites a chosen one | killed (1) |
| Non-hash ID accepted | killed (1) |

## Bar-import preflight (2026-11-18)

`market/barPreflight.ts` runs `importBarsCsv`, the replay's own parser, and summarises its output per file: rejected rows grouped by reason (`CELL_COUNT`, `TIMESTAMP`, `NOT_DECIMAL`, `OFF_MINUTE`, `BAR_SHAPE`, `DUPLICATE`, `OUT_OF_ORDER`, `OTHER`; a row counted once per kind), gap count and minutes, gap minutes inside the calendar's published regular session, and each ET date against that session (bars, RTH bars over RTH minutes, coverage, bars outside RTH). A half day is measured against its 13:00 close. A date past the calendar's coverage is `UNKNOWN` and nothing is computed for it; weekend and holiday bars are named, not dropped. `POST /api/setups/preflight` takes the replay's body and reads only the timestamp convention (no default) and the files. The `/setups` PREFLIGHT button needs the symbols, both files and the convention, not the cost. Nothing is filled, repaired or stored. The replay is not gated on a preflight.

| Mutation (one at a time) | Result |
|---|---|
| A row counted once per reason, not per kind | killed (1) |
| The close minute counted inside RTH | killed (1) |
| An UNKNOWN date assumed in gap minutes | killed (2) |
| An UNKNOWN day measured | killed (1) |
| Assumed 09:30-16:00 for every session | killed (1) |
| Date walk skips days | killed (2) |
| Thin-day threshold loosened to 90% | killed (1) |
| Off-minute folded into TIMESTAMP | killed (2) |
| Route defaults the convention | killed (1) |
| Weekend bars not warned | killed (2) |
| Panel renders a null RTH gap as 0 | killed (1) |
| Panel does not require the convention | killed (1) |
| Panel renders any OK body as a preflight | killed (1) |

## Planted-episode fixture and replay CSV (2026-11-18)

`backend/tools/fixtures/syntheticEpisodes.ts` writes `EPISODE_SPY_1m.csv` / `EPISODE_QQQ_1m.csv` (five January days, one planted Sweep and Reclaim entry per day, QQQ planted with the higher low that makes SMT) and `test/fixtures/setupReplayEpisodes.json` is the CLI's report over them. It is the only recorded input on which ideas reach ACTIONABLE (5 or more, all on planted trigger bars). Everything outside the template, including every bar after a trigger, is the plain `syntheticBars.ts` walk; `syntheticEpisodes.test.ts` re-walks the files to prove it. Outcomes are whatever the walk does, the sample is far below 30 and no rate is published. Driving it through the page found that the ticket link read `target` as a number while the engine sends `{ name, price }`, so no real idea could open a ticket; fixed, and `episodeReplay.test.tsx` runs replay → outcome → ticket on engine output.

`frontend/lib/replayCsv.ts` exports the replay from `/setups` (DOWNLOAD CSV): method versions, config hash and per-dataset content id and provenance as `#` lines, the backend's suppression reason instead of a rate below the floor, empty cells for absent values, formula-shaped text prefixed with `'`.

| Mutation | Result |
|---|---|
| link reads `target` as a number (the pre-fix code) | killed: 2 in `episodeReplay.test.tsx` |
| link reads the stop as the target | killed: 2 |
| walk step changed | killed: byte pin and walk tests (3) |
| no sweep below the low / no SMT higher low / trigger closes under the gap / QQQ episodes misaligned | killed: byte pin (1 each) |
| bars after a trigger nudged | killed: byte pin (1) |
| CSV: absent value written as 0 | killed (2) |
| CSV: formula guard only for `=` / no quoting / rate published below floor / config hash dropped / datasets dropped / newline kept in a header value / outcome not joined by id | killed (1–2 each) |
| CSV: terminal state taken from the first transition | **survived**, closed by asserting the last state per row |

The generator mutations are killed by the byte pin (the committed files must equal the generator's output), not by a behavioural assertion; the unconditioned-walk test is the one that would catch planting after a trigger if the files were regenerated.
