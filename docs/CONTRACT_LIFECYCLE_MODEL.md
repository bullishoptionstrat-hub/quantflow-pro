# Contract lifecycle model

Directive §11. Code: `backend/src/market/contractLifecycle.ts`. Tests:
`backend/test/sessionAuthority.test.ts`.

## The problem F-10 left open

`expiryInstantMs` (vendored engine) answers "when does this contract expire?"
with the exchange's close on the listed date — 16:00 ET, or 13:00 on a published
early close. That is wrong by a whole session for AM-settled index options:
standard SPX settles on the expiration date from **opening** prices, so it stops
trading the **business day before**. A one-off patch (`if root === 'SPX' &&
monthly`) would be obsolete before it shipped — Cboe has announced SPXO,
AM-settled weeklies, from 2026-11-09 (subject to regulatory review) — so the
answer is an effective-dated registry, keyed by root and governed by the rule
in force on the contract's expiration date.

## The rule shape

`ContractLifecycleRule`: `productFamily`, `roots`, `settlementStyle`
(`AM` / `PM` / `PHYSICAL` / `UNKNOWN`), `expirationRule`, `lastTradingRule`
(`day`: `EXPIRATION_DAY` / `PRECEDING_BUSINESS_DAY` / `UNKNOWN`; `time`: a
wall-clock ET time or `null`), `settlementReference`, `effectiveFrom`,
`effectiveTo`, `status`, `source`, `sourceReadAt`, `note`. Session windows are
the product session registry's (`productSessions.ts`); the lifecycle reads it
rather than repeating it.

**Where a fact is contested or unknown, the rule records the date it is sure of
and leaves the time `null`.** A caller then gets `DATE_ONLY`, never a
precise-looking instant nobody read.

## The registry today

| family | roots | settlement | last trading | effective | status |
|---|---|---|---|---|---|
| SPX standard | `SPX` | AM, opening prices | business day before expiration, 16:15 ET | 2026-01-01 (registry coverage) | UNVERIFIED — operator audit's summary of Cboe |
| SPXW | `SPXW` | PM, closing value | expiration day, 16:00 ET (expiring series; others run to 16:15) | 2026-01-01 | UNVERIFIED — recalled |
| SPXO | `SPXO` | AM, reference not established | business day before expiration, **time not established** | **2026-11-09** | SEARCH_ONLY |
| SPY | `SPY` | physical delivery | expiration day, **time not established** (16:00 vs 16:15 conflict) | 2026-01-01 | UNVERIFIED |
| XSP | `XSP` | **not established** | **not established** | 2026-01-01 | registered so it answers `UNKNOWN` by rule, not by omission |

## Behaviour the tests pin

| case | answer |
|---|---|
| SPX expiring 2026-10-16 (AM monthly) | last trading 2026-10-15 16:15 ET (`KNOWN`); at 10:00 on the 16th: `LAST_TRADING_DAY_ENDED` |
| SPXW expiring 2026-10-16 (PM) | last trading 2026-10-16 16:00 ET; at 10:00 on the 16th: `OPEN`; at 16:05: `LAST_TRADING_DAY_ENDED`; at 16:05 on the 15th (not its expiration day): `OPEN` |
| **half day** — SPXW expiring 2026-11-27 | `DATE_ONLY`: neither 16:00 nor 13:00 is assumed |
| **holiday shift** — SPX listed 2026-06-18 (third Friday is Juneteenth) | last trading 2026-06-17, found by walking the calendar |
| SPX "expiring" 2026-06-19 (a holiday) | `UNKNOWN`: no contract settles on a day without a session, and choosing which neighbour it meant is a guess |
| **newly effective family** — SPXO 2026-11-04 | `UNKNOWN`: the family is not in force |
| SPXO 2026-11-18 | AM, last trading 2026-11-17, `DATE_ONLY` |
| **unknown product** — `ZZZZ` | `UNKNOWN`, no instant |
| **beyond coverage** — SPXW 2027-03-19 | `UNKNOWN` (calendar coverage ends 2026-12-31) |
| SPY 2026-10-16 at 15:00 / 16:05 on the day | `OPEN` / `UNKNOWN` — after 16:00 nothing is claimed |

Every `UNKNOWN` case asserts `lastTradingInstantMs === null`: **no fabricated
16:00**.

## INV-CONTRACT-001

*Last trading time is product- and effective-date-specific.* Tested at the
moment it matters most: 10:00 ET on 2026-10-16, where SPX (AM) has already
stopped and SPXW (PM) is trading — the same index, the same instant, two
answers.

## What does not consume it yet — stated, not hidden

- **The engine's DTE** (`expiryInstantMs` → `daysToExpiry` → `score.ts`, and
  the wire's `days_to_expiry`) still uses the exchange close, with a fallback
  for dates the calendar does not answer. That code is vendored; making it read
  this registry moves the registry into the engine module (as the calendar was
  moved) and changes every SPX monthly's DTE and score. It is a separate,
  behaviour-changing step, and the directive's exit gate asks for the registry,
  not for the rescoring.
- **Research eligibility** does not yet refuse a print stamped after its
  contract's last trading moment. It cannot touch H-001-v2's sample, whose
  decision window closes at 15:45 ET — before the one SPY ambiguity (16:00 or
  16:15 on expiration day) — and the rule is written into H-001-v2's exclusions
  anyway, so it is applied whatever the window.
- The UI does not show lifecycle state.
