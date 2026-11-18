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
| `/setups` page and import route | NOT STARTED | Next after this milestone. |
| Journal sync to Supabase | NOT STARTED | |
| TradingView webhook to ticket prefill | NOT STARTED | |
| Real options-event source for the flow engine | REQUIRES USER DECISION | `docs/PROVIDER_DECISION_RECORD.md`: cost and OPRA non-display licensing. |
| Merge of this milestone's PR | REQUIRES USER DECISION | Opened as a draft; not merged. |

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
