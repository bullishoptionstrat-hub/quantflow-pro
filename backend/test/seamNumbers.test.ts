/**
 * The adapter seam refuses a number that is not a price, and withholds a quote
 * that is not a book. Every source converges on `ingestPrint`, so this is the
 * one place the rule has to hold for all of them.
 *
 * Measured before the change, one print through the real adapter:
 *   ask: Infinity -> side SELL_LEAN, sentiment BEARISH (an infinite midpoint)
 *   price: Infinity -> published, total_premium Infinity (null on the wire)
 * A negative bid was already AMBIGUOUS before it, because the engine's book
 * drops one; that case is kept so the seam cannot start relying on it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIngestor, type RawPrint } from '../src/ingestion/flowEngineAdapter';

const NOW = Date.UTC(2026, 9, 26, 15, 0, 0);

function run(over: Partial<RawPrint>) {
  const p = {
    source: 'tradier', symbol: 'SPY', expiry: '2026-11-20', right: 'C', strike: 580,
    price: 50, size: 2000, exchange: 'C', bid: 49.5, ask: 50, ts: NOW - 1_000, receivedAt: NOW,
    ...over,
  } as RawPrint;
  const ing = createIngestor({ now: () => NOW });
  return [...ing.ingestPrint(p), ...ing.flush()] as any[];
}

test('control: a print at the ask is a buy', () => {
  const ev = run({});
  assert.equal(ev.length, 1);
  assert.equal(ev[0].side, 'BUY');
});

for (const field of ['price', 'size', 'strike'] as const) {
  for (const v of [Infinity, NaN]) {
    test(`a print with ${field} ${v} is refused`, () => {
      assert.equal(run({ [field]: v }).length, 0);
    });
  }
}

for (const [label, over] of [
  ['an infinite ask', { ask: Infinity }],
  ['a NaN bid', { bid: NaN }],
  ['a negative bid', { bid: -1 }],
  ['an infinite negative bid', { bid: -Infinity }],
] as const) {
  test(`${label} is not a quote, so the side is AMBIGUOUS`, () => {
    const ev = run(over as Partial<RawPrint>);
    assert.equal(ev.length, 1, 'the print itself is still real');
    assert.equal(ev[0].side, 'AMBIGUOUS');
  });
}

test('a zero bid is still a quote: a real zero bid is a market state', () => {
  const ev = run({ bid: 0, ask: 0.05, price: 0.05 });
  assert.equal(ev.length, 1);
  assert.notEqual(ev[0].side, 'AMBIGUOUS');
});
