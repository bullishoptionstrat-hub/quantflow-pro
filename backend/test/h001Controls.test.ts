/**
 * H-001-v2 §G as code (`research/h001Controls.ts`): the primary control C.
 *
 * Each case is a way matching can flatter a study without anyone deciding to
 * — an edge that drifts, a near-miss accepted, a control that could not be
 * measured quietly replaced, a cancelled trade standing in for an execution,
 * an A event's own prints used as its control. Each is built so the wrong rule
 * would produce a DIFFERENT, plausible answer rather than an error.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTradeEvent } from '../src/events/build';
import type { RawTradeRecord } from '../src/events/build';
import type { MarketEvent, TradeReportEvent } from '../src/events/types';
import { EventLog } from '../src/events/eventLog';
import {
  causalSpot, controlPool, dteBucket, keyString, matchControls, matchKeyOf, moneynessBucket, premiumBucket,
  H001_CONTROLS_PER_EVENT,
} from '../src/research/h001Controls';
import type { AMetaEvent } from '../src/research/h001Controls';
import { h001Return } from '../src/research/h001Marks';
import type { UnderlyingQuote } from '../src/research/h001Marks';
import { h001Verdict } from '../src/research/h001Verdict';

// 2026-03-10, a Tuesday in EDT: 14:00Z is 10:00 ET.
const DAY = '2026-03-10';
const ET = (h: number, m: number, s = 0, ms = 0) => Date.parse(`${DAY}T${String(h + 4).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}Z`);

/** A one-quote-per-second SPY tape, 09:30–16:00 ET, whose midpoint wanders so each anchor has its own return. */
const midAt = (t: number) => 550 + 0.4 * Math.sin((t - ET(9, 30)) / 97_000) + 0.2 * Math.sin((t - ET(9, 30)) / 13_000);
const QUOTES: UnderlyingQuote[] = [];
for (let t = ET(9, 30); t <= ET(16, 0); t += 1_000) {
  const mid = Math.round(midAt(t) * 100) / 100;
  QUOTES.push({ provider: 'p', eventTime: t, availableAt: t + 5, bid: mid - 0.01, ask: mid + 0.01 });
}

let seq = 1;
function rec(over: Partial<RawTradeRecord> = {}): RawTradeRecord {
  const eventTime = over.eventTime ?? ET(10, 15);
  return {
    provider: 'hypothetical', datasetId: 'HYPOTHETICAL.OPRA', sequenceScope: `line-1:${DAY}`,
    providerSequence: String(seq++), eventTime, providerReceiveTime: eventTime + 3,
    instrument: { underlying: 'SPY', expiry: '2026-03-20', strike: 552, right: 'C' },
    venue: 'C', rawSessionIdentifier: 0, synthetic: false, replay: true, price: 3, size: 400, ...over,
  };
}
const trade = (over: Partial<RawTradeRecord> = {}) => buildTradeEvent(rec(over)) as TradeReportEvent;
const tapeOf = (events: readonly MarketEvent[]) => {
  const log = new EventLog();
  for (const e of events) log.append(e);
  return log.finalCorrected();
};

/** An A meta-event at `startsAt` keyed like the default control: 10 DTE, K/S ≈ 1.004, $120k. */
const metaA = (id: string, startsAt: number, over: Partial<AMetaEvent> = {}): AMetaEvent =>
  ({ metaEventId: id, startsAt, expiry: '2026-03-20', strike: 552, premium: 120_000, ...over });

test('buckets: the §G edges, lower-inclusive (M3)', () => {
  assert.deepEqual([0, 1, 2, 3, 7, 8, 30, 31, 400].map(dteBucket), ['0', '1-2', '1-2', '3-7', '3-7', '8-30', '8-30', '31+', '31+']);
  assert.equal(dteBucket(-1), null, 'a contract that expired before the anchor has no bucket');
  assert.deepEqual([0.9699, 0.97, 0.9949, 0.995, 1.0049, 1.005, 1.0299, 1.03].map(moneynessBucket),
    ['<0.97', '0.97-0.995', '0.97-0.995', '0.995-1.005', '0.995-1.005', '1.005-1.03', '1.005-1.03', '>=1.03']);
  assert.deepEqual([49_999.99, 50_000, 99_999.99, 100_000, 250_000, 999_999.99, 1_000_000].map(premiumBucket),
    [null, '50k-100k', '50k-100k', '100k-250k', '250k-1M', '250k-1M', '>=1M']);
});

test('the hour is the ET clock hour, in both offsets; DTE is calendar days to the expiry date', () => {
  const key = (anchor: number, expiry = '2026-03-20') => {
    const quotes: UnderlyingQuote[] = [{ provider: 'p', eventTime: anchor - 500, availableAt: anchor - 400, bid: 549.99, ask: 550.01 }];
    const k = matchKeyOf({ anchor, expiry, strike: 552, premium: 120_000 }, quotes);
    assert.ok(k.ok, JSON.stringify(k));
    return k.key;
  };
  assert.equal(key(ET(10, 59, 59, 999)).hourEt, 10);
  assert.equal(key(ET(11, 0)).hourEt, 11, 'one millisecond later is the next bucket');
  assert.equal(key(ET(9, 45)).hourEt, 9, 'M1: 09:30–09:59 is the 09:00 clock hour, not the first session hour');
  // January is EST: 15:00Z is 10:00 ET there, and 11:00 ET in March.
  const jan = Date.parse('2026-01-13T15:00:00Z');
  assert.equal(key(jan, '2026-01-13').hourEt, 10);
  assert.equal(key(jan, '2026-01-13').dte, '0', 'expiring on the anchor\'s own market date is DTE 0');
  assert.equal(key(ET(10, 0), '2026-03-12').dte, '1-2');
  // 21:30 ET on the 9th is already the 10th in UTC; the market date decides.
  assert.equal(key(Date.parse('2026-03-10T01:30:00Z'), '2026-03-10').dte, '1-2');
});

test('M4: moneyness needs a causal SPY midpoint — known by the anchor and no older than 2 s', () => {
  const at = ET(10, 15);
  const input = { anchor: at, expiry: '2026-03-20', strike: 552, premium: 120_000 };
  const q = (eventTime: number, availableAt: number): UnderlyingQuote => ({ provider: 'p', eventTime, availableAt, bid: 549.99, ask: 550.01 });
  assert.equal(causalSpot([q(at - 2_000, at - 1_990)], at), 550);
  assert.equal(causalSpot([q(at - 2_001, at - 1_990)], at), null, 'stale: no older midpoint is substituted');
  assert.equal(causalSpot([q(at - 100, at + 1)], at), null, 'stamped before the anchor but not yet known');
  const k = matchKeyOf(input, [q(at - 100, at + 1)]);
  assert.equal(k.ok, false);
  // The fresher quote that had not arrived would put K/S in a different bucket;
  // the one a trader had keeps it where it was.
  const known = q(at - 1_500, at - 1_400);
  const notYet = { ...q(at - 100, at + 50), bid: 547.99, ask: 548.01 };
  const kk = matchKeyOf(input, [known, notYet]);
  assert.ok(kk.ok);
  assert.equal(kk.key.moneyness, '0.995-1.005', `552 / 550, not 552 / 548 = 1.0073: ${JSON.stringify(kk.key)}`);
});

test('five controls are drawn without replacement from an exact-match pool, deterministically', () => {
  // A 1.5 s receipt delay, so a control measured from its event time instead
  // of its availableAt would read a different book.
  const pool = Array.from({ length: 9 }, (_, i) => trade({ eventTime: ET(10, 20 + i * 3), providerReceiveTime: ET(10, 20 + i * 3) + 1_500 }));
  const tape = tapeOf(pool);
  const a = [metaA('a1', ET(10, 5))];
  const m = matchControls({ a, tape, excludedEventIds: new Set(), quotes: QUOTES });
  assert.equal(m.poolSize, 9);
  const row = m.matches[0]!;
  assert.equal(row.status, 'MATCHED');
  assert.equal(row.controls.length, H001_CONTROLS_PER_EVENT);
  assert.equal(new Set(row.controls.map((c) => c.eventId)).size, 5, 'without replacement');
  const rA = h001Return(ET(10, 5), QUOTES);
  assert.equal(rA.status, 'OK');
  const mean = row.controls.reduce((s, c) => s + c.returnBp, 0) / 5;
  assert.ok(Math.abs(row.controlMeanBp! - mean) < 1e-12);
  assert.ok(Math.abs(row.differenceBp! - ((rA.status === 'OK' ? rA.returnBp : NaN) - mean)) < 1e-12);
  // Each control's return is §C measured from ITS OWN availableAt.
  let differsFromEventTime = 0;
  for (const c of row.controls) {
    const e = pool.find((p) => p.eventId === c.eventId)!;
    const r = h001Return(e.availableAt, QUOTES);
    assert.equal(r.status === 'OK' && r.returnBp, c.returnBp);
    const fromEventTime = h001Return(e.eventTime, QUOTES);
    if (fromEventTime.status === 'OK' && fromEventTime.returnBp !== c.returnBp) differsFromEventTime++;
  }
  assert.ok(differsFromEventTime > 0, 'the fixture distinguishes the two anchors, or the check above proves nothing');
  assert.deepEqual(m.primary, [{ date: DAY, valueBp: row.differenceBp }]);
  assert.equal(m.unmatchedA, 0);
  // Same data, same draw — and the order the inputs arrive in is not data.
  const again = matchControls({ a, tape: tapeOf([...pool].reverse()), excludedEventIds: new Set(), quotes: QUOTES });
  assert.deepEqual(again.matches, m.matches);
  // Fewer than five available: all of them, not a refusal.
  const three = matchControls({ a, tape: tapeOf(pool.slice(0, 3)), excludedEventIds: new Set(), quotes: QUOTES });
  assert.equal(three.matches[0]!.controls.length, 3);
});

test('the draw is a draw: across A events, every pool member is chosen, and none twice for one event', () => {
  const pool = Array.from({ length: 8 }, (_, i) => trade({ eventTime: ET(10, 20 + i * 4) }));
  const a = Array.from({ length: 12 }, (_, i) => metaA(`a${String(i).padStart(2, '0')}`, ET(10, 2 + i * 4, 30)));
  const m = matchControls({ a, tape: tapeOf(pool), excludedEventIds: new Set(), quotes: QUOTES });
  const seen = new Map<string, number>();
  for (const row of m.matches) {
    assert.equal(row.status, 'MATCHED');
    assert.equal(new Set(row.controls.map((c) => c.eventId)).size, row.controls.length);
    for (const c of row.controls) seen.set(c.eventId, (seen.get(c.eventId) ?? 0) + 1);
  }
  assert.equal(seen.size, 8, 'M6: an execution may control more than one A event, and none is never drawn');
  // M6: the stream is consumed in A order (date, start, id), not in the order
  // the caller happened to list them — which would make the draw depend on it.
  const reversed = matchControls({ a: [...a].reverse(), tape: tapeOf(pool), excludedEventIds: new Set(), quotes: QUOTES });
  assert.deepEqual(reversed.matches, m.matches);
  // Not the same five every time — which a sort without a shuffle would give.
  assert.ok(new Set(m.matches.map((r) => r.controls.map((c) => c.eventId).sort().join())).size > 1);
});

test('exact match only: a near miss on any axis is NO_MATCH, counted, and never coarsened', () => {
  const at = ET(10, 5);
  const miss = {
    hour: trade({ eventTime: ET(11, 5) }),
    dte: trade({ instrument: { underlying: 'SPY', expiry: '2026-04-17', strike: 552, right: 'C' } }),
    moneyness: trade({ instrument: { underlying: 'SPY', expiry: '2026-03-20', strike: 556, right: 'C' } }),
    premium: trade({ size: 300 }), // $90,000: the bucket below
  };
  const tape = tapeOf(Object.values(miss));
  const m = matchControls({ a: [metaA('a1', at)], tape, excludedEventIds: new Set(), quotes: QUOTES });
  assert.equal(m.poolSize, 4, 'each one is a usable control — for a different A event');
  assert.equal(m.matches[0]!.status, 'NO_MATCH');
  assert.equal(m.unmatchedA, 1);
  assert.deepEqual(m.primary, []);
  // And the same A event matches each of them once its own key moves there.
  const keyOfTrade = (e: TradeReportEvent) => controlPool(tapeOf([e]), new Set(), QUOTES).pool[0]!.key;
  assert.notEqual(keyString(keyOfTrade(miss.premium)), keyString(keyOfTrade(trade())));
  const moved = matchControls({ a: [metaA('a1', at, { premium: 90_000 })], tape, excludedEventIds: new Set(), quotes: QUOTES });
  assert.deepEqual(moved.matches[0]!.controls.map((c) => c.eventId), [miss.premium.eventId]);
});

test('an A meta-event with no key is unmatched, not dropped from the denominator', () => {
  const tape = tapeOf([trade()]);
  // A $40k first signal has no premium bucket, so no exact match can exist for it.
  const m = matchControls({
    a: [metaA('a1', ET(10, 5), { premium: 40_000 }), metaA('a2', ET(10, 6))],
    tape, excludedEventIds: new Set(), quotes: QUOTES,
  });
  assert.deepEqual(m.matches.map((r) => r.status), ['NO_KEY', 'MATCHED']);
  assert.equal(m.unmatchedA, 1);
  assert.equal(m.primary.length, 1);
  // Which feeds §G's 20% rule directly: one in two unmatched is DESCRIPTIVE.
  const v = h001Verdict({ primary: m.primary, unmatchedA: m.unmatchedA, groupA: [], groupB: [], truthSetAvailable: true });
  assert.equal(v.n.unmatchedShare, 0.5);
});

test('"not part of any A or B meta-event": an A event\'s own prints never control it', () => {
  const own = trade({ eventTime: ET(10, 20) });
  const other = trade({ eventTime: ET(10, 25) });
  const m = matchControls({ a: [metaA('a1', ET(10, 5))], tape: tapeOf([own, other]),
    excludedEventIds: new Set([own.eventId]), quotes: QUOTES });
  assert.deepEqual(m.matches[0]!.controls.map((c) => c.eventId), [other.eventId]);
  assert.equal(m.rejected.some((r) => r.eventId === own.eventId), false, 'excluded, not rejected: it is not a control at all');
});

test('M7: an execution that could not be measured the same way is out of the pool BEFORE the draw', () => {
  const good = trade({ eventTime: ET(10, 30) });
  const cancelled = trade({ eventTime: ET(10, 31), providerEventId: 'x1', providerSequence: undefined });
  const cancel = buildTradeEvent(rec({
    eventTime: ET(10, 32), providerEventId: 'c1', providerSequence: undefined, rawMessageType: 'CANC',
    referencedProviderEventId: 'x1', price: undefined, size: undefined,
  }));
  const bad: Record<string, TradeReportEvent> = {
    synthetic: trade({ eventTime: ET(10, 33), synthetic: true }),
    lowerBound: trade({ eventTime: ET(10, 34), providerReceiveTime: undefined }),
    lateWindow: trade({ eventTime: ET(15, 50) }),
    noMarks: trade({ eventTime: ET(10, 35), instrument: { underlying: 'SPY', expiry: '2026-03-20', strike: 552, right: 'C' } }),
  };
  const put = trade({ eventTime: ET(10, 36), instrument: { underlying: 'SPY', expiry: '2026-03-20', strike: 552, right: 'P' } });
  const qqq = trade({ eventTime: ET(10, 37), instrument: { underlying: 'QQQ', expiry: '2026-03-20', strike: 552, right: 'C' } });
  const tape = tapeOf([good, cancelled, cancel, ...Object.values(bad), put, qqq]);
  // A one-sided SPY book just before this execution's exit: it keys, it has
  // an entry mark, and §C refuses its exit. A matcher that kept it would draw a
  // control it then cannot measure.
  const tExit = bad.noMarks!.availableAt + 1_000 + 15 * 60_000;
  const quotes = [...QUOTES, { provider: 'p', eventTime: tExit - 1, availableAt: tExit + 4, bid: null, ask: 550.02 }];
  const { pool, rejected } = controlPool(tape, new Set(), quotes);
  assert.deepEqual(pool.map((c) => c.eventId), [good.eventId]);
  const why = (e: TradeReportEvent) => rejected.find((r) => r.eventId === e.eventId)?.why ?? '(not rejected)';
  assert.match(why(cancelled), /CANCELLED/);
  assert.match(why(bad.synthetic!), /synthetic/);
  assert.match(why(bad.lowerBound!), /event time/);
  assert.match(why(bad.lateWindow!), /after the regular close/);
  assert.match(why(bad.noMarks!), /NO_EXIT_MARK/);
  // A put or another underlying is not a candidate at all, so it is not "rejected".
  assert.equal(rejected.some((r) => r.eventId === put.eventId || r.eventId === qqq.eventId), false);
  // So an A event beside the bad ones is matched to the one usable control,
  // and gets one control — not five of which four are later thrown away.
  const m = matchControls({ a: [metaA('a1', ET(10, 5))], tape, excludedEventIds: new Set(), quotes });
  assert.deepEqual(m.matches[0]!.controls.map((c) => c.eventId), [good.eventId]);
});

test('the pool comes from the final tape; an as-known view is refused', () => {
  const log = new EventLog();
  log.append(trade());
  assert.throws(() => controlPool(log.asKnownAt(ET(12, 0)), new Set(), QUOTES), RangeError);
});

test('an A meta-event with no §C return is a pipeline defect, not a dropped observation', () => {
  assert.throws(() => matchControls({ a: [metaA('a1', ET(10, 5))], tape: tapeOf([trade()]), excludedEventIds: new Set(), quotes: [] }), RangeError);
});
