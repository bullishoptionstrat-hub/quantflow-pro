# SYNTHETIC bar fixtures — not market data

`SYNTHETIC_SPY_1m.csv` and `SYNTHETIC_QQQ_1m.csv` are seeded random walks written by
`backend/tools/fixtures/syntheticBars.ts` (seeds 1101 and 2202). The symbols are labels only.
Timestamps mark the bar OPEN, in UTC. About 2% of rows have no volume, to exercise `null`.
Regenerate with `npx tsx tools/fixtures/syntheticBars.ts`; never edit by hand.

`FLAWED_SPY_1m.csv` is hand-built to exercise the preflight: two hours of
2026-01-05 with 15 regular-session minutes removed, one duplicate row, one
out-of-order row, one timestamp without a zone, one bar whose high is below
its close, and one bar on a Saturday. `../barPreflight.json` is the preflight
route's answer for it beside the synthetic SPY file; `barPreflight.test.ts`
holds the recording to the current route.
