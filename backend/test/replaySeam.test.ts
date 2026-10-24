/**
 * §I's staleness re-runs, formed through the production seam in pipelines
 * that cannot reach the live one.
 *
 * The tape is built so the bound decides an answer: three trades on one
 * contract, each lifted at the offer of a quote stamped 0.5 s, 3 s and 1.5 s
 * before it. At 1 s only the first has a side; at the engine's 2 s the first
 * and third; at 5 s all three. A re-run that applied its bound in one place
 * and not the other (S3) would collapse two of these rows into one.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildQuoteEvent, buildTradeEvent } from '../src/events/build';
import type { RawQuoteRecord, RawTradeRecord } from '../src/events/build';
import type { QuoteEvent, TradeReportEvent } from '../src/events/types';
import { EventLog } from '../src/events/eventLog';
import { ReorderBuffer } from '../src/events/reorder';
import type { Emission } from '../src/events/reorder';
import { detectorAdmission, toRawPrint } from '../src/events/detector';
import { causalQuoteFor } from '../src/events/causalQuote';
import {
  ingestPrint, drainIdle, resetDaily, onSignal, __clearSignalObservers, type WireFlowEvent,
} from '../src/ingestion/flowEngineAdapter';
import { replayThroughSeam, h001StalenessReplays, H001_STALENESS_BOUNDS_MS } from '../src/research/replaySeam';

const T0 = Date.parse('2026-03-10T15:00:00.000Z');
const SPY = { underlying: 'SPY', expiry: '2026-04-17', strike: 560, right: 'C' as const };
const QUOTE_AGE = [500, 3_000, 1_500];

function tradeRec(i: number): RawTradeRecord {
  const eventTime = T0 + i * 60_000;
  return {
    provider: 'fixture', datasetId: 'FIXTURE.OPRA', sequenceScope: 'line-1:2026-03-10',
    providerSequence: String(100 + i), eventTime, providerReceiveTime: eventTime + 3,
    instrument: SPY, venue: 'C', rawSessionIdentifier: 0, rawRecordRef: `raw#t${i}`,
    synthetic: true, replay: true, price: 2.2, size: 150,
  };
}
function quoteRec(i: number): RawQuoteRecord {
  const eventTime = T0 + i * 60_000 - QUOTE_AGE[i]!;
  return {
    provider: 'fixture', datasetId: 'FIXTURE.OPRA', sequenceScope: 'quotes-1:2026-03-10',
    providerSequence: String(500 + i), eventTime, providerReceiveTime: eventTime + 2, instrument: SPY, venue: 'C',
    rawSessionIdentifier: 0, rawRecordRef: `raw#q${i}`, synthetic: true, replay: true,
    bid: 2.1, ask: 2.2, bidSize: 10, askSize: 10,
  };
}

function tape(): { emissions: Emission[]; quotes: QuoteEvent[]; trades: TradeReportEvent[] } {
  const events = [0, 1, 2].flatMap((i) => [buildQuoteEvent(quoteRec(i)), buildTradeEvent(tradeRec(i))]);
  const log = new EventLog();
  const buf = new ReorderBuffer({ allowedLatenessMs: 1_000 });
  const emissions: Emission[] = [];
  for (const e of events.sort((a, b) => a.availableAt - b.availableAt)) {
    log.append(e);
    emissions.push(...buf.push(e));
  }
  emissions.push(...buf.flush());
  return { emissions, quotes: [...log.finalCorrected().quotes], trades: events.filter((e) => e.kind === 'TRADE_REPORT') as TradeReportEvent[] };
}

const NOW = () => T0 + 3_600_000;
const sidesOf = (r: ReturnType<typeof replayThroughSeam>) =>
  r.signals.map((s) => s.signal.side);

test('each bound decides which quotes may decide a side, in selection and in the engine alike', () => {
  const { emissions, quotes } = tape();
  const { primary, reruns } = h001StalenessReplays(emissions, quotes, NOW);
  assert.deepEqual(sidesOf(reruns[1000]), ['BUY', 'AMBIGUOUS', 'AMBIGUOUS']);
  assert.deepEqual(sidesOf(primary), ['BUY', 'AMBIGUOUS', 'BUY']);
  assert.deepEqual(sidesOf(reruns[5000]), ['BUY', 'BUY', 'BUY']);
  assert.equal(primary.boundMs, 2_000);
  assert.deepEqual(reruns[1000].quoteStatus, { FOUND: 1, STALE: 2 });
  assert.deepEqual(reruns[5000].quoteStatus, { FOUND: 3 });
});

test('the bound reaches the engine, not only the quote selection (S3)', () => {
  // Selection at 5 s attaches the 3 s quote. An engine left at its 2 s
  // default would then refuse it, and the 5 s re-run would equal the primary.
  const { emissions, quotes } = tape();
  const r = replayThroughSeam(emissions, quotes, { boundMs: 5_000, now: NOW });
  assert.equal(r.signals[1]!.signal.side, 'BUY');
});

test('§I declares exactly two bounds', () => {
  assert.deepEqual([...H001_STALENESS_BOUNDS_MS], [1_000, 5_000]);
  const { emissions, quotes } = tape();
  assert.throws(() => replayThroughSeam(emissions, quotes, { boundMs: 0, now: NOW }), RangeError);
});

test('a replay never reaches the live pipeline: no observer call, no quote in the live book', () => {
  resetDaily();
  __clearSignalObservers();
  const seen: string[] = [];
  onSignal((s) => seen.push(s.id));
  try {
    const { emissions, quotes } = tape();
    h001StalenessReplays(emissions, quotes, NOW);
    assert.deepEqual(seen, [], 'the recorder would have been offered every replayed signal');
    // The same contract, live, with no quote: the live book holds none of the replay's.
    const live = [...ingestPrint({
      ts: T0 + 10 * 60_000, symbol: 'SPY', expiry: SPY.expiry, strike: SPY.strike, right: 'C',
      price: 2.2, size: 150, source: 'fixture', synthetic: true, replay: true,
    }), ...drainIdle(0)];
    assert.equal(live[0]!.side, 'AMBIGUOUS');
  } finally {
    __clearSignalObservers();
  }
});

test('at the engine\'s own bound the replay is the live seam\'s answer, print for print', () => {
  // Parity (§22): the isolated pipeline must not be a cleaner path. The same
  // loop through the live functions gives the same signals.
  const { emissions, quotes } = tape();
  resetDaily();
  const live: WireFlowEvent[] = [];
  for (const em of emissions) {
    const a = detectorAdmission(em);
    if (a.admit) live.push(...ingestPrint(toRawPrint(a.event, causalQuoteFor(a.event, quotes))));
  }
  live.push(...drainIdle(0));
  const iso = replayThroughSeam(emissions, quotes, { boundMs: 2_000, now: NOW }).wire;
  // `id` carries the engine's per-instance sequence, which the live engine has advanced.
  const strip = (w: typeof live) => w.map(({ id: _id, ...rest }) => rest);
  assert.deepEqual(strip(iso), strip(live));
});

test('a replay is deterministic: same tape, same clock, same bytes', () => {
  const { emissions, quotes } = tape();
  const a = replayThroughSeam(emissions, quotes, { boundMs: 1_000, now: NOW });
  const b = replayThroughSeam(emissions, quotes, { boundMs: 1_000, now: NOW });
  assert.deepEqual(a, b);
  assert.ok(a.signals.every((s) => s.signal.emittedAt === NOW()), 'stamped by the replay\'s clock, not the wall clock');
});
