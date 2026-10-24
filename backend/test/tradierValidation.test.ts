/**
 * Tradier: the contract selection is configured, stated, and refused when
 * malformed; and a connected stream earns its place in the record only by
 * what its own prints show.
 *
 * Everything here is LOCAL verification. The validator is driven with prints
 * in the shape `timesaleToPrint` produces; it has never judged a real Tradier
 * session, and the first live boot is where it does.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  coverageStatement, TradierValidator, universeRuleFromEnv, UNIVERSE_RULE, VALIDATION_RULE,
  type UniverseContract,
} from '../src/ingestion/tradierStream';
import type { RawPrint } from '../src/ingestion/flowEngineAdapter';
import { InMemorySignalStore } from '../src/persistence/memoryStore';
import { SignalRecorder } from '../src/persistence/recorder';
import type { ClassifiedSignal } from '../src/flow-engine/types';

const INDEX = readFileSync(join(__dirname, '../src/ingestion/index.ts'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');

// ─── Configuration ──────────────────────────────────────────────────────────

test('unset settings are the approved defaults', () => {
  const { rule, problems } = universeRuleFromEnv({});
  assert.deepEqual(rule, UNIVERSE_RULE);
  assert.deepEqual(UNIVERSE_RULE, { expirationsPerUnderlying: 2, strikeBand: 0.05, maxPerUnderlying: 100 });
  assert.deepEqual(problems, []);
});

test('valid settings are honoured', () => {
  const { rule, problems } = universeRuleFromEnv({
    TRADIER_UNIVERSE_EXPIRATIONS: '3', TRADIER_UNIVERSE_STRIKE_BAND: '0.1', TRADIER_UNIVERSE_MAX_PER_UNDERLYING: '250',
  });
  assert.deepEqual(rule, { expirationsPerUnderlying: 3, strikeBand: 0.1, maxPerUnderlying: 250 });
  assert.deepEqual(problems, []);
});

test('a malformed setting is a named problem, never a silent fallback', () => {
  for (const [name, raw] of [
    ['TRADIER_UNIVERSE_EXPIRATIONS', '0'], ['TRADIER_UNIVERSE_EXPIRATIONS', '2.5'], ['TRADIER_UNIVERSE_EXPIRATIONS', 'two'],
    ['TRADIER_UNIVERSE_STRIKE_BAND', '5'], ['TRADIER_UNIVERSE_STRIKE_BAND', '-0.05'],
    ['TRADIER_UNIVERSE_MAX_PER_UNDERLYING', '0'], ['TRADIER_UNIVERSE_MAX_PER_UNDERLYING', '1e9'],
  ] as const) {
    const { problems } = universeRuleFromEnv({ [name]: raw });
    assert.equal(problems.length, 1, `${name}=${raw}`);
    assert.match(problems[0]!, new RegExp(name));
  }
});

test('the stream refuses to subscribe while a setting is malformed', () => {
  const sub = INDEX.slice(INDEX.indexOf('const subscribe = async'));
  const guard = sub.indexOf('tradierRuleConfig.problems.length > 0');
  const build = sub.indexOf('buildUniverse(');
  assert.ok(guard > 0 && guard < build, 'the settings are checked before any universe is built');
  assert.match(sub.slice(0, build), /return;/);
  assert.match(INDEX, /buildUniverse\(tradierGet, WATCHED_SYMBOLS, today, tradierRuleConfig\.rule\)/);
});

test('the coverage statement says what is never observed', () => {
  const s = coverageStatement(UNIVERSE_RULE, ['SPY', 'QQQ']);
  assert.match(s, /SPY, QQQ/);
  assert.match(s, /2 nearest/);
  assert.match(s, /5\.0%/);
  assert.match(s, /never observed/);
  assert.match(INDEX, /tradierCoverage:/);
});

// ─── Validation ─────────────────────────────────────────────────────────────

const T = Date.UTC(2026, 9, 14, 15, 0, 0);
const C: UniverseContract = { symbol: 'SPY261016C00550000', underlying: 'SPY', root: 'SPY', strike: 550, right: 'C', expiry: '2026-10-16' };
const universe = new Map([[C.symbol, C]]);
const print = (o: Partial<RawPrint> = {}): RawPrint => ({
  symbol: 'SPY', root: 'SPY', expiry: C.expiry, strike: 550, right: 'C',
  price: 12.3, size: 10, bid: 12.2, ask: 12.4, ts: T, quoteTs: T, source: 'tradier', ...o,
});
const fed = (n: number, o: Partial<RawPrint> = {}) => {
  const v = new TradierValidator();
  v.observeUniverse(universe, '2026-10-14');
  for (let i = 0; i < n; i++) v.observePrint(print(o), T + 200);
  return v;
};
const failing = (v: TradierValidator) => v.report().checks.filter((c) => !c.pass).map((c) => c.name);

test('nothing has started, and nothing is admitted', () => {
  const r = new TradierValidator().report();
  assert.equal(r.state, 'NOT_STARTED');
  assert.equal(r.recording, 'HELD');
});

test('a connected stream with too few prints is held, not trusted', () => {
  const r = fed(VALIDATION_RULE.minPrints - 1).report();
  assert.equal(r.state, 'AWAITING_DATA');
  assert.equal(r.recording, 'HELD');
});

test('enough good prints validate the stream and admit it', () => {
  const r = fed(VALIDATION_RULE.minPrints).report();
  assert.equal(r.state, 'VALIDATED', JSON.stringify(r.checks));
  assert.equal(r.recording, 'ADMITTED');
});

test('each broken-mapping shape fails its own check', () => {
  assert.deepEqual(failing(fed(60, { bid: undefined, ask: undefined })), ['quoted', 'uncrossed', 'plausible-price']);
  assert.deepEqual(failing(fed(60, { bid: 12.6, ask: 12.4 })), ['uncrossed']);
  assert.deepEqual(failing(fed(60, { price: 120 })), ['plausible-price']);
  // A timestamp in seconds instead of milliseconds is decades from receipt.
  assert.deepEqual(failing(fed(60, { ts: Math.floor(T / 1000) })), ['timely']);
  const v = fed(60);
  for (let i = 0; i < 10; i++) v.observeRefusal('NOT_SUBSCRIBED');
  assert.deepEqual(failing(v), ['identities']);
  // Cancels and heartbeats are not identity failures.
  const w = fed(60);
  for (let i = 0; i < 10; i++) { w.observeRefusal('CANCEL'); w.observeRefusal('NOT_TIMESALE'); }
  assert.deepEqual(failing(w), []);
});

test('a malformed universe fails before any print is judged', () => {
  const v = new TradierValidator();
  v.observeUniverse(new Map([['BAD', { ...C, symbol: 'BAD' }]]), '2026-10-14');
  for (let i = 0; i < 60; i++) v.observePrint(print(), T);
  assert.equal(v.report().state, 'FAILING');
  assert.deepEqual(failing(v), ['universe']);
  const expired = new TradierValidator();
  expired.observeUniverse(universe, '2026-10-20');
  assert.equal(expired.report().state, 'FAILING');
});

test('a stream that degrades mid-session loses its standing', () => {
  const v = fed(60);
  assert.equal(v.report().recording, 'ADMITTED');
  for (let i = 0; i < VALIDATION_RULE.window; i++) v.observePrint(print({ bid: undefined, ask: undefined }), T + 200);
  assert.equal(v.report().recording, 'HELD');
  // And it is the WINDOW that judges, not the session's whole history: a feed
  // that recovers regains its standing once a window of good prints has
  // passed, which cumulative counts would withhold for the rest of the day.
  for (let i = 0; i < VALIDATION_RULE.window; i++) v.observePrint(print(), T + 200);
  assert.equal(v.report().recording, 'ADMITTED');
});

test('heartbeats do not dilute a real identity failure', () => {
  // 4 unsubscribed of 64 timesales is 6.25%, over the 5% bound. A hundred
  // heartbeat frames counted as timesales would dilute that under the bound.
  const v = fed(60);
  for (let i = 0; i < 4; i++) v.observeRefusal('NOT_SUBSCRIBED');
  for (let i = 0; i < 100; i++) v.observeRefusal('NOT_TIMESALE');
  assert.deepEqual(failing(v), ['identities']);
});

// ─── The record ─────────────────────────────────────────────────────────────

function sig(): ClassifiedSignal {
  return {
    id: 'sig_1_x', kind: 'SWEEP', ts: T, lastTs: T + 500, receivedAt: T + 520, emittedAt: T + 530,
    underlying: 'SPY', side: 'BUY',
    legs: [{ contract: { symbol: C.symbol, underlying: 'SPY', right: 'C', strike: 550, expiry: C.expiry },
      side: 'BUY', totalSize: 100, totalPremium: 250_000, vwap: 25, prints: 3, exchanges: ['CBOE'] }],
    totalPremium: 250_000, totalSize: 100, iso: true, score: 82, scoreBreakdown: {}, printIds: ['p1'], synthetic: false,
  };
}

test('a held source is displayed but not recorded, and the hold is counted by source', async () => {
  const store = new InMemorySignalStore();
  const r = new SignalRecorder(store, 'PRIVATE_RESEARCH');
  r.holdUntilValidated(() => new Set(['tradier']));
  const res = await r.record(sig(), { source: 'tradier', sources: ['tradier'], synthetic: false });
  assert.equal(res.status, 'HELD_UNVALIDATED');
  assert.equal((await store.countSignals()).total, 0);
  assert.equal(r.getStats().heldUnvalidated, 1);
  assert.deepEqual(r.getStats().heldBySource, { tradier: 1 });
});

test('a cluster with one held source is held whole; once validated it records', async () => {
  const store = new InMemorySignalStore();
  const r = new SignalRecorder(store, 'PRIVATE_RESEARCH');
  let held = new Set(['tradier']);
  r.holdUntilValidated(() => held);
  // Polygon is PERMITTED for PERSIST in this mode, so only the hold can refuse it.
  assert.equal((await r.record(sig(), { source: 'polygon', sources: ['polygon', 'tradier'], synthetic: false })).status, 'HELD_UNVALIDATED');
  held = new Set();
  assert.equal((await r.record(sig(), { source: 'tradier', sources: ['tradier'], synthetic: false })).status, 'RECORDED');
});

test('the live wiring holds Tradier until validated and does not count a held window as collecting', () => {
  const start = INDEX.indexOf('initPersistence();');
  const hold = INDEX.indexOf('recorder.holdUntilValidated(heldSources)');
  const subscribe = INDEX.indexOf('onSignal((sig, origin)');
  assert.ok(start > 0 && hold > start && hold < subscribe, 'the hold is installed before any signal can be recorded');
  assert.match(INDEX, /tradierValidator\.observePrint\(out\.print/);
  assert.match(INDEX, /tradierValidator\.observeRefusal\(out\.refused\)/);
  assert.match(INDEX, /tradierValidator\.observeUniverse\(tradierUniverse/);
  const cov = INDEX.slice(INDEX.indexOf('function sampleCoverage'));
  assert.match(cov.slice(0, 600), /!held\.has\(s\)/);
});

// ─── The doctor ─────────────────────────────────────────────────────────────

test('the doctor does not count a held Tradier as delivering, and names what fails', async () => {
  const { liveChecks } = await import('../tools/collection/doctor');
  const base = { storeKind: 'supabase', durable: true, recorded: 0, syntheticRecorded: 0, graded: 0 };
  const held = liveChecks({ ...base, connectedRecordable: [], tradierLive: { state: 'FAILING', recording: 'HELD', failing: ['quoted'] } });
  assert.equal(held.find((c) => c.name === 'A source actually delivering')!.status, 'blocked');
  const v = held.find((c) => c.name === 'Tradier live validation')!;
  assert.equal(v.status, 'blocked');
  assert.match(v.detail, /quoted/);
  const waiting = liveChecks({ ...base, connectedRecordable: [], tradierLive: { state: 'AWAITING_DATA', recording: 'HELD', failing: [] } });
  assert.equal(waiting.find((c) => c.name === 'Tradier live validation')!.status, 'warn');
  const ok = liveChecks({ ...base, connectedRecordable: ['tradier'], tradierLive: { state: 'VALIDATED', recording: 'ADMITTED', failing: [] } });
  assert.equal(ok.find((c) => c.name === 'Tradier live validation'), undefined);
});

test('the doctor reads a held Tradier off /api/health as not delivering', async () => {
  const { readLive } = await import('../tools/collection/doctor');
  const real = globalThis.fetch;
  const health = (recording: string) => ({
    ingestion: { sources: { tradier: 'connected' },
      tradierLive: { state: recording === 'HELD' ? 'AWAITING_DATA' : 'VALIDATED', recording, checks: [{ name: 'quoted', pass: recording !== 'HELD' }] } },
    history: {},
  });
  try {
    globalThis.fetch = (async () => new Response(JSON.stringify(health('HELD')), { status: 200 })) as typeof fetch;
    const held = await readLive('http://x');
    assert.deepEqual(held.connectedRecordable, []);
    assert.deepEqual(held.tradierLive?.failing, ['quoted']);
    globalThis.fetch = (async () => new Response(JSON.stringify(health('ADMITTED')), { status: 200 })) as typeof fetch;
    assert.deepEqual((await readLive('http://x')).connectedRecordable, ['tradier']);
  } finally {
    globalThis.fetch = real;
  }
});
