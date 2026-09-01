/**
 * The vendored engine must not read a trade's side off a later quote.
 *
 * `inferSide` gated staleness with `tradeTs - nbbo.ts > maxAgeMs`. That is a
 * subtraction, so a quote stamped AFTER the trade produces a negative age and
 * passes the check — the engine would infer direction from an NBBO that may
 * already reflect the very print being classified.
 *
 * Nothing exercised it: every source publishes the NBBO carrying its own
 * trade's timestamp (`flowEngineAdapter.ts` calls `engine.onQuote({ ts, ... })`
 * with the trade's `ts`), so the difference was always exactly zero. Any
 * independent quote feed changes that — which is precisely what wiring a
 * Polygon NBBO source does.
 *
 * It is the same class of error as measuring an outcome from the first print
 * instead of `decisionAt`: information that did not exist at decision time,
 * handed to the decision for free, and every result comes out flattering.
 *
 * The canonical copy of these tests lives in
 * `quantflow-modules/flow-engine/test/engine.test.ts`. They are here too
 * because `backend/src/flow-engine` is what actually ships, and `npm run
 * verify` is what gates it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NbboBook } from '../src/flow-engine/nbbo';

const SYM = 'SPY260918C00500000';
const T0 = 1_780_000_000_000;

test('a quote from after the trade gives no side', () => {
  const book = new NbboBook();
  book.onQuote({ ts: T0 + 1, contractSymbol: SYM, bid: 1.0, ask: 1.1 });
  assert.equal(
    book.inferSide(SYM, 1.1, T0, 2_000), 'AMBIGUOUS',
    'a trade at the ask must not read BUY off a quote that had not happened',
  );
  assert.equal(book.inferSide(SYM, 1.0, T0, 2_000), 'AMBIGUOUS');
});

test('a wider age window is not a licence to look forward', () => {
  const book = new NbboBook();
  book.onQuote({ ts: T0 + 60_000, contractSymbol: SYM, bid: 1.0, ask: 1.1 });
  assert.equal(book.inferSide(SYM, 1.1, T0, 3_600_000), 'AMBIGUOUS');
});

test('the same-timestamp case still works, because it is the normal one', () => {
  // Every existing source publishes the quote stamped with its trade's ts.
  // If the fix broke this, side inference would stop working everywhere.
  const book = new NbboBook();
  book.onQuote({ ts: T0, contractSymbol: SYM, bid: 1.0, ask: 1.1 });
  assert.equal(book.inferSide(SYM, 1.1, T0, 2_000), 'BUY');
  assert.equal(book.inferSide(SYM, 1.0, T0, 2_000), 'SELL');
  assert.equal(book.inferSide(SYM, 1.06, T0, 2_000), 'BUY_LEAN');
});

test('an earlier quote still ages out on the configured window', () => {
  const book = new NbboBook();
  book.onQuote({ ts: T0 - 5_000, contractSymbol: SYM, bid: 1.0, ask: 1.1 });
  assert.equal(book.inferSide(SYM, 1.1, T0, 2_000), 'AMBIGUOUS', '5s old vs a 2s window');
  assert.equal(book.inferSide(SYM, 1.1, T0, 10_000), 'BUY', 'inside a wider window');
});
