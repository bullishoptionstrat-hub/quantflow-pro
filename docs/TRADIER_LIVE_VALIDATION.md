# Tradier: what is verified, and what only a live session can verify

A connected stream is not evidence of working market data. F-23 was a Tradier
stream that would have reported `connected` while delivering no usable options
prints. So this document separates what has been checked in this repository
from what still requires a live session with a funded, entitled account.

## Coverage — what the record can and cannot contain

The stream subscribes to a **stated subset** of the options market:

| Setting (env, `render.yaml`) | Default | Meaning |
|---|---|---|
| `TRADIER_UNIVERSE_EXPIRATIONS` | `2` | nearest listed expirations per underlying |
| `TRADIER_UNIVERSE_STRIKE_BAND` | `0.05` | strikes within 5% of the underlying's last price |
| `TRADIER_UNIVERSE_MAX_PER_UNDERLYING` | `100` | contracts nearest that price, per underlying |

Underlyings are the stream's watch list (`WATCHED_SYMBOLS` in
`backend/src/ingestion/index.ts`). The universe is rebuilt every 30 minutes.
**Longer-dated contracts, far out-of-the-money strikes and every other
underlying are never observed**, so a signal on them cannot appear in the
record, and any rate computed from the record is a statement about this subset
only. `/api/health` publishes the rule in force and this statement under
`ingestion.tradierCoverage`.

A malformed setting (`0`, `ten`, a band of `5` meaning "five percent") does
**not** fall back to the default — that would silently change what the record
covers. The stream refuses to subscribe and says why in `sourceErrors.tradier`.

## Verified locally (unit tests, mutation-checked)

- The subscription names option contracts, filtered to `timesale`, never the
  underlyings (`tradierStream.test.ts`).
- Chain rows become contracts only when every field agrees with the OCC
  symbol; SPX and SPXW at one strike and date are two contracts.
- Timesales become prints with `last` as the price and their own bid/ask;
  cancels, corrections, unsubscribed and malformed records are refused and
  counted, never ingested.
- The settings above parse, default and refuse as described.
- The live validator (below) reaches each verdict on the documented shapes,
  holds Tradier out of the record until VALIDATED, and re-holds it if the feed
  degrades.

All of this ran against Tradier's **documented** payload shapes, surfaced by
web search on 2026-10-24. Tradier's hosts are refused by this environment's
egress policy, and no production session has ever run from this repository.

## Requires live validation

These cannot be established without a funded, entitled Tradier account and a
market session:

1. The chain and quote endpoints answer in the documented shape
   (`options.option[]` with `symbol`, `underlying`, `root_symbol`, `strike`,
   `option_type`, `expiration_date`; `quotes.quote[]` with `last`).
2. The stream accepts a few hundred OCC symbols in one subscription (Tradier
   publishes no limit).
3. Timesales arrive for subscribed contracts carrying `last`, `size`, `bid`,
   `ask`, `date` in **milliseconds**, and `cancel`/`correction` flags.
4. A timesale's bid/ask is the quote in force at the trade, not after it.

## The automatic gate

`ingestion.tradierLive` on `/api/health` judges the last 500 prints. Until it
reads `VALIDATED`, **Tradier signals are displayed but not recorded** (the
record is append-only, so a broken mapping cannot be taken back out), the
coverage ledger marks the window as not collected, and `collection:doctor
--url` reports it. Checks, each published with what was observed:

| Check | Requirement |
|---|---|
| universe | non-empty; every contract well-formed and unexpired |
| quoted | ≥ 80% of prints carry bid and ask |
| uncrossed | ≤ 1% of quoted prints have bid > ask |
| plausible-price | ≥ 95% of quoted prints priced within [bid/2, ask×2] |
| timely | ≥ 95% of prints stamped within 5 minutes of receipt |
| identities | ≤ 5% of timesales unsubscribed or malformed |

No verdict is given before 50 prints. The thresholds catch a broken mapping;
they do not grade a feed's quality.

## First live boot checklist

1. `/api/health` → `ingestion.sources.tradier` is `connected` and
   `sourceErrors.tradier` is absent.
2. `ingestion.tradierUniverse.contracts` > 0 and `failures` is empty or
   explained; `ingestion.tradierLive.checks[universe].pass` is true.
3. During a session, `tradierLive.printsSeen` climbs and the state moves
   `AWAITING_DATA` → `VALIDATED`. If it reads `FAILING`, the failing check
   names what is wrong; nothing is recorded meanwhile.
4. `sourceNotes.tradier` shows few or no `not subscribed` / `malformed`.
5. `npm run collection:doctor -- --url <backend>` shows no `Tradier live
   validation` line once validated.
6. Only then treat Tradier signals in the record as observed data.
