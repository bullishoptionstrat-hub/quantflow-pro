# Importing 1-minute bars

`backend/src/market/barImport.ts` turns a CSV the trader supplied into validated closed
`Bar`s (`backend/src/market/bar.ts`). It is the $0 path to bars while the live bar feed is
blocked. Nothing is persisted and nothing is fetched.

## Format

- A header row, then one row per 1-minute bar.
- Required columns (any order): `timestamp,open,high,low,close`. Optional: `volume`.
  Any other column refuses the file.
- `timestamp` is epoch milliseconds (13 digits) or ISO-8601 **with a zone** (`Z` or `±hh:mm`).
  A naive local time such as `2026-03-02 09:31` is rejected; it is never assumed to be New York.
- The caller states `timestampMarks: 'OPEN' | 'CLOSE'` — whether the stamp is the start or the
  end of the minute. There is no default.
- The caller names `source`; there is no default.

## What is refused

Each rejected row is reported by its 1-based line number with its reasons, and is never repaired:
prices that are not decimals or do not form a bar (high below max(open, close), low above
min(open, close), non-positive), a timestamp off a minute boundary, a duplicate minute, a row
earlier than the one before it, and a row with the wrong number of cells.

## What is returned

`{ status: 'OK', provenance: 'USER_IMPORT', contentId, symbol, tf: '1m', timestampMarks,
coverage, gaps, rejected, bars }`. `contentId` is the sha256 of the file's bytes. A missing
volume is `null`, not 0. A gap between consecutive accepted minutes is listed with the number of
missing minutes and is never filled — overnight and weekend gaps are listed like any other.

## Fixtures

`backend/test/fixtures/bars/SYNTHETIC_*.csv` are seeded random walks written by
`backend/tools/fixtures/syntheticBars.ts`. They are not market data; `barImport.test.ts` fails if
they differ from the generator's output.
