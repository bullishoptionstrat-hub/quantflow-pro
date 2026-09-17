# QuantFlow Pro — state of play and the plan from here

Written 2026-09-13. Everything asserted here was checked against the running
tree or a cited page read on that date. Where something could not be verified,
it says so — the same rule `CLAUDE.md` applies to the code applies to this file.

---

## Part 1 — Where we actually are

### What is green

| Check | Result |
|---|---|
| `backend` — `npm test` | **437 / 437 pass** (~105s) |
| `frontend` — vitest | 127 tests (per ledger) |
| `quantflow-modules/flow-engine` | 24 tests (per ledger) |
| Working tree | clean, on `main`, 54 merged PRs |

The engineering is in good shape. Fifty-four pull requests have gone into one
question — *is this number true?* — and the answer machinery is real:
`decisionAt` discipline, `dominantLegOf()`, the n=30 publication floor, the
rights registry, the zero-fill ledger, `committedSecrets.test.ts`.

### What is red, and it is the only thing that matters

**The terminal has never seen a real options trade, and has never graded a real
outcome.** `/api/track-record` reports `total: 78, synthetic: 78, real: 0`.
That is not a display bug. It is the literal state of the system.

`npm run collection:doctor` says **verdict: no, 2 of 6 conditions block
collection**:

- **BLOCKED — Durable storage.** `SUPABASE_URL` / `SUPABASE_SERVICE_KEY` unset.
  History is in memory and dies on restart.
- **BLOCKED — Underlying marks for grading.** `TWELVE_DATA_API_KEY` unset, and
  `getSpotPrice` (`connectors/twelveData.ts:102`) reads *only* the Twelve Data
  cache. Every outcome returns `UNGRADED — no usable entry mark`.
- warn — Twelve Data is `UNVERIFIED` for PERSIST (§16.1 retention cap).
- warn — Render free tier sleeps at 15 min, which is exactly the M15 horizon.

### Finding A (new) — the doctor's one `[ok]` is not ok

The doctor reports:

> `[ ok ] A source permitted to persist — polygon — permitted for PERSIST in
> PRIVATE_RESEARCH and credentialed.`

Probed directly on 2026-09-13 with the key in `backend/.env`:

| Endpoint | Status |
|---|---|
| `GET /v3/trades/options?limit=1` | **403** `NOT_AUTHORIZED` — "You are not entitled to this data" |
| `GET /v3/snapshot/options/AAPL` | **403** |
| `GET /v2/last/trade/AAPL` (equity) | **403** `NOT_AUTHORIZED` |
| `GET /v2/aggs/ticker/AAPL/prev` | 200 |

The key is a free/basic Polygon (now **Massive**) plan. It is entitled to
end-of-day equity aggregates and **nothing the ingestion pipeline asks for**.
`src/ingestion/index.ts:1028` polls `/v3/trades/options` — that call has been
returning 403 every cycle.

Two pieces of corroboration, so this rests on what was run rather than on
inference. First, `backend/.env` holds exactly five variables — `DEMO_MODE`,
`EVENT_REGISTRY_API_KEY`, `FINNHUB_API_KEY`, `FRED_API_KEY`,
`POLYGON_API_KEY`. **`TRADIER_TOKEN` is absent**, so the other entitled
options path is not merely unentitled, it is unconfigured. Second, the doctor
reached the same conclusion independently: Tradier is `PERMITTED` for PERSIST
in `PRIVATE_RESEARCH` (`rights.ts:132-133`) and would have been named on that
`[ok]` line had it been credentialed. It named only polygon.

So the single source the doctor calls "permitted for PERSIST **and
credentialed**" is entitled to zero options trades. **`credentialed` is not
`entitled`,** and the doctor only checks the former: `CONNECTOR_CREDENTIALS`
asks "is the variable set?", never "does the vendor honour it?".

This is the third generation of the same bug this repo keeps finding:

1. a dead Stooq page presenting itself as data (ledger line 81),
2. `.env` loaded after the import graph, reporting a dead source `connected`
   (line 82), then the same bug again inside the doctor itself (line 140),
3. and now — a source that is configured, reachable, *and refused*, reported as
   the one thing that is working.

It is the worst of the three, because it is the `[ok]` line in the program you
open precisely when you are confused about what is live.

### Finding B (new) — what is actually connected, measured

Read from a **running backend's** `/api/health` on 2026-09-13, not from `curl`
(see the correction at the end — it matters):

| State | Sources |
|---|---|
| `connected` | `cboe`, `cboe_options`, `coingecko`, `eventregistry`, `finnhub`, `fred`, `occ`, `simulation` |
| `disabled` (no credentials) | `tradier`, `twelvedata`, `marketdata`, `schwab`, `tastytrade`, `flashalpha`, `fmp`, `newsapi`, `reddit` |
| `error` | `polygon` — the 403 above |
| `refused` (data rights, not a fault) | `yahoo` — `PROHIBITED` for DISPLAY in `PRIVATE_RESEARCH` |

`RECORDABLE_SOURCES` — the five the doctor will consider for PERSIST — is
`tradier`, `polygon`, `marketdata`, `schwab`, `tastytrade`. Four are
`disabled`, one is `error`. The recorder agrees: **recorded 67, synthetic 67,
graded 0.**

**The only options data reaching the engine is a chain snapshot.**
`cboe_options` is `connected` and working — but ledger line 135 defines
`synthetic` as "simulated, replayed, **or chain-derived**", so it is excluded
from the record by design. You have a working options *chain* and no options
*flow* at all.

**Correction worth keeping.** An external `curl` sweep got two of these
backwards. Event Registry failed to connect from `curl` and looked dead — the
connector pulled **37 headlines** on boot. Yahoo answered `429` and looked
rate-limited — the connector never sends a request at all, because the rights
gate refuses it first. *An external probe measures an endpoint; only the
process measures a connector.* Which is Finding A arriving from the opposite
direction.

### Finding C — the oldest item, still open, still outside the repo

Ledger line 139. `git log --diff-filter=A` confirms **8 archives across 5
commits**, earliest **2026-06-12**, latest **2026-08-27**, all pushed to a
public remote. They are untracked now and `committedSecrets.test.ts` stops the
next one. It does nothing about the last: removing a file from the tip does not
remove it from history.

**Rotation is an act at each vendor that no test here can perform or verify.**
One of the exposed keys bills per call. This is the only item on this page with
real money attached, and it is the only one that cannot be closed by writing
code.

### The honest one-line summary

> QuantFlow Pro is a rigorously honest options-flow terminal that has never
> received any options flow. It is a simulator with an exceptionally good
> conscience.

That is not a failure — the conscience is the hard part and it is done. But it
means **every feature idea below is worth zero until the pipe is open.**

---

## Part 2 — What "100× better" has to mean

Not more panels. You already have twelve routes. Adding a thirteenth to a
system with no data multiplies zero.

The 100× is three step-changes, strictly ordered, each worthless without the
one before it:

1. **Real data in.** An entitled options feed. Today: none.
2. **Real record out.** Persistence + a legal mark source + a process that
   outlives its own 15-minute checkpoint. Today: none of the three.
3. **Real edge found.** Replay and backtest over *your own* accumulated
   history — the thing that turns a feed into an asset.

Everything the competitors have that you don't is downstream of 1 and 2. And
one thing they *can't* have, you already built: a grader that refuses to
publish a flattering number. That is your actual differentiator, and it is
currently pointed at an empty table.

**The scheduling fact that decides the whole plan:** n=30 graded outcomes is
*calendar* time, not work time. Two weeks of feature-building before the
collector runs is two weeks of history you will never get back. So Phase 0 is
"start the clock," and it happens first.

---

## Part 3 — What the field looks like (researched 2026-09-13)

Read against live vendor and review pages on the date shown. Prices and
features move; anything I could not confirm is marked.

### The platforms

| Platform | What it is actually good at | Price (as read) |
|---|---|---|
| **Unusual Whales** | Breadth. Real-time flow from every US exchange, dark pool across 50+ venues, GEX **+ DEX + vanna + charm**, a dedicated 0DTE feed, sector heatmaps, congressional disclosures, historical flow download | not confirmed |
| **SpotGamma** | Interpretation, not data. Dealer-positioning levels plus written commentary — the commentary *is* the product | ~$89/mo indices-only |
| **MenthorQ** | The same levels, delivered *onto a TradingView chart*; futures/overnight focus (ES, NQ, CPI/FOMC sessions) | not confirmed |
| **Tradytics** | **Backtested setups** — "large call sweeps within 15 min of a key level, here is how that performed across hundreds of past instances" | $69/mo Pro (AI flow, GEX/DEX) |
| **InsiderFinance** | AI flow *scoring* + heatmaps across strike / expiry / sector | not confirmed |
| **Market Chameleon** | Earnings & volatility depth — IV rank/percentile, skew, term structure, unusual volume, vol-risk-premium backtests | not confirmed |
| **OptionStrat** | The P/L visualiser and multi-leg builder, plus position tracking | not confirmed |

One number worth holding loosely: reviews claim AI flow classifiers reach
**70–75% accuracy separating directional bets from hedges**, on the premise
that sweeps are 15–20% of daily options volume. Treat that as marketing until
measured — and note that *measuring it* is precisely what your grader exists
to do. **A published, honestly-floored hit rate is a thing none of these
vendors offer.**

### The eight capability axes, scored against your tree

| # | Capability | You have | Cost to close |
|---|---|---|---|
| 1 | GEX / DEX / vanna / charm per strike | GEX route only | **cheap** — same chain, more greeks |
| 2 | 0DTE-specific flow lens | nothing | **cheap** — an expiry filter over existing flow |
| 3 | Multi-leg structure recognition | leg grouping + `dominantLegOf()` | **cheap** — you are one classifier from it |
| 4 | Historical replay + scanner backtest | `polygon-replay.ts` adapter, grader | **medium**, and it is the crown jewel |
| 5 | Flow scoring with *published* hit rates | the whole grader | **already ahead** — just needs data |
| 6 | IV surface / term structure / earnings vol | nothing | medium — needs greeks in the chain |
| 7 | Saved scanner presets | client-side filters only | cheap |
| 8 | Adjacent datasets (dark pool, congress, insider) | dark-pool route | expensive — new vendors, new rights entries |

**#1, #2, #3, #5 and #7 are all reachable from data you can already get.**
That is the shape of the plan.

### Data vendors, as read on 2026-09-13

| Vendor | Relevant tier | Verdict for this project |
|---|---|---|
| **Tradier Brokerage** | API free to every account holder; **real-time US stock + options quotes and streaming included with a funded account**; no real-time for non-accountholders | **The unlock.** Already wired (`TRADIER_TOKEN`, `wss://ws.tradier.com`), already `PERMITTED` for DISPLAY *and* PERSIST in `PRIVATE_RESEARCH`, already has a token-verdict probe that distinguishes prod / sandbox / rejected |
| Massive (ex-Polygon) | Basic free (EOD); Starter $29 (15-min delayed); Developer $79 (delayed + trades); **Advanced $199 (real-time, trades + quotes)** | Your key is Basic. Options trades start at $79/mo delayed |
| Twelve Data | **Basic free — 8 credits/min, 800/day**; Grow $29; Pro $99 | Free tier is *enough* for grader marks on a small watchlist. Note Basic is "internal non-display usage" and §16.1 caps retention |
| Databento | OPRA Standard $199/mo (7y OHLCV + 12mo L0/L1); real-time from $1,399/mo annual | Historical tier is plausible for backtesting; real-time is out of scope |
| CBOE DataShop / All Access | intraday files 15-min delayed; OPRA fields need professional-subscriber designation | Already consuming the free delayed JSON |

**The decisive line:** a funded Tradier account converts a $199/mo problem into
a $0/mo one, on the only source in your registry that is `PERMITTED` for
PERSIST. Nothing else on this table competes with that.

---

## Part 4 — The plan

Five phases. Phase 0 is hours and starts the clock; nothing later is worth
doing before it.

### Phase 0 — Start the clock (today, ~2–4 hours)

Goal: `collection:doctor` prints **verdict: yes**, and history begins
accumulating in wall-clock time while you build everything else.

- [ ] **0.1 — Rotate the exposed credentials.** At each vendor, not in the
      repo. Eight archives, five commits, public remote, since 2026-06-12. One
      bills per call. Do this first because it is the only item with money on
      it and the only one no code can do for you.
- [ ] **0.2 — Supabase.** Create the project, run `supabase/schema.sql`, then
      **every file in `supabase/migrations/` in filename order** — the four
      tables the grader writes (`signal_history`, `signal_outcomes`,
      `signal_write_incidents`, `collection_gaps`) live only in the migration.
      Set `SUPABASE_URL` / `SUPABASE_SERVICE_KEY`.
- [x] **0.3 — `TWELVE_DATA_API_KEY`** *Done 2026-09-16.* Set, and probed rather
      than assumed: `entitled`, HTTP 200 from `api.twelvedata.com`. Verifying it
      end to end is what found the health-reporting gap and the credit
      arithmetic — see the two CLAUDE.md notes and PR #58. **The open caveat
      here was answered 2026-09-17, and its premise was wrong.** The WebSocket
      does not carry the board: the subscribe ack accepts **QQQ and AAPL and
      refuses the other eight**, SPY included, so REST was never a fallback —
      it is the only path to a mark for most of the watchlist, and it could not
      complete a cycle. Both are fixed: the rotation is scoped from the ack,
      cut to the per-minute cap less a reservation for the entitlement probe
      (which the first live boot proved was needed — the boot pass refused the
      probe), and paced off the 800/day cap at ~19 min for eight symbols, with
      a `scheduleDailyReset` counter as the backstop pacing cannot provide
      across Render's restarts. Note what this does *not* buy: a 19-minute mark
      cannot grade an M15 horizon, and `Mark` carries no as-of for the grader
      to notice — see 2.4. ~~The REST batch requests 10 symbols against an
      8/min cap and can never succeed; whether that matters depends on whether
      the WebSocket carries the board during a session, which is still
      unmeasured.~~ ~~on the free Basic tier, **then
      `npm run collection:doctor -- --probe`**. Setting the key is not the
      exit condition — that is the exact move 1.1a removed from this tool.
      Twelve Data's entitlement to `/price` on the `WATCHED` symbols is
      unverified on the free tier, and their public `demo` key already refuses
      SPY while serving AAPL, so a symbol-scoped plan is a real shape here. 8 credits/min is
      ample for spot marks on a short watchlist. Unblocks the grader today.~~
      (The last sentence was wrong in a way worth keeping visible: 8 credits/min
      is ample for a *short* watchlist, and this one is ten symbols.)
- [ ] **0.4 — Decide the retention question** and write the answer into
      `rights.ts`. Twelve Data §16.1 caps retention at "duration permitted by
      subscription" and §2.3 bars commercial use of free-tier data. In
      `PRIVATE_RESEARCH` that is arguably fine — but the registry currently
      records `UNVERIFIED`, which means *we have not read our own plan*. Either
      resolve it to `PERMITTED` with the clause quoted, or add the retention
      policy the doctor notes the code does not have. **Phase 1.3 may delete
      this item entirely** — read it before buying anything.
- [ ] **0.5 — Keep the process awake.** The shortest horizon is M15 and
      Render's free tier sleeps at 15 minutes. Either a paid instance, an
      external ping, or accept that M15 stays `UNGRADED` — but choose, and
      write the choice down, because a sleeping process *silently* stops
      collecting.

**Exit test:** `npm run collection:doctor` → `Verdict: yes`. From that moment,
every day is sample.

### Phase 1 — Real data in (week 1)

- [x] **1.1a — Teach the doctor the difference between configured and
      entitled.** *Done 2026-09-14.* `src/ingestion/entitlement.ts` holds one
      probe per vendor with a per-source status map that says whether it was
      measured or documented; `--probe` asks. Check 2 and check 4 both stopped
      claiming entitlement from a set variable, and the live board now reaches
      the verdict. 30 guards in `test/entitlement.test.ts`; six mutations run
      back through them, each failing exactly the intended one. Check 3
      (`Durable storage`) was the same defect and is narrowed, not probed —
      see 1.1c.
- [ ] **1.1c — Probe Supabase. Narrowed 2026-09-16, still open.**
      Check 3 claimed two set strings mean records survive a restart — and so
      did `initPersistence`, which set `durable: true` with the reason *"history
      survives restarts"*. `src/persistence/serviceKey.ts` now classifies the
      credential **offline** and both consumers read the verdict: an anon or
      publishable key in the service slot, a lapsed key, or a key issued for
      another project are each `blocked` with the fault named. Measured against
      the live project, which issues both key eras side by side.
      **Why this does not close the item.** The success path is "this key writes
      `signal_history`", and measuring it needs a real `SUPABASE_SERVICE_KEY` in
      the environment — which must be set in `backend/.env` by hand and never
      pasted into a transcript. A probe built from what is reachable today would
      have `entitled` as the one branch never observed, which is the shape
      `entitlement.ts` refuses. The right-shape branch therefore stays a `warn`
      with the sentence it always had: shape is not validity.
- [x] **1.1b — Probe at startup, not only from the tool.** *Done 2026-09-15.*
      `startEntitlementProbes()` sweeps at boot and hourly (`.unref()`ed);
      `/api/health` gains an `entitlement` block with a per-source verdict and
      timestamp, and a denial appends to `sourceNotes` without ever writing
      `sources`. Verified on a real boot: `polygon: refused`. Found on the way:
      the `.unref()` guard scanned only `connectors/`, leaving nine timers in
      `index.ts` unchecked — scope widened to all of `src/`, no exception list. This is Finding A and it is the highest-value code change on
      this page. `CONNECTOR_CREDENTIALS` asks "is the variable set?". Add an
      entitlement probe that asks the vendor: one cheap authenticated call per
      credentialed source at startup, classified `entitled` / `refused` /
      `unreachable`, surfaced in `/api/health` `sourceErrors` and in the
      doctor. Tradier already has exactly this shape in `probeTradierToken()`
      (prod → sandbox → rejected) — **generalise that pattern** rather than
      inventing a second one. A `403 NOT_AUTHORIZED` must never again read as
      `[ok] ... and credentialed`.
- [x] **1.2 — A guard for it.** *Done — landed with 1.1 rather than after it,
      so the fix did not ship without a canary.* In the spirit of `deadSources.test.ts`: a
      source that answers `NOT_AUTHORIZED` is not a configured source. Assert
      the doctor's verdict degrades when a probe is refused.
- [ ] **1.3 — Open a funded Tradier account and set `TRADIER_TOKEN`.**
      **This is the one item on this page that costs money, and the amount is
      not established here.** What was verified: API access is free to every
      Tradier Brokerage account holder, real-time US stock and options data is
      included, and non-accountholders get no real-time solution at all. What
      was **not** verified: the account funding minimum, and what their
      market-data agreement says about non-professional subscriber status.
      Read both before funding — the plan leans on this item, so it should not
      be the sentence that reads as free.
      With that said: it is `PERMITTED` for DISPLAY **and** PERSIST in
      `PRIVATE_RESEARCH`, the connector is already written, and
      `probeTradierToken()` already distinguishes prod / sandbox / rejected.
      This is the single highest-leverage act in the whole document: it turns
      the terminal on. It may also retire Phase 0.4 — if Tradier can
      serve the grader's underlying marks too, Twelve Data leaves the
      persistence path and the `UNVERIFIED` warning goes with it.
- [x] **1.4 — Break `getSpotPrice`'s single-vendor coupling.** *Done 2026-09-15.*
      `MarkLookup` returns `{price, source, rightsClass}`, so a mark cannot be
      recorded without its provenance; `signal_outcomes` gains
      `entry_mark_source`/`exit_mark_source` with a CHECK binding the pairing.
      Ranking is derived from rights (PERMITTED > UNVERIFIED, PROHIBITED never),
      **not** from `.allowed` — that filter would have dropped Twelve Data and
      silently disabled the only working path. Check 4 now reports the registry
      rather than one variable name.
      **The registry is one entry long**, which is the honest state: Finnhub and
      Yahoo are PROHIBITED, Polygon's plan here is EOD-only, and Tradier has no
      token. So this buys auditability today and resilience only once 1.3 lands
      — Tradier would rank above Twelve Data automatically.

- [x] **1.5 — Decide what `refused` should mean to the operator.** *Done
      2026-09-15.* The `disabled` / `refused` / `error` distinction was already
      well made on the settings board. The real gap was one layer over: the
      backend's fourth channel, `sourceNotes` — the "connected but degraded"
      vocabulary — **had never been read by the browser at all**, so a source
      could be contributing with its NBBO lookups refused, or with the vendor
      refusing its key, and the page said `✓ LIVE` in green. Notes now render
      in their own line, and `connected` + a note reads `◐ DEGRADED`. No new
      backend field: a derived `disposition` would be a seventh channel
      answering what three already answer.

- [ ] **2.5 — Make the published rate say what it measured.** *Opened
      2026-09-17 by 2.4.* `entry_mark_at` / `exit_mark_at` now record the
      interval each outcome was actually measured over, and on this tier an
      `M15` row can span anywhere from fifteen minutes to an hour. Nothing
      reads those columns yet, so `/api/track-record` would publish an "M15
      hit rate" pooled across intervals of very different lengths — which is
      the category's characteristic lie, arrived at honestly. The fix is to
      report the measured interval per horizon beside the rate (median and
      spread, or a refusal above some multiple of the nominal horizon), in the
      same spirit as `labelRule: 'MAX_EXCURSION'` and the `eventTimeOnly`
      count: state what the number is, do not quietly widen what it covers.
      Deliberately not a tolerance constant picked in 2.4 — the right shape is
      disclosure, and it belongs in the route that publishes.

- [ ] **2.1** Watch `/api/track-record` climb toward n=30. Let it run. The
      floor exists so you don't fool yourself; respect it.
- [x] **2.2 — A collection heartbeat.** *Done 2026-09-15 — and it was not
      "surface it".* `collection_gaps` had a migration, a type, three CHECK
      constraints and two store implementations, and **nothing had ever called
      `recordGap`**. The table built to stop a flattering hit rate had recorded
      nothing. `persistence/coverage.ts` is the writer, on the grader's existing
      tick; `/api/health` carries the open gap. `MARKET_CLOSED` is never emitted
      — that needs a holiday calendar this repo does not have, and mislabelling
      an outage as a closure is the flattering direction. Also found: the two
      stores disagreed about `recordGap` (Postgres upserts, memory pushed), so
      an extending gap was one row in production and one per tick under test.
      ~~`collection_gaps` exists — surface it.~~
      "Collecting for 11 days · 3 gaps totalling 47 min · 22 of 30 graded."
      You need to *see* the clock running or you won't trust the number when
      it arrives.
- [x] **2.4 — Give a mark an as-of.** *Opened and closed 2026-09-17.* `Mark.asOf` carries the vendor's stamp; three refusals (exit before `dueAt`, exit not after entry, entry older than the shortest horizon) replace a silent division; `entry_mark_at`/`exit_mark_at` persist with a CHECK requiring the pair to be ordered. The defect was worse than this item described: not merely that staleness was unnoticed, but that **the grader never established the two prices were in order at all** — at M15 the exit mark could predate the decision, so the move was measured backwards. Same shape as the NBBO look-ahead in ledger note 22. Cost, stated carefully: M15 still grades for a REST-priced symbol — the first mark at or after `dueAt` arrives within a rotation and `maxLatenessMs` bounds it transitively — but the interval such a row is measured over can reach an hour, and about a fifth are refused for a stale entry. The horizon is the schedule; the stamps are the measurement. See 2.5. *The original description, which was accurate but incomplete rather than wrong:* `MarkLookup` is
      `(underlying) => {price, source, rightsClass}` and `markSources` supplies
      a bare cache read, so a mark taken from the 19-minute REST rotation is
      indistinguishable from one taken off the stream a second ago. The
      staleness is published to the operator on `/api/health` and is invisible
      to the grader. Same shape as 1.4 — a mark could not be recorded without
      its provenance, and can still be recorded without its age — and the fix
      is the same kind of change: an as-of on `Mark`, a column beside
      `entry_mark_source`, and a grader that refuses or labels a mark older
      than the horizon it grades. Deliberately not folded into the connector
      PR that found it.

- [x] **2.3 — Record the entitlement state on every persisted signal.**
      *Closed 2026-09-15 with no code, which is the honest answer.*
      `SignalRecord` already persists `source`, `datasetId`, `rightsClass` and
      `synthetic` per row — the question "which feed was live that day" is
      already answerable. The entitlement *verdict* is a moment-in-time fact
      about a vendor, not a property of a signal, and stapling a mutable probe
      result onto an append-only row would be the wrong shape.

### Phase 3 — Dealer positioning (week 3+, parallel with waiting)

The cheapest real capability gap. GEX is one number from a family, and you
already fetch the chain that produces all of them.

- [x] **3.1 — DEX per strike.** *Done 2026-09-15.* Cboe publishes per-contract
      delta, so dollar delta is as direct a computation as GEX. **Vanna and
      charm are refused, not deferred**: Cboe does not publish them, and
      deriving them means inverting Cboe's own delta to recover a pricing model
      this codebase does not have — importing every assumption silently. The
      payload says so. The sign trap is the interesting part: gamma is positive
      for both rights so `gex`'s split is an *imposed* convention, while delta
      carries its own — imposing a second flips the puts twice.

- [x] **3.2 — The gamma-flip level.** *Done 2026-09-15, by removing it.* The
      published value was the first per-strike sign change in a strike-sorted
      array: on a live AAPL chain with spot at 331.75 it returned **80**, a
      strike holding $1,420 of the chain's $1.45bn. A cumulative-sum crossing
      gives 100 — still 70% below spot — and the vendors' method is a third
      computation again. Three candidates, no established basis, so `null` with
      `flipUnavailable` saying why. Picking a replacement is a research step
      with a citation, not an edit.

- [x] **3.3 — State the assumption, on the payload.** *Done 2026-09-15.* Not a
      UI task done later: an `assumptions` block ships with every response and a
      guard asserts it. GEX is modelled, not observed — the call-positive /
      put-negative convention *is* the dealer assumption, and it is the one
      nobody states. Also removed `generateSyntheticGEX`, the last
      `Math.random()` in the tree: 31 strikes over a 2024 spot map, plus a 60s
      timer writing fresh random levels into the cache `getGEXLevels` reads as
      the last real chain.

- [x] **3.4 — A 0DTE lens.** *Done 2026-09-15.* Same aggregation restricted to
      the chain's own trading date, taken from the vendor's timestamp rather
      than this server's clock. `null` is the ordinary answer and that is
      deliberate: measured live, SPY carried 310 same-day contracts and SPX 484,
      while AAPL had none at all — showing the nearest expiry instead would
      relabel tomorrow as today for most of the market.


### Phase 4 — Replay and backtest (month 2) — the crown jewel

This is the feature that makes accumulated history worth more than the day it
was collected, and it is worthless before Phase 0.

- [ ] **4.1 — Scanner backtest.** Tradytics' pitch — "large call sweeps within
      15 minutes of a key level, here is how that performed across hundreds of
      past instances" — is, in your architecture, *a filter applied to
      `signal_history` joined to `signal_outcomes`*. The grader already
      computes the label. You are closer to this than to any other item here.
- [ ] **4.2 — Reuse the grader, do not write a second one.** Ledger line 74
      already records what happens when grading logic gets a second home:
      `outcomeDecision.test.ts` exists to hold two copies in agreement. Don't
      create a third.
- [ ] **4.3 — Carry every honesty flag into the backtest result.**
      `EVENT_TIME_ONLY` rows excluded, `AMBIGUOUS` counted not guessed,
      `MAX_EXCURSION` labelled as a best-moment measure and not a held return,
      `INSUFFICIENT_SAMPLE` below n=30. A backtester that drops these is a
      backtester that lies — which is the entire failure mode of the category.
- [x] **4.4 — Multi-leg structure recognition.** *Done 2026-09-16, narrowly.*
      The classifier existed and had one real defect: every call-and-put pair at
      one expiry was `STRADDLE_STRANGLE`, ignoring `leg.side`. A long call
      against a **short** put is a risk reversal — the opposite kind of position
      from a long strangle. `RISK_REVERSAL` separates them; an `AMBIGUOUS` leg
      yields `UNKNOWN` rather than a guess.
      **Not done, deliberately:** straddle-vs-strangle and diagonal are label
      refinements with no downstream reader, and butterflies/condors need
      >2-leg grouping that does not exist. Adding union members nothing consumes
      is cost without a reader.
      Checking the premise also found that ledger line 74 had misnamed its own
      fixture — both legs are bought, so it is a long strangle, not the "bullish
      risk reversal" it claimed. Corrected in all four places.


### Phase 5 — The daily surface (ongoing)

Only after there is something to show. Ordered by "will you open it every day":

- [ ] **5.1** Saved scanner presets — cheap, and it is how a terminal becomes
      a habit.
- [ ] **5.2** A morning view: overnight flow, today's GEX profile, gamma flip,
      the track record to date. One screen, opened once a day.
- [ ] **5.3** Alerting that names its own trigger. Ledger line 98 records the
      power-alerts page describing a trigger the code did not implement and
      crediting a model that did not exist. Whatever fires, the rule that
      fired it goes on the row.
- [ ] **5.4** IV rank / percentile / term structure — needs greeks in the
      chain, so it lands naturally after Phase 3.

---

## The one-page version

| When | Do | Because |
|---|---|---|
| **Today** | Rotate keys. Supabase. Twelve Data free key. Choose the awake-process answer. | Doctor flips to **yes** and the sample clock starts. Everything else is worth zero until it does. |
| **Week 1** | Fix the doctor's `credentialed ≠ entitled` blind spot. Fund a Tradier account (cost not verified — see 1.3). | Finding A means you currently have *no* options feed while being told you do. Tradier is the only PERSIST-legal real-time path. |
| **Weeks 2–4** | Wait, visibly. Surface the collection heartbeat. | n=30 is calendar time. Build Phase 3 while it runs. |
| **Week 3+** | DEX / vanna / charm / gamma-flip / 0DTE — and say on the chart that it's modelled. | Cheapest real gap vs. the field, and the honesty note is a differentiator none of them offer. |
| **Month 2** | Scanner backtest over your own graded history. | The one thing that compounds — and the one thing nobody else can sell you about *your* filters. |

### And the thing to keep

Every platform in Part 3 sells a hit rate. Not one of them publishes what
happens when the sample is too small, counts the trades whose direction was
unreadable instead of guessing, or says on the chart that its gamma number is
a model. You built all three before you had a single row of data.

**Get the data. The honesty is already done.**
