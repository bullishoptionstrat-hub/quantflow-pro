import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemorySignalStore } from '../src/persistence/memoryStore';
import { SignalRecorder } from '../src/persistence/recorder';
import type { ClassifiedSignal, SignalLeg } from '../src/flow-engine/types';

const T0 = Date.parse('2026-08-29T14:30:00.000Z');

function leg(over: Partial<SignalLeg> = {}): SignalLeg {
  return {
    contract: {
      symbol: 'SPY260919C00550000', underlying: 'SPY',
      right: 'C', strike: 550, expiry: '2026-09-19',
    },
    side: 'BUY', totalSize: 100, totalPremium: 250_000, vwap: 25,
    prints: 3, exchanges: ['CBOE', 'PHLX'],
    ...over,
  };
}

/** Single-source origin, the common case. */
function origin(source: string, synthetic = false) {
  return { source, sources: [source], synthetic };
}

function sig(over: Partial<ClassifiedSignal> = {}): ClassifiedSignal {
  return {
    id: 'sig_1_x', kind: 'SWEEP', ts: T0, lastTs: T0 + 500,
    receivedAt: T0 + 520, emittedAt: T0 + 530,
    underlying: 'SPY', side: 'BUY', legs: [leg()],
    totalPremium: 250_000, totalSize: 100, iso: true,
    score: 82, scoreBreakdown: {}, printIds: ['p1'], synthetic: false,
    ...over,
  };
}

test('a permitted source is recorded with its decision time and provenance', async () => {
  const store = new InMemorySignalStore();
  const r = new SignalRecorder(store, 'PRIVATE_RESEARCH');

  const res = await r.record(sig(), origin('tradier', false));
  assert.equal(res.status, 'RECORDED');

  const stored = await store.getSignal(res.signalKey!);
  assert.ok(stored);
  assert.equal(stored!.datasetId, 'TRADIER_STREAM');
  assert.equal(stored!.rightsClass, 'PERMITTED');
  assert.equal(stored!.decisionAt, T0 + 530);
  assert.equal(stored!.decisionBasis, 'OBSERVED');
  assert.equal(stored!.firstEventAt, T0);
  // Identity is the content hash, not the engine's restart-unstable sequence id.
  assert.match(stored!.signalKey, /^[0-9a-f]{64}$/);
  assert.equal(stored!.engineId, 'sig_1_x');
});

test('an unverified source is refused for persistence and the refusal is attributed', async () => {
  const store = new InMemorySignalStore();
  const r = new SignalRecorder(store, 'PRIVATE_RESEARCH');

  const res = await r.record(sig(), origin('cboe_options', false));
  assert.equal(res.status, 'REFUSED_RIGHTS');
  assert.match(res.reason!, /UNVERIFIED/);
  assert.equal((await store.countSignals()).total, 0, 'nothing was written');

  const stats = r.getStats();
  assert.equal(stats.refusedRights, 1);
  assert.equal(stats.recorded, 0);
  // Which source was refused, not just how many — otherwise the operator
  // cannot tell a rights problem from a dead feed.
  assert.equal(stats.refusalsByDataset['CBOE_CDN_DELAYED_CHAIN'], 1);
});

test('a prohibited source is refused in every mode', async () => {
  for (const mode of ['PRIVATE_RESEARCH', 'PUBLIC_COMMERCIAL'] as const) {
    const r = new SignalRecorder(new InMemorySignalStore(), mode);
    assert.equal((await r.record(sig(), origin('yahoo', false))).status, 'REFUSED_RIGHTS');
  }
});

test('a permitted-in-research source is refused once the mode goes commercial', async () => {
  const research = new SignalRecorder(new InMemorySignalStore(), 'PRIVATE_RESEARCH');
  assert.equal((await research.record(sig(), origin('tradier', false))).status, 'RECORDED');

  const commercial = new SignalRecorder(new InMemorySignalStore(), 'PUBLIC_COMMERCIAL');
  const res = await commercial.record(sig(), origin('tradier', false));
  assert.equal(res.status, 'REFUSED_RIGHTS');
  assert.match(res.reason!, /UNVERIFIED/);
});

test('an unmapped source is refused rather than recorded as unknown', async () => {
  const r = new SignalRecorder(new InMemorySignalStore(), 'PRIVATE_RESEARCH');
  const res = await r.record(sig(), origin('some_new_vendor', false));
  assert.equal(res.status, 'REFUSED_RIGHTS');
  assert.equal(r.getStats().refusalsByDataset['source:some_new_vendor'], 1);
});

test('synthetic signals are stored and marked, so an empty real record is visible as such', async () => {
  // Storing them is deliberate. An empty table cannot be told apart from a
  // broken writer; a table full of clearly-marked synthetic rows tells the
  // operator exactly what this deployment has been doing.
  const store = new InMemorySignalStore();
  const r = new SignalRecorder(store, 'PRIVATE_RESEARCH');

  const res = await r.record(sig(), origin('simulation', true));
  assert.equal(res.status, 'RECORDED');
  assert.equal((await store.getSignal(res.signalKey!))!.synthetic, true);
  assert.equal(r.getStats().syntheticRecorded, 1);

  const report = await store.trackRecord();
  assert.equal(report.rows.length, 0, 'and they never reach a rate');
  assert.equal(report.excluded.synthetic, 1);
});

test('the same signal arriving twice is a replay, counted separately from a new record', async () => {
  const store = new InMemorySignalStore();
  const r = new SignalRecorder(store, 'PRIVATE_RESEARCH');

  assert.equal((await r.record(sig(), origin('tradier', false))).status, 'RECORDED');
  assert.equal((await r.record(sig(), origin('tradier', false))).status, 'REPLAY');
  assert.equal((await store.countSignals()).total, 1);

  const s = r.getStats();
  assert.equal(s.recorded, 1);
  assert.equal(s.replays, 1);
  assert.equal(s.seen, 2);
});

test('a replay through the engine gets an EVENT_TIME_ONLY basis, not a wall-clock decision time', async () => {
  const store = new InMemorySignalStore();
  const r = new SignalRecorder(store, 'PRIVATE_RESEARCH');

  const res = await r.record(sig({ receivedAt: undefined }), origin('polygon', false));
  const stored = await store.getSignal(res.signalKey!);
  assert.equal(stored!.decisionBasis, 'EVENT_TIME_ONLY');
  assert.equal(stored!.decisionAt, T0 + 500);
});

test('a malformed timeline is counted as an error and never takes the feed down', async () => {
  const r = new SignalRecorder(new InMemorySignalStore(), 'PRIVATE_RESEARCH');
  const res = await r.record(sig({ ts: T0 + 900, lastTs: T0 }), origin('tradier', false));

  assert.equal(res.status, 'ERROR');
  assert.match(res.reason!, /inverted timeline/);
  assert.equal(r.getStats().errors, 1);
  assert.match(r.getStats().lastError!, /inverted timeline/);
});

test('a cluster spanning sources is refused unless EVERY source is permitted', async () => {
  // Bursts group by underlying and time, not by feed, so a cluster really can
  // mix sources. Checking only the first print would let one permitted print
  // carry a whole cluster of unverified ones into the permanent record.
  const store = new InMemorySignalStore();
  const r = new SignalRecorder(store, 'PRIVATE_RESEARCH');

  const res = await r.record(sig(), {
    source: 'tradier',
    sources: ['tradier', 'cboe_options'],
    synthetic: false,
  });

  assert.equal(res.status, 'REFUSED_RIGHTS');
  assert.match(res.reason!, /tradier, cboe_options/);
  assert.equal((await store.countSignals()).total, 0);
});

test('a cluster spanning two permitted sources is recorded', async () => {
  const store = new InMemorySignalStore();
  const r = new SignalRecorder(store, 'PRIVATE_RESEARCH');

  const res = await r.record(sig(), {
    source: 'tradier',
    sources: ['tradier', 'polygon'],
    synthetic: false,
  });
  assert.equal(res.status, 'RECORDED');
  assert.equal((await store.getSignal(res.signalKey!))!.datasetId, 'TRADIER_STREAM');
});
