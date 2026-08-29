# KNOWN_LIMITATIONS.md

Honest limitations. Every entry is something the product **cannot** currently do, or can only
do with a caveat a user must see. Never let UI copy contradict this file.

## Data honesty

1. **There is no dark-pool print feed.** The "Dark Pool Prints" page is generated data. No FINRA
   integration exists anywhere in the repo, despite `README.md:31` claiming one. Additionally,
   FINRA ATS data is **weekly aggregated volume**, not intraday prints — even a correct future
   integration must never be called "prints" or "realtime". (`docs/FORENSIC_AUDIT.md` #2)
2. **GEX is synthetic.** Every gamma level, gamma flip and "key level" is invented. Real GEX
   requires an option chain with open interest and gamma per strike. (#3)
3. **"SWEEP" does not mean a sweep.** Classification collapses to `size > 200` because callers
   pass fabricated exchange lists. A genuine multi-exchange sweep cannot currently be detected. (#9)
4. **Sentiment is a coin-flip proxy.** Most connectors set `sentiment = call ? bullish : bearish`
   with no aggressor-side inference.
5. **Yahoo connector is very likely non-functional.** Yahoo requires crumb + cookie on `v7`
   endpoints; the connector sends only a User-Agent. It also re-publishes daily cumulative
   contract volume every 3 minutes as if each were a new trade, inflating premium totals.
6. **Heat score inputs are partly imputed** (`avgVolume = size*10`, `openInterest = size*50`),
   so its size/OI term is effectively constant. It is not purely a market-derived signal. (#11)
7. **No option-level P&L is available for free.** Outcome grading can only use *underlying*
   returns. Any claim of option P&L would be fabricated. (Wave 7)

## Model honesty

8. **The shipped ML model is meaningless.** It trains on rng-generated data whose labels are
   drawn *before* the features, from disjoint ranges — AUC 1.0000 is guaranteed by construction,
   not learned. It also has train/serve feature skew. Do not present its score as information. (#4)

## Timing / correctness

9. **Event timestamps are insertion times**, not exchange times, for every source except Polygon.
   Latency is invisible and replay is impossible until Event Model V2 lands. (#10)
10. **No market-holiday calendar.** `isMarketOpen()` reports OPEN on July 4th.
11. **Nothing is persisted.** All state is in-memory and lost on restart; Render's free tier
    restarts on deploy and spins down after 15 min idle. (#12)

## Security

12. **Every backend route is unauthenticated.** The login wall is decorative. (#5)
13. **Real credentials exist in committed zip archives and in git history.** They must be
    rotated by a human; deleting the files does not undo the exposure. (#7)

## Access control (verified against a real Postgres, Wave 9)

16. **`flow_archive` and `price_history` are readable by UNAUTHENTICATED users** by existing
    policy (`USING (true)`). Verified: an anon request with `auth.uid()` null read 7 archived flow
    rows. Per-user data is correctly isolated (a user cannot read, delete or insert into another
    user's `watchlist` or `api_keys` — all six checks pass in `scripts/verify-rls.sh`), but the
    flow archive itself is public. If flow data is meant to sit behind the login wall, that policy
    contradicts it. Left unchanged because narrowing it is a product decision, not a bug fix.
17. **`api_keys.key_value` is stored in plaintext** (schema comment says "should be encrypted in
    production"). RLS prevents cross-user reads, but anyone with service-role access or a database
    dump reads every user's provider keys.

## Environmental (this session only, not product defects)

14. No network access to any market-data provider and no API keys, so no connector can be
    runtime-verified here. Waves 4-7 are validated against deterministic fixtures only.
15. Cannot push to GitHub (read-only App install); work is delivered as git bundles.

## OCC cleared volume: delay is declared, not measured

`backend/src/ingestion/connectors/occ.ts` reports `is_delayed: true` with
`estimated_delay_seconds: 86400` (one calendar day). That number is a
**conservative floor, not a measurement.**

OCC publishes *cleared* volume on a next-business-day cycle, so over a weekend
or a holiday the true lag is closer to 72 hours. The payload this connector
parses carries no effective/trade date that we read, so actual staleness cannot
be computed. Guessing at a date field name to fix this would be the same class
of invention the connector was just cleaned of, so the constant is declared
honestly and the gap recorded here instead.

To close it: confirm against a real payload whether OCC returns an activity
date, and if so parse it and derive the delay from it. That requires egress to
`marketdata.theocc.com`, which this environment does not have.

Related: `docs/FORENSIC_AUDIT.md` #27. The same file's zero-sentinels are fixed;
this is the residue.

