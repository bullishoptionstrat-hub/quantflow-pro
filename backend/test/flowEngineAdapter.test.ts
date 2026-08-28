/**
 * Adapter mapping tests — the seam between the connectors and the flow engine.
 *
 * The engine's own behaviour is covered by quantflow-modules/flow-engine's
 * suite. What is tested here is only what the adapter adds: OCC symbol
 * construction, NBBO being published before the trade, the signal → wire
 * mapping, and the idle drain.
 *
 * Run: npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ingestPrint, drainIdle, resetDaily, occSymbol, sentimentOf,
  type RawPrint,
} from '../src/ingestion/flowEngineAdapter';

const T0 = Date.parse('2026-06-15T14:30:00Z');

function print(over: Partial<RawPrint> = {}): RawPrint {
  return {
    ts: T0,
    symbol: 'TEST',
    expiry: '2026-06-19',
    strike: 550,
    right: 'C',
    price: 5,
    size: 400,
    exchange: 'CBOE',
    bid: 4.9,
    ask: 5,
    openInterest: 100,
    underlyingPrice: 545,
    source: 'unit-test',
    ...over,
  };
}

/** Feed a print, then drain so the burst finalizes regardless of timing. */
function ingestAndDrain(p: RawPrint) {
  const direct = ingestPrint(p);
  return [...direct, ...drainIdle(0)];
}

test('occSymbol builds an OCC-style contract symbol', () => {
  assert.equal(occSymbol('SPY', '2026-06-19', 'C', 550), 'SPY260619C00550000');
  assert.equal(occSymbol('NVDA', '2026-01-16', 'P', 142.5), 'NVDA260116P00142500');
});

test('sentiment is a function of side AND right, not right alone', () => {
  assert.equal(sentimentOf('BUY', 'C'), 'BULLISH');
  assert.equal(sentimentOf('BUY', 'P'), 'BEARISH');
  assert.equal(sentimentOf('SELL', 'P'), 'BULLISH');   // selling puts is bullish
  assert.equal(sentimentOf('SELL', 'C'), 'BEARISH');
  assert.equal(sentimentOf('BUY_LEAN', 'C'), 'BULLISH');
  assert.equal(sentimentOf('AMBIGUOUS', 'C'), 'NEUTRAL'); // never a direction
});

test('a fill at the ask infers BUY — the adapter publishes NBBO before the trade', () => {
  resetDaily();
  const [sig] = ingestAndDrain(print({ symbol: 'NBBO1', price: 5, bid: 4.9, ask: 5 }));
  assert.ok(sig, 'expected a signal');
  assert.equal(sig.side, 'BUY');
  assert.equal(sig.sentiment, 'BULLISH');
  assert.equal(sig.score_breakdown.ambiguousPenalty, 0);
});

test('a print with no quote stays AMBIGUOUS and takes the score penalty', () => {
  resetDaily();
  const [sig] = ingestAndDrain(
    print({ symbol: 'NOQUOTE', bid: undefined, ask: undefined }),
  );
  assert.ok(sig);
  assert.equal(sig.side, 'AMBIGUOUS');
  assert.equal(sig.sentiment, 'NEUTRAL');
  assert.equal(sig.score_breakdown.ambiguousPenalty, -15);
});

test('a multi-venue fill classifies as SWEEP and splits size across venues', () => {
  resetDaily();
  const [sig] = ingestAndDrain(print({
    symbol: 'SWEEPY', size: 300, exchanges: ['CBOE', 'PHLX', 'AMEX'],
  }));
  assert.ok(sig);
  assert.equal(sig.order_type, 'SWEEP');
  assert.equal(sig.exchange_count, 3);
  assert.equal(sig.total_size, 300, 'size is split across venues, not multiplied');
  assert.equal(sig.print_ids.length, 3, 'one print id per venue');
});

test('wire event carries the frontend contract plus the engine fields', () => {
  resetDaily();
  const [sig] = ingestAndDrain(print({ symbol: 'WIRE', synthetic: true }));
  assert.ok(sig);
  for (const key of [
    'id', 'underlying', 'expiry', 'strike', 'option_type', 'order_type',
    'total_size', 'total_premium', 'heat_score', 'sentiment', 'is_unusual',
    'exchange_count', 'avg_price', 'days_to_expiry', 'moneyness',
    'created_at', 'source',
  ]) {
    assert.ok(key in sig, `wire event missing ${key}`);
  }
  assert.equal(sig.underlying, 'WIRE');
  assert.equal(sig.total_premium, 5 * 400 * 100);
  assert.equal(sig.source, 'unit-test');
  assert.equal(sig.synthetic, true, 'synthetic must propagate to the wire');
  assert.equal(sig.is_unusual, sig.heat_score >= 75);
});

test('moneyness and DTE are derived from spot and expiry', () => {
  resetDaily();
  const [itm] = ingestAndDrain(print({ symbol: 'MNY1', strike: 500, underlyingPrice: 550 }));
  assert.equal(itm!.moneyness, 'ITM');   // call, spot above strike
  const [atm] = ingestAndDrain(print({ symbol: 'MNY2', strike: 550, underlyingPrice: 550 }));
  assert.equal(atm!.moneyness, 'ATM');
  const [otm] = ingestAndDrain(print({ symbol: 'MNY3', strike: 600, underlyingPrice: 550 }));
  assert.equal(otm!.moneyness, 'OTM');
  assert.equal(otm!.days_to_expiry, 4);  // 2026-06-15 → 2026-06-19
});

test('a two-leg structure emits one event carrying both legs', () => {
  resetDaily();
  ingestPrint(print({ symbol: 'SPREAD', strike: 550, price: 5 }));
  const sigs = [
    ...ingestPrint(print({ symbol: 'SPREAD', strike: 560, price: 2, ts: T0 + 5 })),
    ...drainIdle(0),
  ];
  const multi = sigs.find((s) => s.order_type === 'MULTI_LEG');
  assert.ok(multi, 'expected a MULTI_LEG signal');
  assert.equal(multi.legs?.length, 2);
  assert.equal(multi.spread_guess, 'VERTICAL');
  assert.equal(multi.strike, 550, 'the event itself is the dominant leg');
});

test('prints below the minimum premium emit nothing', () => {
  resetDaily();
  const sigs = ingestAndDrain(print({ symbol: 'TINY', price: 0.05, size: 10 }));
  assert.equal(sigs.length, 0);
});

test('malformed prints are dropped, not thrown on', () => {
  resetDaily();
  assert.deepEqual(ingestPrint(print({ symbol: '', price: 5 })), []);
  assert.deepEqual(ingestPrint(print({ symbol: 'BAD', price: 0 })), []);
  assert.deepEqual(ingestPrint(print({ symbol: 'BAD', size: 0 })), []);
});

test('the daily reset does not strip provenance from an in-flight burst', () => {
  resetDaily();
  // Print lands, burst is still open, then the session boundary fires.
  ingestPrint(print({ symbol: 'STRADDLE_RESET', synthetic: true }));
  resetDaily();
  const [sig] = drainIdle(0);
  assert.ok(sig, 'expected the in-flight burst to still finalize');
  assert.equal(sig.synthetic, true, 'synthetic must survive the reset');
  assert.equal(sig.source, 'unit-test', 'source must survive the reset');
});
