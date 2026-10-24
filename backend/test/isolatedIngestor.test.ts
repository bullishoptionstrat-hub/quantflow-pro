/**
 * An isolated ingestion pipeline shares the live one's seam and none of its state.
 *
 * H-001-v2 §I declares staleness bounds of 1 s and 5 s as sensitivities. Those
 * change the engine's `nbboMaxAgeMs`, so they need signals formed by an engine
 * configured differently from the one serving the terminal. The adapter was
 * module state: one engine, one NBBO book, one set of repeat counters, one list
 * of observers (the recorder among them) per process. Running a re-run through
 * it would have written historical quotes into the live book, counted
 * historical signals as today's repeats, and offered every replayed signal to
 * the track record.
 *
 * Each test below drives the live pipeline and an isolated one with prints
 * where crossing between them would change an observable answer, so a shared
 * map or a shared observer list fails here rather than in production.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createIngestor, ingestPrint, drainIdle, resetDaily, onSignal, __clearSignalObservers,
  unreadableExpiryCounts, type RawPrint, type WireFlowEvent,
} from '../src/ingestion/flowEngineAdapter';
import { DEFAULT_CONFIG } from '../src/flow-engine/types';

const T0 = Date.UTC(2026, 2, 3, 15, 0, 0);
const SEC = 1_000;

/** A fill at the ask, carrying its own quote stamped `quoteAge` before the trade. */
function print(symbol: string, over: Partial<RawPrint> = {}, quoteAge = 0): RawPrint {
  return {
    ts: T0,
    quoteTs: T0 - quoteAge,
    symbol,
    expiry: '2026-06-19',
    strike: 600,
    right: 'C',
    price: 5,
    size: 200,
    exchange: 'CBOE',
    bid: 4.9,
    ask: 5.0,
    underlyingPrice: 590,
    source: 'replay',
    synthetic: true,
    replay: true,
    ...over,
  };
}

function liveRun(p: RawPrint): WireFlowEvent[] {
  return [...ingestPrint(p), ...drainIdle(0)];
}

test('the staleness bound is per instance: 1 s refuses a 3 s quote, 5 s accepts it', () => {
  const p = print('STALE', {}, 3 * SEC);
  const one = createIngestor({ engineConfig: { nbboMaxAgeMs: 1_000 }, now: () => T0 + 60 * SEC });
  const five = createIngestor({ engineConfig: { nbboMaxAgeMs: 5_000 }, now: () => T0 + 60 * SEC });
  const [a] = [...one.ingestPrint(p), ...one.flush()];
  const [b] = [...five.ingestPrint(p), ...five.flush()];
  assert.equal(a!.side, 'AMBIGUOUS');
  assert.equal(b!.side, 'BUY');
  assert.equal(one.config.nbboMaxAgeMs, 1_000);
  assert.equal(five.config.nbboMaxAgeMs, 5_000);
});

test('the live pipeline keeps the engine default, whatever an instance was given', () => {
  // Built after two instances with other bounds: if config leaked through a
  // shared default, the live engine would now answer at 1 s or 5 s.
  createIngestor({ engineConfig: { nbboMaxAgeMs: 5_000 } });
  createIngestor({ engineConfig: { nbboMaxAgeMs: 1_000 } });
  assert.equal(DEFAULT_CONFIG.nbboMaxAgeMs, 2_000, 'the premise');
  resetDaily();
  assert.equal(liveRun(print('LIVE_15', {}, 1_500))[0]!.side, 'BUY', '1.5 s is inside the live 2 s bound');
  assert.equal(liveRun(print('LIVE_30', {}, 3_000))[0]!.side, 'AMBIGUOUS', '3 s is outside it');
});

test('a quote published to an instance never reaches the live NBBO book', () => {
  resetDaily();
  const iso = createIngestor({ now: () => T0 + 60 * SEC });
  iso.ingestPrint(print('BOOK'));
  iso.flush();
  // The live pipeline sees the same contract with no quote of its own. If the
  // book were shared, the instance's quote would make this side BUY.
  const [sig] = liveRun(print('BOOK', { bid: undefined, ask: undefined, ts: T0 + SEC }));
  assert.equal(sig!.side, 'AMBIGUOUS');
});

test('and a live quote never reaches an instance', () => {
  resetDaily();
  liveRun(print('BOOK2'));
  const iso = createIngestor({ now: () => T0 + 60 * SEC });
  const [sig] = [...iso.ingestPrint(print('BOOK2', { bid: undefined, ask: undefined, ts: T0 + SEC })), ...iso.flush()];
  assert.equal(sig!.side, 'AMBIGUOUS');
});

test('an instance\'s signals do not count as live repeats', () => {
  resetDaily();
  const iso = createIngestor({ now: () => T0 + 600 * SEC });
  // Five signals on one contract and side in the instance, each its own burst.
  for (let i = 0; i < 5; i++) {
    iso.ingestPrint(print('REPEAT', { ts: T0 + i * 60 * SEC, quoteTs: T0 + i * 60 * SEC }));
    iso.flush();
  }
  const [inIso] = [...iso.ingestPrint(print('REPEAT', { ts: T0 + 6 * 60 * SEC, quoteTs: T0 + 6 * 60 * SEC })), ...iso.flush()];
  assert.equal(inIso!.score_breakdown.repeats, 10, 'the premise: the instance counted its own repeats');
  const [inLive] = liveRun(print('REPEAT'));
  assert.equal(inLive!.score_breakdown.repeats, 0, 'the live engine counted none of them');
});

test('an instance never notifies the live observers — the recorder never sees a replay', () => {
  resetDaily();
  __clearSignalObservers();
  const seen: string[] = [];
  onSignal((sig) => seen.push(sig.id));
  try {
    const iso = createIngestor({ now: () => T0 + 60 * SEC });
    const isoSeen: string[] = [];
    iso.onSignal((sig) => isoSeen.push(sig.id));
    const out = [...iso.ingestPrint(print('OBS')), ...iso.flush()];
    assert.equal(out.length, 1);
    assert.equal(isoSeen.length, 1, 'the instance told its own observer');
    assert.deepEqual(seen, [], 'and nobody else');

    liveRun(print('OBS2'));
    assert.equal(seen.length, 1, 'the live observer still hears the live pipeline');
    assert.equal(isoSeen.length, 1, 'and the instance\'s observer does not');
  } finally {
    __clearSignalObservers();
  }
});

test('an instance\'s refusals are its own, and do not reach /api/health', () => {
  const iso = createIngestor();
  const before = unreadableExpiryCounts()['iso-src']?.count ?? 0;
  iso.ingestPrint(print('BADEXP', { expiry: '20260619', source: 'iso-src' }));
  assert.equal(iso.unreadableExpiryCounts()['iso-src']?.count, 1);
  assert.equal(unreadableExpiryCounts()['iso-src']?.count ?? 0, before);
});

test('two instances given the same prints and clock answer identically', () => {
  const tape: RawPrint[] = [];
  for (let i = 0; i < 40; i++) {
    tape.push(print(i % 3 === 0 ? 'DET_A' : 'DET_B', {
      id: `det-${i}`,
      ts: T0 + i * 700,
      quoteTs: T0 + i * 700 - (i % 4) * 900,
      strike: 600 + (i % 2) * 5,
      price: i % 5 === 0 ? 4.9 : 5,
      size: 100 + i,
    }));
  }
  const run = () => {
    const ing = createIngestor({ engineConfig: { nbboMaxAgeMs: 1_000 }, now: () => T0 + 3_600 * SEC });
    return [...tape.flatMap((p) => ing.ingestPrint(p)), ...ing.flush()];
  };
  const a = run();
  const b = run();
  assert.ok(a.length > 0);
  assert.deepEqual(a, b);
});

test('no mutable pipeline state is left at module level', () => {
  // The defect was a singleton. A future `const cache = new Map()` or
  // `let counter = 0` at the top of the adapter would quietly become state
  // every instance shares, which no behavioural test above is guaranteed to
  // reach. So the module's top level may declare constants, functions and
  // types, and exactly one instance: `live`.
  const src = readFileSync(join(__dirname, '..', 'src', 'ingestion', 'flowEngineAdapter.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  const topLevel = src.split('\n').filter((l) => /^(export\s+)?(let|var|const)\s/.test(l));
  assert.ok(!topLevel.some((l) => /^(export\s+)?(let|var)\s/.test(l)), `top-level let/var: ${topLevel.join(' | ')}`);
  const stateful = topLevel.filter((l) => /new\s+(Map|Set|FlowEngine|Array)\b|=\s*\[\s*\]|=\s*\{\s*\}|createIngestor\(/.test(l));
  assert.deepEqual(stateful, ['const live = createIngestor();']);
});

test('contract stats are per instance: an instance\'s spot never prices a live print', () => {
  resetDaily();
  const iso = createIngestor({ now: () => T0 + 60 * SEC });
  iso.ingestPrint(print('STATS', { underlyingPrice: 590 }));
  iso.flush();
  const [sig] = liveRun(print('STATS', { underlyingPrice: undefined, ts: T0 + SEC }));
  assert.equal(sig!.spot_price, null, 'the live pipeline has no spot for this contract');
  assert.equal(sig!.moneyness, 'UNKNOWN');
});

test('an injected clock is the one that stamps the signal', () => {
  // A replay's emittedAt read off the wall clock would make two runs of the
  // same tape disagree, and decisionAt = max(lastEventAt, receivedAt,
  // emittedAt) would carry today's date onto a 2026-03 signal.
  const at = T0 + 42 * SEC;
  const iso = createIngestor({ now: () => at });
  const stamps: Array<number | undefined> = [];
  iso.onSignal((sig) => stamps.push(sig.emittedAt));
  iso.ingestPrint(print('CLOCK'));
  iso.flush();
  assert.deepEqual(stamps, [at]);
});
