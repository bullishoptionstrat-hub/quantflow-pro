# Session authority model

Directive §3 and §12. "Is the market open?" has no single answer, and F-18
answered it anyway: one verdict, computed from the exchange calendar, printed on
every page as **MARKET OPEN**. The audit of 2026-09-27 showed the cost. At 21:00
on a Sunday SPX options trade in their global session while that label said
CLOSED; at 07:45 on a weekday OPRA's supported window may be open while SPY has
no established session and H-001 admits nothing. Those are different facts, and
a single boolean can only ever report one of them while sounding like all four.

F-18's decision to centralise the answer in the backend was right and is kept.
What changed is that there are now **separate authorities**, each with its own
module, its own sources and its own UNKNOWN.

## The authorities

| question | module | answers | when it cannot say |
|---|---|---|---|
| What date and minute is it in New York? | `market/civil.ts` | `marketDateOf`, `minutesEt`, `instantEt` (DST-safe, round-tripped), `addDays` | an unreadable instant or a wall-clock time a DST jump skips → `null` |
| Is the exchange holding a session that day, and what are its published regular hours? | `flow-engine/calendar.ts` (vendored engine) | `sessionOn(date)`: `REGULAR`, `EARLY_CLOSE`, `HOLIDAY`, `WEEKEND`, `UNKNOWN` | outside `COVERAGE` (2026 only) → `UNKNOWN` |
| Is the exchange's regular session in hours now? | `market/session.ts` → `/api/health.session` | `OPEN` / `CLOSED_OUTSIDE_HOURS` / `CLOSED_HOLIDAY` / `CLOSED_WEEKEND` / `UNKNOWN`, with `authority: 'EXCHANGE_REGULAR_SESSION'` | calendar `UNKNOWN` |
| Is the feed inside the hours it says it supports? | `market/feedSessions.ts` | `FeedSessionState`: `SUPPORTED` / `OUTSIDE_FEED_WINDOW` / `UNKNOWN` | before the first recorded rule; non-session days; outside the exchange's own hours on an early-close day |
| May this product trade now, and in which session? | `market/productSessions.ts` | `ProductSessionState` + `TradingSessionClass` (`REGULAR`, `EXTENDED`, `CURB`, `GLOBAL`) | an unregistered product; a family before it is effective; any window a rule does not establish (`outsideWindows: 'UNKNOWN'`) |
| May this **contract** still trade? | `market/contractLifecycle.ts` | `contractSessionAt` adds `LAST_TRADING_DAY_ENDED` over the product answer | lifecycle `UNKNOWN`; a last trading day whose minute is not established, outside the exchange's own hours |
| Does this event belong in a study's sample? | `market/researchEligibility.ts` | `ResearchSessionEligibility`: `INCLUDED` / `EXCLUDED` / `UNKNOWN` | a conflict, an unreadable identifier, or no evidence where the rule forbids clock inference |

The trade's own **session evidence** — what the provider said — is read by
`events/session.ts` (see [`OPRA_EVENT_SEMANTICS.md`](OPRA_EVENT_SEMANTICS.md)).
It is evidence, not an authority: the research rule reads it first and
consults the clock only when the provider said nothing at all.

## The invariants, and the moments that prove them

A split that never disagrees is one answer with several names, so each
invariant is tested at a moment where two authorities give different answers
(`backend/test/sessionAuthority.test.ts`):

- **INV-SESSION-001 — feed availability is not product tradability.** 07:45 ET:
  OPRA's stated window `SUPPORTED`, SPY's session `UNKNOWN`. 21:00 ET: SPX
  `OPEN` in its global session, OPRA `OUTSIDE_FEED_WINDOW`.
- **INV-SESSION-002 — product tradability is not research eligibility.** 16:30
  ET: SPX `OPEN` in its curb session; a trade carrying the extended-hours
  identifier is `EXCLUDED` from H-001-v2.
- **INV-SESSION-003 — provider evidence outranks the clock.** Identifier `1`
  at 10:00 ET is `EXCLUDED`, although the clock says regular hours. The clock
  is consulted only on basis `NONE`, labelled `CLOCK_INFERENCE`, and a rule may
  forbid it (`clockInference: 'NEVER'` → `UNKNOWN`).
- **INV-SESSION-004 — the ETH transitional encoding stays interpretable.**
  Identifier at its default (`0`) beside `v` is `EXTENDED`
  (`LEGACY_SALE_CONDITION`), not a conflict — fixture 15. The directive's own
  example had it the other way round; see `OPRA_EVENT_SEMANTICS.md`.

## The labels

The sidebar reads `/api/health.session` and every label names the authority it
has — the exchange's regular session, RTH — and never a wider one:

| state | label | why not the old one |
|---|---|---|
| `OPEN` | `RTH OPEN` (`RTH OPEN · HALF DAY` on a 13:00 close) | "MARKET OPEN" claimed every product and venue |
| `CLOSED_OUTSIDE_HOURS` | `OUTSIDE RTH · 09:30–16:00 ET` | "CLOSED" was false whenever an extended, curb or global session was running |
| `CLOSED_HOLIDAY` | `NO RTH · HOLIDAY` | a holiday evening can open the next day's global session |
| `CLOSED_WEEKEND` | `NO RTH · WEEKEND` | Sunday evening is Monday's SPX global session |
| `UNKNOWN`, or no answer | `SESSION UNKNOWN` | never painted as closed |

Each tooltip says what the verdict is not: "Exchange regular trading hours only
— not the OPRA feed window, not extended, curb or overnight product sessions,
and not any study's sample." `backend/test/wireContract.test.ts` fails if a
label says `MARKET OPEN` or begins with `CLOSED`.

## Sources, and their standing

Nothing here is `PRIMARY_VERIFIED` — the OPRA and Cboe documents were refused
by the egress policy (see `OPRA_EVENT_SEMANTICS.md` for the probe).

| fact | status | source |
|---|---|---|
| exchange holidays and early closes, 2026 | as recorded in `calendar.ts` (read 2026-09-23) | NYSE/Cboe published schedules |
| OPRA supported window 07:30–17:00 ET from 2026-09-21 | UNVERIFIED | operator audit's quotation of the OPRA notice |
| SPX regular 09:30–16:15, curb 16:15–17:00, global 20:15 (prior evening)–09:25 | UNVERIFIED | operator audit's quotation of Cboe |
| SPXO effective 2026-11-09, SPX schedule | SEARCH_ONLY | Cboe announcement, surfaced by search |
| Cboe equity-options extended hours for select names: GTH 07:30–09:25, Curb 16:00–16:15; reported to OPRA with `v`; not last-trade eligible | SEARCH_ONLY | Cboe Equity Options Extended Trading Hours FAQ, surfaced by search 2026-09-27 |
| SPY's close (16:00 or 16:15) and any SPY extended session | not established | sources conflict; SPY is recorded to 16:00 only and everything after is `UNKNOWN` |

The Cboe FAQ result is why SPY's 16:00–16:15 stays `UNKNOWN` rather than
`REGULAR`: for the names in Cboe's program that quarter-hour is a **curb**
session, reported with `v`.

## Limits

- The calendar covers 2026. Every authority above answers `UNKNOWN` beyond it,
  including for historical research in 2025 — which is why H-001-v2's window is
  inside 2026.
- Nothing publishes the feed, product or research answers on `/api/health` yet;
  the sidebar shows only the exchange's regular session, labelled as such.
  Showing the others is a UI change with nothing to show until a product is
  traded live.
- `feedSessions.ts` cannot say whether overnight global sessions are carried by
  OPRA outside its stated window, so `OUTSIDE_FEED_WINDOW` means "outside the
  stated window", not "no OPRA message can exist now".
