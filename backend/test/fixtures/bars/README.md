# SYNTHETIC bar fixtures — not market data

`SYNTHETIC_SPY_1m.csv` and `SYNTHETIC_QQQ_1m.csv` are seeded random walks written by
`backend/tools/fixtures/syntheticBars.ts` (seeds 1101 and 2202). The symbols are labels only.
Timestamps mark the bar OPEN, in UTC. About 2% of rows have no volume, to exercise `null`.
Regenerate with `npx tsx tools/fixtures/syntheticBars.ts`; never edit by hand.
