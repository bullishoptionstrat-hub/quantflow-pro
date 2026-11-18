# Next upgrades

Written 2026-11-18, after #140 merged (`2df6778`). Free-first: nothing here may
require a purchase, and anything needing a user decision is marked as such.
Data classes are the A–E classes in `docs/PROGRAM_STATUS.md`.

Scores are 1 (low) to 5 (high). Impact is toward the God's Plan rule set
(measured gates, one attempt, net R). Cost is build effort. Risk is the chance
of shipping a silent wrong answer. "Decision" means the user must choose
something before it can start.

| # | Candidate | Impact | Cost | Risk | Data | Decision |
|---|---|---|---|---|---|---|
| 1 | **Replay outcome grading**: for each ACTIONABLE idea in an imported replay, which came first in later bars, the target or the invalidation; net R per idea; n<30 suppression of any rate | 5 | 2 | 2 | B | none |
| 2 | Bar-import preflight report on `/setups` (gaps by session, rejected rows grouped by reason, RTH coverage per day) before running the replay | 3 | 1 | 1 | B | none |
| 3 | Structure read-only route `POST /api/structure/replay` (events over uploaded bars, same requireAuth + body cap as setups) | 3 | 2 | 1 | B | none |
| 4 | Second playbook: HTF continuation (pullback into a higher-timeframe FVG with trend BOS), versioned like Sweep and Reclaim | 4 | 4 | 3 | B | definitions need the user's sign-off |
| 5 | Third playbook: AMD / iFVG inversion (accumulation, manipulation sweep, inverted FVG trigger) | 4 | 4 | 3 | B | definitions need sign-off |
| 6 | Journal ↔ setup link: a ticket prefilled from an ACTIONABLE replay idea (side, entry, stop, target, setup id as the attempt key) | 4 | 2 | 2 | B | none |
| 7 | Journal sync to Supabase with per-user RLS | 4 | 3 | 3 | — | **proposal only**: a production migration is the operator's call |
| 8 | TradingView webhook → ticket prefill through a versioned adapter (shared secret, payload schema version, refusal by name) | 4 | 3 | 3 | E | needs a secret and an exposed URL: user decision |
| 9 | Ledger Phase D: persist the attempt ledger per user across sessions | 3 | 3 | 2 | — | depends on 7 |
| 10 | Alerts: notify when a live idea turns ACTIONABLE | 3 | 3 | 3 | C/D | blocked on a live bar feed (Phase A) |
| 11 | Research tooling: replay parameter sweep that reports how counts move with each untuned parameter (counts only, no optimisation) | 3 | 2 | 3 | B | none, but invites curve-fitting; would need a pre-registration rule |
| 12 | Calendar 2028 extension before 2027-12-31 | 2 | 1 | 1 | E | none (time-boxed chore) |
| 13 | `/setups` UX: chart of the bars with sweep, displacement, FVG and trigger marks per idea | 3 | 3 | 1 | B | none |
| 14 | Replay report download (JSON + CSV of ideas) with config hash and method versions in the header | 2 | 1 | 1 | B | none |

## Top 3 (no spend, no user decision)

1. **Replay outcome grading (#1).** The replay says what the rules would have
   flagged; nothing yet says what happened after. Grading from the imported
   bars, with the same honesty rules the live grader has (look-ahead is
   impossible by construction, a same-bar touch of both is UNKNOWN not a win,
   data that ends first is OPEN, no rate below n=30), turns the setup engine
   from a signal list into something that can be measured.
2. **Journal ↔ setup link (#6).** Makes the one-attempt rule and the ticket
   gates apply to ideas the engine produced, so the trader does not retype them.
3. **Bar-import preflight (#2).** Cheap, and the replay is only as good as the
   file: gaps and rejected rows should be read before any outcome is.

## Plan for #1

1. `backend/src/setups/outcome.ts`: a pure `gradeIdea(idea, bars, costs)`.
   Starts at the first bar whose `tOpen >= ` the ACTIONABLE transition's
   `knownAt` (never the trigger bar). States: `TARGET_FIRST`, `STOP_FIRST`,
   `AMBIGUOUS_SAME_BAR`, `OPEN` (bars ran out), `NOT_GRADED` (not ACTIONABLE,
   or missing entry/target). R is net of the round-trip cost: target is the
   idea's `netR`, stop is `-1` on the same cost basis. A gap in the bars
   inside the window is reported, not bridged.
2. `summariseOutcomes`: counts by state; a hit rate and mean R only when the
   graded count (target + stop) is at least 30, else `INSUFFICIENT_SAMPLE`.
3. Wire into `runSetupReplay`: `report.outcomes` per idea and a summary; the
   `scope` sentence changes to say what is now computed and what is not.
4. Frontend `/setups`: render the summary and per-idea outcome, with the
   suppression shown as such.
5. Tests: each state, the boundary bar (trigger bar excluded), cost basis,
   suppression at 29/30, a prefix-replay look-ahead check (grading a prefix
   never contradicts grading the whole file for an idea already resolved).

Acceptance: backend and frontend `npm run verify` and `npm run build` pass;
each mutation in the planned list is killed by an intended test; the scope
sentence and PROGRAM_STATUS describe what is graded and what is not.

## Choice after #142 (2026-11-18)

#1, #2 and #6 shipped in #141/#142. The next two picked, both no spend and no
decision:

1. **A planted-episode synthetic fixture that reaches ACTIONABLE.** Not on the
   table above, and it came first because nothing else could be trusted
   without it: the plain fixture walks never take an idea past displacement
   (the FVG must form on the displacement bar), so replay → outcome → ticket
   had only run on a hand-built idea. Building it found a real defect: the
   engine publishes `target` as `{ name, price }` and the ticket link read a
   bare number, so every real ACTIONABLE idea was refused. The fixture plants
   the entry template only; every bar after a trigger is the unconditioned
   walk, and a test re-walks the files to prove it. It is not tuned toward
   wins and is not evidence about anything.
2. **Replay CSV export with provenance (#14).** Cheap, and the export carries
   the method versions, config hash and dataset ids so a file that leaves the
   page still says what produced it.

Not picked: the sensitivity grid (#11) needs a pre-registration rule written
before it runs, which is a decision about method; the read-only structure view
(#3) is worth doing next.

## Desk-grade gap review (2026-11-18, after #143)

What paid desks and flow terminals offer, against what this repo can build at
$0 from data it already has. Vendor claims are from their own marketing pages,
read through a search tool, not from a subscription: every one is
**SEARCH_ONLY**.

| Offered elsewhere | Source | Here today | $0 path |
|---|---|---|---|
| Key levels per symbol, intraday gamma structure, per-strike and per-expiry breakdowns | SpotGamma home page and its own comparison page (spotgamma.com, spotgamma.com/best-gamma-exposure-tool-comparison) — SEARCH_ONLY | `/gex` from the delayed Cboe chain, modelled, call+/put- convention stated | per-expiry breakdown needs per-contract rows the connector does not keep (see below) |
| Positioning estimates (SGOI), live hedging flow (HIRO) | same — SEARCH_ONLY | none | **not buildable honestly**: who is short which contract is not in a public chain; a $0 version would be the invented positioning this repo refuses |
| Real-time options flow and dark-pool prints | Unusual Whales, as described on SpotGamma's comparison page — SEARCH_ONLY | `/flow`, `/dark-pool`; keyless deployment is simulated | needs an entitled OPRA feed (`PROVIDER_DECISION_RECORD.md`), not $0 |
| Option monitor: a chain grid by expiry with bid/ask, IV, greeks, OI | Bloomberg OMON, from general knowledge of the product, not read here — SEARCH_ONLY | none; Cboe rows are aggregated and dropped | a delayed chain view; blocked on memory (an SPX chain is ~20k rows on a 512 MB host) and on a fixture: `gex.json` cannot be re-recorded because the Cboe CDN is refused here |
| Market-structure overlay (levels, swings, FVGs, SMT) on the user's own bars | common to SMC/ICT tooling — SEARCH_ONLY | the structure engine exists and no page shows it | **built in this pass** (`/structure`) |
| Keyboard-first workspace (go-to page, focus, help) | standard on desk terminals (Bloomberg's function-key navigation) — SEARCH_ONLY | Ctrl/Cmd+K palette only | **built in this pass** (desk hotkeys) |

Chosen, both no spend and no decision: the read-only **structure page** and
**desk hotkeys**. The delayed chain view is next, and needs two things first:
a bounded per-contract store (one symbol at a time, evicted) and a fixture
generated by code from a recorded chain once the CDN is reachable.

## Choice after #144 (2026-11-18)

Two picked, both no spend and no decision:

1. **Sensitivity-grid pre-registration (#11, template only).** The grid was
   held back because it needs a pre-registration rule written before it runs.
   That rule is now code: `backend/src/research/preregistration.ts` validates a
   plan (`npm run research:prereg-check -- <plan.json>`), and
   `research/preregistrations/TEMPLATE.json` is the blank, generated from the
   code and held to it by a test. It is fail-closed: real parameters only,
   every axis contains the shipped default, at most 200 cells, counts-only
   metrics, `REPORT_ALL_CELLS`, `minDecided >= 30`, data named by SHA-256 with a
   disjoint holdout, and a FROZEN plan needs a real past date and unexamined
   data. **No grid was run and no plan was written**: choosing the question and
   the datasets is the trader's decision.
2. **Desk layout persistence.** `/desk` panels can be hidden, kept in this
   browser under the journal's rules (an unreadable value is never
   overwritten; unknown ids survive a save). Risk state cannot be hidden: a
   view preference must never take the daily lock off the screen.

Not picked: the delayed chain view (Cboe CDN refused here), journal sync
(production migration), anything needing paid data.

## Choice after #145 (2026-11-18)

Two picked, both no spend and no decision, both frontend-only over data the
page already has:

1. **Per-idea drill-down on `/setups`.** Each idea's transitions render as a
   timeline: minutes since the first transition, `knownAt`, state, the cited
   bar and its close, cited events and blockers. `lib/ideaTimeline.ts` checks
   the engine's own fields against each other and flags, never repairs: a
   transition knowable before its cited bar closed (`BEFORE_BAR_CLOSE`), rows
   out of `knownAt` order, unreadable bar ids or clocks. Every recorded
   engine idea in `setupReplayEpisodes.json` passes with no flag.
2. **Journal breakdown by model / instrument / session profile / process /
   tag.** Counts and summed R per bucket; a rate only where that bucket alone
   reaches n=30. Tag buckets overlap and the page says so.

Not picked: the candlestick structure chart (larger, and the structure page
already lists events), the grid runner (worth doing, but it is a research
tool that runs the engines and deserves its own review), the delayed chain
view (Cboe CDN refused here).

## Choice after #146 (2026-11-18)

Two picked, both no spend and no decision:

1. **Grid runner that refuses anything but a FROZEN plan.**
   `research/sensitivityGrid.ts` (`npm run research:grid`) runs only when
   `validatePreregistration` says VALID and FROZEN, and only on CSV files whose
   SHA-256 are exactly the plan's analysis datasets; a holdout file is refused
   by name. Every cell is a `runSetupReplay` call and every cell is reported in
   plan order, counts only. Tested against a synthetic TEST plan over the
   episode fixtures; no real plan exists and none was written or frozen.
2. **Candlestick chart on `/structure`.** The structure report now carries its
   closed bars, and `lib/structureChart.ts` decides what may be drawn at a
   replay cursor: closed bars only, each mark at the bar that closed at its
   `knownAt` (a swing at its confirming bar, not its pivot), FVG boxes ending
   at their first terminal event.

Why these: both were named last round as worth doing; both reuse existing
engines and fixtures. Not picked: the post-trade review flow (the journal
already freezes the ticket beside the fill; a review view is next), the
accessibility audit (partly covered by the chart's keyboard range input), the
delayed chain view (Cboe CDN refused here).

## Chosen 2026-11-18 (after #147)

Two $0 upgrades that need no decision from the operator:

1. **GEX chart clock reads the chain's `asOf`.** `GEXChart` printed `updatedAt` (when this server answered) as the chart's time, so a 15-minute-delayed chain looked current. This closes the open item in CLAUDE.md's `/api/gex` note. No backend change; the field already exists.
2. **Post-trade review on `/journal`.** Planned (frozen ticket) against recorded entry, stop, units, average exit vs targets, net R, costs, process vs outcome, violations and the one repeat/avoid action. Built from existing journal data only; no new storage, no new metric.

Skipped this round: the accessibility/keyboard audit (larger, deserves its own PR), and everything on the standing skip list (delayed chain grid, paid data, production migrations, secrets, playbook definitions, real sensitivity grid).
