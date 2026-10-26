/**
 * A trade time that is not epoch milliseconds is refused at the seam, counted
 * per source, and named on /api/health; it is never published with a date it
 * does not have.
 *
 * The trade time was the one field of a print `ingestPrint` did not check.
 * Measured through the real adapter before the gate, one SPY print against a
 * November expiry: seconds published a trade dated 1970 with 20,757 days to
 * expiry; microseconds published it as 0DTE; nanoseconds and NaN threw out of
 * `ingestPrint`. A quote stamp of NaN was read as fresh, because every
 * comparison with NaN is false.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createIngestor, stampFault, MAX_STAMP_AHEAD_OF_RECEIPT_MS, type RawPrint } from '../src/ingestion/flowEngineAdapter';

const NOW = Date.UTC(2026, 9, 26, 15, 0, 0);

function print(over: Partial<RawPrint> = {}): RawPrint {
  return {
    source: 'tradier', symbol: 'SPY', expiry: '2026-11-20', right: 'C', strike: 580,
    price: 50, size: 2000, exchange: 'C', bid: 49.5, ask: 50, ts: NOW - 1_000, receivedAt: NOW,
    ...over,
  } as RawPrint;
}

function run(p: RawPrint) {
  const ing = createIngestor({ now: () => NOW });
  const signals: any[] = [];
  ing.onSignal((s: any) => signals.push(s));
  const events = [...ing.ingestPrint(p), ...ing.flush()];
  return { ing, events, signals };
}

test('a millisecond trade time is accepted unchanged (control)', () => {
  const { events, signals, ing } = run(print());
  assert.equal(events.length, 1);
  assert.equal(signals[0].ts, NOW - 1_000);
  assert.deepEqual(ing.unreadableTradeTimeCounts(), {});
});

for (const [label, ts] of [
  ['seconds', Math.floor((NOW - 1_000) / 1_000)],
  ['microseconds', (NOW - 1_000) * 1_000],
  ['nanoseconds', (NOW - 1_000) * 1_000_000],
  ['NaN', Number.NaN],
  ['Infinity', Number.POSITIVE_INFINITY],
] as const) {
  test(`a trade time in ${label} is refused, not published and not thrown`, () => {
    const { events, signals, ing } = run(print({ ts }));
    assert.equal(events.length, 0, 'nothing reaches the wire');
    assert.equal(signals.length, 0, 'and nothing reaches the recorder');
    const counts = ing.unreadableTradeTimeCounts();
    assert.equal(counts.tradier?.count, 1, 'the refusal is counted against its source');
  });
}

test('a trade stamped beyond clock skew after its own receipt is refused', () => {
  const ahead = run(print({ ts: NOW + MAX_STAMP_AHEAD_OF_RECEIPT_MS + 1 }));
  assert.equal(ahead.events.length, 0);
  assert.match(ahead.ing.unreadableTradeTimeCounts().tradier.sample, /after the print was received/);
  // Within skew is a clock that is slightly off, not a wrong unit.
  assert.equal(run(print({ ts: NOW + MAX_STAMP_AHEAD_OF_RECEIPT_MS - 1 })).events.length, 1);
});

test('an old trade is not refused: staleness is the engine\'s question, not this gate\'s', () => {
  assert.equal(run(print({ ts: NOW - 6 * 3_600_000 })).events.length, 1);
});

test('replay has no receipt to bound by, but its units are still checked', () => {
  const ok = run(print({ ts: NOW + 86_400_000, receivedAt: undefined, replay: true } as any));
  assert.equal(ok.events.length, 1, 'a historical tape is not refused for being "in the future"');
  const bad = run(print({ ts: Math.floor(NOW / 1_000), receivedAt: undefined, replay: true } as any));
  assert.equal(bad.events.length, 0, 'but seconds are still not milliseconds');
});

test('a print with no trade time still means "now", as before', () => {
  const { events } = run(print({ ts: undefined }));
  assert.equal(events.length, 1);
});

test('an unreadable quote stamp withholds the quote, so the side is AMBIGUOUS', () => {
  const fresh = run(print({ quoteTs: NOW - 1_000 }));
  assert.notEqual(fresh.events[0].side, 'AMBIGUOUS', 'control: a readable quote infers a side');
  for (const quoteTs of [Number.NaN, Math.floor(NOW / 1_000), NOW * 1_000]) {
    const r = run(print({ quoteTs }));
    assert.equal(r.events.length, 1, 'the print itself is kept');
    assert.equal(r.events[0].side, 'AMBIGUOUS', `quoteTs ${quoteTs} is not trusted`);
  }
});

test('stampFault names each fault', () => {
  assert.equal(stampFault(NOW, NOW), null);
  assert.match(stampFault(Number.NaN, NOW)!, /not a number/);
  assert.match(stampFault(NOW / 1_000, NOW)!, /not epoch milliseconds/);
  assert.match(stampFault(NOW + 3_600_000, NOW)!, /after the print was received/);
  assert.equal(stampFault(NOW + 3_600_000, undefined), null);
});

test('the refusals reach /api/health through sourceNotes', () => {
  const src = readFileSync(join(__dirname, '..', 'src', 'ingestion', 'index.ts'), 'utf8');
  assert.match(src, /unreadableTradeTimeCounts\(\)/, 'index.ts reads the counter');
  assert.match(src, /print\(s\) refused: trade time/, 'and writes it as a note');
});
