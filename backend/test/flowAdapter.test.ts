/**
 * WAVE 4 — golden fixtures, fully deterministic (no random data anywhere).
 *
 * Drives the REAL `flow-engine` (not a reimplementation) through the backend
 * adapter and asserts exact classifications.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FlowEngine, NbboBook, DEFAULT_CONFIG } from 'flow-engine';
import type { ClassifiedSignal, OptionContract, OptionTradeEvent, OptionQuoteEvent } from 'flow-engine';

import {
  confidenceForSide,
  gradeForSide,
  mapKind,
  sentimentFor,
  signalToFlowEvent,
} from '../src/flow/adapter';
import { badgeFor, validateProvenance } from '../src/config/provenance';

const T0 = 1_700_000_000_000;

/**
 * NOTE: the NBBO book is keyed by `OptionContract.symbol`, and quotes carry the
 * same value as `OptionQuoteEvent.contractSymbol`. Getting this wrong silently
 * yields AMBIGUOUS for everything — these fixtures are deliberately built
 * WITHOUT `as` casts so TypeScript catches that class of mistake.
 */
const CONTRACT: OptionContract = {
  symbol: 'SPY260918C00580000',
  underlying: 'SPY',
  right: 'C',
  strike: 580,
  expiry: '2026-09-18',
};

function trade(over: Partial<OptionTradeEvent> = {}): OptionTradeEvent {
  return {
    id: 'p1',
    ts: T0,
    contract: CONTRACT,
    price: 5.0,
    size: 200,
    exchange: 'CBOE',
    conditions: [],
    ...over,
  };
}

function quote(over: Partial<OptionQuoteEvent> = {}): OptionQuoteEvent {
  return {
    ts: T0,
    contractSymbol: CONTRACT.symbol,
    bid: 4.9,
    ask: 5.1,
    ...over,
  };
}

describe('EXIT — aggressor inference never fabricates a side without NBBO', () => {
  it('returns AMBIGUOUS when no quote has ever been seen', () => {
    const book = new NbboBook();
    assert.equal(book.inferSide(CONTRACT.symbol, 5.0, T0, 2_000), 'AMBIGUOUS');
  });

  it('returns AMBIGUOUS when the NBBO is stale', () => {
    const book = new NbboBook();
    book.onQuote(quote({ ts: T0 }));
    // 3s later with a 2s staleness budget
    assert.equal(book.inferSide(CONTRACT.symbol, 5.0, T0 + 3_000, 2_000), 'AMBIGUOUS');
  });

  it('returns AMBIGUOUS exactly at mid — a coin flip is not information', () => {
    const book = new NbboBook();
    book.onQuote(quote({ bid: 4.9, ask: 5.1 }));
    assert.equal(book.inferSide(CONTRACT.symbol, 5.0, T0, 2_000), 'AMBIGUOUS');
  });

  it('ignores crossed/garbage quotes rather than inferring from them', () => {
    const book = new NbboBook();
    book.onQuote(quote({ bid: 6.0, ask: 5.0 })); // crossed
    assert.equal(book.inferSide(CONTRACT.symbol, 5.5, T0, 2_000), 'AMBIGUOUS');
  });

  it('BUY at/through the ask, SELL at/through the bid', () => {
    const book = new NbboBook();
    book.onQuote(quote({ bid: 4.9, ask: 5.1 }));
    assert.equal(book.inferSide(CONTRACT.symbol, 5.1, T0, 2_000), 'BUY');
    assert.equal(book.inferSide(CONTRACT.symbol, 5.5, T0, 2_000), 'BUY');
    assert.equal(book.inferSide(CONTRACT.symbol, 4.9, T0, 2_000), 'SELL');
    assert.equal(book.inferSide(CONTRACT.symbol, 4.0, T0, 2_000), 'SELL');
  });

  it('LEAN inside the spread, graded weaker than at-the-touch', () => {
    const book = new NbboBook();
    book.onQuote(quote({ bid: 4.9, ask: 5.1 }));
    assert.equal(book.inferSide(CONTRACT.symbol, 5.05, T0, 2_000), 'BUY_LEAN');
    assert.equal(book.inferSide(CONTRACT.symbol, 4.95, T0, 2_000), 'SELL_LEAN');
  });
});

describe('grade + confidence mapping', () => {
  it('never grades anything OBSERVED — this pipeline has no aggressor flag', () => {
    for (const side of ['BUY', 'SELL', 'BUY_LEAN', 'SELL_LEAN', 'AMBIGUOUS'] as const) {
      assert.notEqual(gradeForSide(side), 'OBSERVED');
    }
  });

  it('maps sides to the documented grades', () => {
    assert.equal(gradeForSide('BUY'), 'STRONG_INFERENCE');
    assert.equal(gradeForSide('SELL'), 'STRONG_INFERENCE');
    assert.equal(gradeForSide('BUY_LEAN'), 'WEAK_INFERENCE');
    assert.equal(gradeForSide('SELL_LEAN'), 'WEAK_INFERENCE');
    assert.equal(gradeForSide('AMBIGUOUS'), 'UNKNOWN');
  });

  it('confidence is strictly ordered and never 1.0', () => {
    assert.ok(confidenceForSide('BUY') > confidenceForSide('BUY_LEAN'));
    assert.ok(confidenceForSide('BUY_LEAN') > confidenceForSide('AMBIGUOUS'));
    assert.ok(confidenceForSide('BUY') < 1);
  });
});

describe('sentiment comes from the inferred side, not from call/put', () => {
  it('buying a call is bullish; SELLING a call is bearish', () => {
    // The old pipeline called both "bullish" purely because it was a call.
    assert.equal(sentimentFor('BUY', 'C'), 'bullish');
    assert.equal(sentimentFor('SELL', 'C'), 'bearish');
  });

  it('buying a put is bearish; selling a put is bullish', () => {
    assert.equal(sentimentFor('BUY', 'P'), 'bearish');
    assert.equal(sentimentFor('SELL', 'P'), 'bullish');
  });

  it('an unknown side yields neutral, never a guess', () => {
    assert.equal(sentimentFor('AMBIGUOUS', 'C'), 'neutral');
    assert.equal(sentimentFor('AMBIGUOUS', 'P'), 'neutral');
  });
});

describe('kind mapping is explicit and lossless in intent', () => {
  it('preserves the original kind when narrowing', () => {
    assert.deepEqual(mapKind('MULTI_LEG'), { type: 'SPLIT', originalKind: 'MULTI_LEG' });
    assert.deepEqual(mapKind('LARGE'), { type: 'BLOCK', originalKind: 'LARGE' });
    assert.deepEqual(mapKind('SWEEP'), { type: 'SWEEP', originalKind: 'SWEEP' });
  });
});

describe('GOLDEN FIXTURE — multi-exchange sweep through the real engine', () => {
  /**
   * Four prints on the SAME contract, SAME side, across THREE exchanges inside
   * the 100ms sweep window. This is what a sweep actually is — and note it is
   * detected from real exchange diversity, not from `size > 200` (audit #9).
   */
  function runSweepFixture(): ClassifiedSignal[] {
    const engine = new FlowEngine({ ...DEFAULT_CONFIG, syntheticSource: true });
    const out: ClassifiedSignal[] = [];

    engine.onQuote(quote({ ts: T0 - 10, bid: 4.9, ask: 5.1 }));
    out.push(...engine.onTrade(trade({ id: 'p1', ts: T0,      price: 5.15, size: 300, exchange: 'CBOE' })));
    out.push(...engine.onTrade(trade({ id: 'p2', ts: T0 + 10, price: 5.15, size: 250, exchange: 'PHLX' })));
    out.push(...engine.onTrade(trade({ id: 'p3', ts: T0 + 20, price: 5.15, size: 200, exchange: 'ISE'  })));
    out.push(...engine.onTrade(trade({ id: 'p4', ts: T0 + 30, price: 5.15, size: 150, exchange: 'CBOE' })));
    out.push(...engine.flush());
    return out;
  }

  it('produces the SAME result on every run (deterministic)', () => {
    const a = runSweepFixture();
    const b = runSweepFixture();
    assert.deepEqual(
      a.map((s) => [s.kind, s.side, s.totalSize, s.totalPremium, s.score]),
      b.map((s) => [s.kind, s.side, s.totalSize, s.totalPremium, s.score]),
      'fixture must be deterministic — no random data',
    );
  });

  it('classifies it as a SWEEP with the exact expected aggregates', () => {
    const [signal] = runSweepFixture();
    assert.ok(signal, 'expected one signal');
    assert.equal(signal.kind, 'SWEEP');
    assert.equal(signal.side, 'BUY');                    // 5.15 is through the 5.10 ask
    assert.equal(signal.totalSize, 900);                 // 300+250+200+150
    assert.equal(signal.totalPremium, 5.15 * 900 * 100); // exact, not approximate
    assert.deepEqual(signal.printIds.sort(), ['p1', 'p2', 'p3', 'p4']);
  });

  it('adapts to a FlowEvent whose provenance is valid and marked inferred', () => {
    const [signal] = runSweepFixture();
    const event = signalToFlowEvent(signal, { source: 'tradier', now: () => new Date(T0) });

    assert.equal(event.type, 'SWEEP');
    assert.equal(event.symbol, 'SPY');
    assert.equal(event.inferredSide, 'BUY');
    assert.equal(event.classificationGrade, 'STRONG_INFERENCE');
    assert.equal(event.sentiment, 'bullish');

    assert.deepEqual(validateProvenance(event.provenance), []);
    assert.equal(event.provenance?.is_inferred, true);
    assert.match(String(event.provenance?.inference_method), /^quote_rule:/);
    assert.equal(event.provenance?.confidence, 0.8);
  });
});

describe('GOLDEN FIXTURE — no NBBO available', () => {
  it('classifies without inventing a side, and says so in the provenance', () => {
    const engine = new FlowEngine({ ...DEFAULT_CONFIG, syntheticSource: true });
    const out: ClassifiedSignal[] = [];

    // Deliberately NO quote is fed.
    out.push(...engine.onTrade(trade({ id: 'q1', ts: T0, price: 5.0, size: 500, exchange: 'CBOE' })));
    out.push(...engine.flush());

    const [signal] = out;
    assert.ok(signal, 'a signal should still be emitted — size/premium are observable');
    assert.equal(signal.side, 'AMBIGUOUS', 'side must NOT be guessed without NBBO');

    const event = signalToFlowEvent(signal, { source: 'tradier', now: () => new Date(T0) });
    assert.equal(event.classificationGrade, 'UNKNOWN');
    assert.equal(event.sentiment, 'neutral');
    assert.equal(event.provenance?.confidence, 0);
    assert.equal(event.provenance?.inference_method, 'quote_rule:no_usable_nbbo');
    assert.deepEqual(validateProvenance(event.provenance), []);
  });
});

describe('synthetic feeds stay synthetic through the adapter', () => {
  it('a replay/fixture signal produces a DEMO-badged event', () => {
    const engine = new FlowEngine({ ...DEFAULT_CONFIG, syntheticSource: true });
    const out: ClassifiedSignal[] = [];
    engine.onQuote(quote({ ts: T0 - 10 }));
    out.push(...engine.onTrade(trade({ id: 's1', ts: T0, price: 5.15, size: 400 })));
    out.push(...engine.flush());

    const event = signalToFlowEvent(out[0]!, { source: 'simulation', now: () => new Date(T0) });
    assert.equal(event.provenance?.is_synthetic, true);
    assert.equal(event.provenance?.is_demo, true);
    assert.equal(badgeFor(event.provenance), 'DEMO');
    assert.deepEqual(validateProvenance(event.provenance), []);
  });
});
