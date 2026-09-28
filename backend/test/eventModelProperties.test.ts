/**
 * Event Model V2 beyond the twenty fixtures: the properties that must hold for
 * ANY input, and the edge cases each rule exists to refuse.
 *
 * The fixtures prove the cases the directive names. These prove the rules
 * those cases rest on — that the reorder buffer's lateness bound is exact,
 * that the two views are one derivation at two horizons, that identity is
 * stable under re-import and loud under a changed record — across thousands of
 * generated inputs rather than one hand-picked one. The generator is seeded,
 * so a failure reproduces.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MalformedRecordError, availabilityOf, buildQuoteEvent, buildTradeEvent, readCodes } from '../src/events/build';
import type { RawQuoteRecord, RawTradeRecord } from '../src/events/build';
import { EventIdentityError, EventLog, reportingOrder } from '../src/events/eventLog';
import { ReorderBuffer, canonicalOrder } from '../src/events/reorder';
import type { Emission } from '../src/events/reorder';
import { bookStateOf, causalQuoteFor } from '../src/events/causalQuote';
import { LookaheadEvidenceError, RevisionLedger, reviseSignal } from '../src/events/signalRevision';
import { OPRA_LAST_SALE_CODES, isAtLeast, weakestStatus } from '../src/events/semantics';
import type { MarketEvent, TradeCancelEvent, TradeReportEvent } from '../src/events/types';

// ─── A seeded generator ──────────────────────────────────────────────────────

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const T0 = Date.parse('2026-09-24T14:00:00.000Z');
const SPY = { underlying: 'SPY', expiry: '2026-10-16', strike: 550, right: 'C' as const };

function base(over: Partial<RawTradeRecord> = {}): RawTradeRecord {
  return {
    provider: 'fixture', datasetId: 'FIXTURE.OPRA.V1', sequenceScope: 'line-1:2026-09-24',
    eventTime: T0, providerReceiveTime: T0 + 4, instrument: SPY, venue: 'C',
    rawSessionIdentifier: 0, synthetic: true, replay: true, price: 2.15, size: 5, ...over,
  };
}
const trade = (over: Partial<RawTradeRecord>) => buildTradeEvent(base(over)) as TradeReportEvent;
const cancel = (over: Partial<RawTradeRecord>) => buildTradeEvent(base(over)) as TradeCancelEvent;

/** Random events with a bounded or unbounded arrival delay, in arrival order. */
function randomEvents(r: () => number, n: number, maxDelay: number): MarketEvent[] {
  const out: MarketEvent[] = [];
  for (let i = 0; i < n; i++) {
    const eventTime = T0 + Math.floor(r() * 5_000);
    out.push(trade({
      providerSequence: String(1000 + i),
      eventTime,
      providerReceiveTime: eventTime + Math.floor(r() * maxDelay),
      price: 1 + Math.floor(r() * 300) / 100,
      size: 1 + Math.floor(r() * 50),
    }));
  }
  return out.sort((a, b) => a.availableAt - b.availableAt);
}

function drive(events: readonly MarketEvent[], L: number): { emissions: Emission[]; releasedAtArrival: number[] } {
  const buf = new ReorderBuffer({ allowedLatenessMs: L });
  const emissions: Emission[] = [];
  const releasedAtArrival: number[] = [];
  for (const e of events) {
    releasedAtArrival.push(buf.released());
    emissions.push(...buf.push(e));
  }
  emissions.push(...buf.flush());
  return { emissions, releasedAtArrival };
}

// ─── Reordering ──────────────────────────────────────────────────────────────

test('reorder: a delay strictly below the allowed lateness is never late, and the output is fully ordered', () => {
  for (let seed = 1; seed <= 300; seed++) {
    const r = rng(seed);
    const L = 1 + Math.floor(r() * 2_000);
    const events = randomEvents(r, 40, L); // delay in [0, L)
    const { emissions } = drive(events, L);
    assert.equal(emissions.filter((e) => e.kind === 'LATE_EVENT').length, 0, `seed ${seed}`);
    assert.deepEqual(
      emissions.map((e) => e.event.eventId),
      [...events].sort(canonicalOrder).map((e) => e.eventId),
      `seed ${seed}: the released stream is the input in canonical order`,
    );
  }
});

test('reorder: with any delay, every event is emitted once, LATE exactly when its slot was already released', () => {
  for (let seed = 1; seed <= 300; seed++) {
    const r = rng(seed * 7919);
    const L = Math.floor(r() * 1_000);
    const events = randomEvents(r, 50, 6_000);
    const { emissions, releasedAtArrival } = drive(events, L);
    assert.deepEqual(emissions.map((e) => e.event.eventId).sort(), events.map((e) => e.eventId).sort(), `seed ${seed}`);
    const lateIds = new Set(emissions.filter((e) => e.kind === 'LATE_EVENT').map((e) => e.event.eventId));
    events.forEach((e, i) => {
      assert.equal(lateIds.has(e.eventId), e.eventTime <= releasedAtArrival[i]!,
        `seed ${seed}: ${e.eventId} late iff behind the released watermark`);
    });
    const ordered = emissions.filter((e) => e.kind === 'ORDERED').map((e) => e.event);
    for (let i = 1; i < ordered.length; i++) {
      assert.ok(canonicalOrder(ordered[i - 1]!, ordered[i]!) <= 0, `seed ${seed}: the ordered stream never goes back`);
    }
    for (const em of emissions) assert.ok(em.finalizedAt >= em.event.availableAt, 'INV-EVENT-004');
  }
});

test('reorder: equal event times ordered by nothing but id say so (INV-EVENT-005)', () => {
  const a = trade({ providerSequence: undefined, sequenceScope: undefined, price: 1.01 });
  const b = trade({ providerSequence: undefined, sequenceScope: undefined, price: 1.02 });
  const buf = new ReorderBuffer({ allowedLatenessMs: 1_000 });
  const out = [...buf.push(a), ...buf.push(b), ...buf.flush()].filter((e) => e.kind === 'ORDERED');
  assert.deepEqual(out.map((e) => e.kind === 'ORDERED' ? e.orderBasis : null), ['FIRST', 'TIE_BROKEN_BY_ID']);

  const c = trade({ providerSequence: '5' });
  const d = trade({ providerSequence: '6', price: 2.2 });
  const buf2 = new ReorderBuffer({ allowedLatenessMs: 1_000 });
  const out2 = [...buf2.push(c), ...buf2.push(d), ...buf2.flush()];
  assert.deepEqual(out2.map((e) => e.kind === 'ORDERED' ? e.orderBasis : null), ['FIRST', 'SEQUENCE']);
});

test('reorder: sequence repeats and arrival regressions are reported, not absorbed', () => {
  const buf = new ReorderBuffer({ allowedLatenessMs: 1_000 });
  buf.push(trade({ providerSequence: '10' }));
  buf.push(trade({ providerSequence: '11', price: 2 }));
  buf.push(trade({ providerSequence: '11', price: 3, providerReceiveTime: T0 + 2 }));
  assert.ok(buf.diagnostics().some((d) => d.kind === 'SEQUENCE_REPEATED'));
  assert.ok(buf.diagnostics().some((d) => d.kind === 'ARRIVAL_REGRESSION'));
  assert.throws(() => new ReorderBuffer({ allowedLatenessMs: -1 }), RangeError);
});

test('reorder: a sequence below the first one seen is not called a repeat', () => {
  // The buffer saw 10 first. 7 was never observed, so "repeated" would be a
  // claim about a message nothing here recorded; it may be one from before
  // the capture began.
  const buf = new ReorderBuffer({ allowedLatenessMs: 1_000 });
  buf.push(trade({ providerSequence: '10' }));
  buf.push(trade({ providerSequence: '7', price: 2 }));
  const kinds = buf.diagnostics().map((d) => d.kind);
  assert.ok(kinds.includes('SEQUENCE_BEFORE_BASELINE'));
  assert.ok(!kinds.includes('SEQUENCE_REPEATED'));
  assert.ok(!kinds.includes('SEQUENCE_GAP'), 'nothing before the baseline is claimed missing');
});

// ─── Identity ────────────────────────────────────────────────────────────────

test('identity: a re-import is the same event; a changed record under the same id is a conflict', () => {
  const a = trade({ providerSequence: '42' });
  assert.equal(trade({ providerSequence: '42' }).eventId, a.eventId);
  // Our own receipt clock is not part of what the record says.
  const recapture = trade({ providerSequence: '42', quantflowReceiveTime: T0 + 900 });
  assert.equal(recapture.eventId, a.eventId);
  const log = new EventLog();
  assert.equal(log.append(a).status, 'APPENDED');
  assert.equal(log.append(recapture).status, 'DUPLICATE_IDENTICAL');
  assert.equal(log.append(trade({ providerSequence: '42', price: 9 })).status, 'DUPLICATE_CONFLICT');
  assert.equal(log.events().length, 1);
  assert.equal((log.get(a.eventId) as TradeReportEvent).price, 2.15);
  // "007" and "7" are one slot, not two identities.
  assert.equal(trade({ providerSequence: '007' }).eventId, trade({ providerSequence: '7' }).eventId);
  // With no provider identity at all, identity is the content.
  const x = trade({ providerSequence: undefined });
  assert.notEqual(trade({ providerSequence: undefined, price: 2.16 }).eventId, x.eventId);
});

test('identity: an event whose id does not follow from its record is refused', () => {
  const a = trade({ providerSequence: '1' });
  const log = new EventLog();
  assert.throws(() => log.append({ ...a, eventId: 'ev_handmade' }), EventIdentityError);
  // A content-identified event edited after it was built no longer matches its id.
  const b = trade({ providerSequence: undefined });
  assert.throws(() => log.append({ ...b, price: 3 }), EventIdentityError);
});

test('immutability: the stored event cannot be edited, and the caller\'s copy is not frozen', () => {
  const a = trade({ providerSequence: '1' });
  const log = new EventLog();
  log.append(a);
  const stored = log.get(a.eventId) as TradeReportEvent;
  // `Reflect.set` reports the refusal in any mode; a plain assignment only
  // throws under strict mode, which a test runner does not guarantee.
  assert.equal(Reflect.set(stored, 'price', 99), false);
  assert.equal(Reflect.set(stored.instrument, 'strike', 1), false);
  assert.equal(Reflect.set(stored.sessionEvidence.rawSaleConditions, 0, 'v'), false);
  assert.equal(stored.price, 2.15);
  assert.equal(Object.isFrozen(a), false, 'the log froze its own copy, not the caller\'s object');
});

// ─── Views ───────────────────────────────────────────────────────────────────

test('views: AS_KNOWN_AT(t) holds exactly what had arrived by t, and FINAL is AS_KNOWN_AT(∞)', () => {
  for (let seed = 1; seed <= 150; seed++) {
    const r = rng(seed * 104729);
    const log = new EventLog();
    const trades: TradeReportEvent[] = [];
    for (let i = 0; i < 25; i++) {
      const eventTime = T0 + i * 100;
      const t = trade({ providerEventId: `p${i}`, providerSequence: undefined, eventTime, providerReceiveTime: eventTime + Math.floor(r() * 3_000) });
      trades.push(t);
      log.append(t);
      if (r() < 0.3) {
        const target = trades[Math.floor(r() * trades.length)]!;
        log.append(cancel({
          providerEventId: `c${i}`, providerSequence: undefined, rawMessageType: 'CANC',
          referencedProviderEventId: target.providerEventId, eventTime: eventTime + 50,
          providerReceiveTime: eventTime + 50 + Math.floor(r() * 3_000), price: undefined, size: undefined,
        }));
      }
    }
    const all = log.events();
    let prevCancelled = new Set<string>();
    for (const t of [...new Set(all.map((e) => e.availableAt))].sort((a, b) => a - b)) {
      const v = log.asKnownAt(t);
      assert.deepEqual(
        new Set([...v.trades.map((x) => x.event.eventId), ...v.quotes.map((q) => q.eventId)]),
        new Set(all.filter((e) => e.availableAt <= t && e.kind !== 'TRADE_CANCEL').map((e) => e.eventId)),
        `seed ${seed}: nothing from after the horizon, nothing missing from before it`,
      );
      // With only explicit references, knowledge only accumulates: a trade
      // once cancelled stays cancelled in every later view.
      const cancelled = new Set(v.trades.filter((x) => x.state === 'CANCELLED').map((x) => x.event.eventId));
      for (const id of prevCancelled) assert.ok(cancelled.has(id), `seed ${seed}: a cancellation was forgotten`);
      prevCancelled = cancelled;
    }
    const final = log.finalCorrected();
    const last = log.asKnownAt(Math.max(...all.map((e) => e.availableAt)));
    assert.deepEqual({ ...final, basis: null, asOf: null }, { ...last, basis: null, asOf: null });
    assert.equal(final.trades.length, trades.length, 'INV-EVENT-001: no trade disappears');
  }
});

test('views: a view reports the weakest standing of anything it relied on, and nothing here is verified', () => {
  const log = new EventLog();
  log.append(trade({ providerSequence: '1' }));
  assert.equal(log.finalCorrected().semanticsStatus, 'UNVERIFIED');
  assert.equal(new EventLog().finalCorrected().semanticsStatus, 'UNVERIFIED', 'an empty view is not vacuously verified');
  // The research gate the directive asks for: no dataset read through this
  // table is analysis-ready while any row it uses is below PRIMARY_VERIFIED.
  for (const row of OPRA_LAST_SALE_CODES) {
    assert.ok(!isAtLeast(row.status, 'PRIMARY_VERIFIED'), `${row.code} claims a verification nobody performed`);
  }
  assert.equal(weakestStatus(['PRIMARY_VERIFIED', 'SEARCH_ONLY']), 'SEARCH_ONLY');
});

// ─── Cancel resolution: every honest failure ─────────────────────────────────

function tape(...events: MarketEvent[]) {
  const log = new EventLog();
  for (const e of events) log.append(e);
  return log.finalCorrected();
}
const stateOf = (v: ReturnType<typeof tape>, e: MarketEvent) => v.trades.find((t) => t.event.eventId === e.eventId)!.state;

test('cancel: order that cannot be established is not tie-broken (INV-EVENT-005)', () => {
  // Two reports arriving in the same millisecond with no shared sequence: which
  // was last is not established, so a CNCL disputes both.
  const a = trade({ providerSequence: undefined, sequenceScope: undefined, price: 1.1 });
  const b = trade({ providerSequence: undefined, sequenceScope: undefined, price: 1.2 });
  const c = cancel({ providerSequence: undefined, sequenceScope: undefined, rawMessageType: 'CNCL', price: 1.2, size: 5, eventTime: T0 + 10, providerReceiveTime: T0 + 20 });
  const v = tape(a, b, c);
  assert.equal(v.cancels[0]!.outcome, 'UNRESOLVED_AMBIGUOUS');
  assert.deepEqual([stateOf(v, a), stateOf(v, b)], ['CANCEL_UNRESOLVED', 'CANCEL_UNRESOLVED']);
  // The same reports with a shared sequence are ordered, and the cancel resolves.
  const a2 = trade({ providerSequence: '1', price: 1.1 });
  const b2 = trade({ providerSequence: '2', price: 1.2 });
  const c2 = cancel({ providerSequence: '3', rawMessageType: 'CNCL', price: 1.2, size: 5, eventTime: T0 + 10, providerReceiveTime: T0 + 20 });
  const v2 = tape(a2, b2, c2);
  assert.equal(v2.cancels[0]!.outcome, 'RESOLVED');
  assert.equal(stateOf(v2, b2), 'CANCELLED');
  assert.equal(reportingOrder(a, b), 0);
});

test('cancel: every scope refuses to guess', () => {
  const t1 = trade({ providerSequence: '1', price: 1.0, size: 5 });
  const t2 = trade({ providerSequence: '2', price: 1.0, size: 5, eventTime: T0 + 1_000, providerReceiveTime: T0 + 1_004 });
  const t3 = trade({ providerSequence: '3', price: 1.5, size: 5, eventTime: T0 + 2_000, providerReceiveTime: T0 + 2_004 });
  const at = { eventTime: T0 + 9_000, providerReceiveTime: T0 + 9_004 };

  // PREVIOUS with two identical matches: ambiguous, both disputed.
  let v = tape(t1, t2, t3, cancel({ providerSequence: '4', rawMessageType: 'CANC', price: 1.0, size: 5, ...at }));
  assert.equal(v.cancels[0]!.outcome, 'UNRESOLVED_AMBIGUOUS');
  assert.deepEqual([stateOf(v, t1), stateOf(v, t2), stateOf(v, t3)], ['CANCEL_UNRESOLVED', 'CANCEL_UNRESOLVED', 'ACTIVE']);

  // PREVIOUS whose only match is the last report contradicts its own code.
  v = tape(t1, t2, t3, cancel({ providerSequence: '4', rawMessageType: 'CANC', price: 1.5, size: 5, ...at }));
  assert.equal(v.cancels[0]!.outcome, 'UNRESOLVED_SCOPE_CONTRADICTION');

  // PREVIOUS with no restatement puts every live report in doubt.
  v = tape(t1, t2, t3, cancel({ providerSequence: '4', rawMessageType: 'CANC', price: undefined, size: undefined, ...at }));
  assert.equal(v.cancels[0]!.outcome, 'UNRESOLVED_INSUFFICIENT_RESTATEMENT');
  assert.equal(v.trades.filter((t) => t.state === 'CANCEL_UNRESOLVED').length, 3);

  // LAST whose restatement disagrees with the last report: a mismatch, not the nearest match.
  v = tape(t1, t2, t3, cancel({ providerSequence: '4', rawMessageType: 'CNCL', price: 1.0, size: 5, ...at }));
  assert.equal(v.cancels[0]!.outcome, 'UNRESOLVED_RESTATEMENT_MISMATCH');
  assert.equal(stateOf(v, t3), 'CANCEL_UNRESOLVED');

  // ONLY when three were reported.
  v = tape(t1, t2, t3, cancel({ providerSequence: '4', rawMessageType: 'CNOL', ...at }));
  assert.equal(v.cancels[0]!.outcome, 'UNRESOLVED_AMBIGUOUS');

  // A second CNCL: the last report is already cancelled, so the next one is disputed rather than taken.
  v = tape(t1, t2, t3,
    cancel({ providerSequence: '4', rawMessageType: 'CNCL', price: 1.5, size: 5, ...at }),
    cancel({ providerSequence: '5', rawMessageType: 'CNCL', eventTime: T0 + 9_500, providerReceiveTime: T0 + 9_504 }));
  assert.deepEqual(v.cancels.map((c) => c.outcome), ['RESOLVED', 'UNRESOLVED_AMBIGUOUS']);
  assert.deepEqual([stateOf(v, t2), stateOf(v, t3)], ['CANCEL_UNRESOLVED', 'CANCELLED']);

  // A cancel from another venue, or dated another day, matches nothing here.
  v = tape(t1, cancel({ providerSequence: '4', rawMessageType: 'CNOL', venue: 'X', ...at }));
  assert.equal(v.cancels[0]!.outcome, 'UNRESOLVED_NO_MATCH');
  v = tape(t1, cancel({ providerSequence: '4', rawMessageType: 'CNOL', eventTime: T0 + 86_400_000, providerReceiveTime: T0 + 86_400_004 }));
  assert.equal(v.cancels[0]!.outcome, 'UNRESOLVED_NO_MATCH');

  // An unknown scope never resolves positionally.
  v = tape(t1, cancel({ providerSequence: '4', rawMessageType: 'CNCL', rawConditions: ['ZZZZ'], ...at }));
  assert.equal(v.cancels[0]!.outcome, 'UNRESOLVED_SCOPE_UNKNOWN');
  assert.equal(stateOf(v, t1), 'CANCEL_UNRESOLVED');
});

test('cancel: an explicit reference is not a guess, and resolves once its trade is known', () => {
  const t = trade({ providerEventId: 'X1', providerSequence: undefined, providerReceiveTime: T0 + 5_000 });
  const c = cancel({ providerEventId: 'X2', providerSequence: undefined, rawMessageType: 'CANC', referencedProviderEventId: 'X1',
    eventTime: T0 + 100, providerReceiveTime: T0 + 200, price: undefined, size: undefined });
  const log = new EventLog();
  log.append(t);
  log.append(c);
  // The cancel arrived before the trade it names.
  const early = log.asKnownAt(T0 + 300);
  assert.equal(early.cancels[0]!.outcome, 'UNRESOLVED_REFERENCE_UNKNOWN');
  assert.equal(log.finalCorrected().cancels[0]!.outcome, 'RESOLVED');
  assert.equal(log.finalCorrected().trades[0]!.state, 'CANCELLED');
  // A second cancel of the same trade is reported, not silently absorbed.
  log.append(cancel({ providerEventId: 'X3', providerSequence: undefined, rawMessageType: 'CANC', referencedProviderEventId: 'X1',
    eventTime: T0 + 6_000, providerReceiveTime: T0 + 6_010, price: undefined, size: undefined }));
  assert.equal(log.finalCorrected().cancels[1]!.outcome, 'UNRESOLVED_ALREADY_CANCELLED');
});

test('cancel: a late out-of-sequence report makes "last reported" ambiguous', () => {
  const t1 = trade({ providerSequence: '1' });
  const t2 = trade({ providerSequence: '2', rawMessageType: 'OSEQ', eventTime: T0 - 60_000, providerReceiveTime: T0 + 1_000, price: 3, size: 5 });
  const c = cancel({ providerSequence: '3', rawMessageType: 'CNCL', eventTime: T0 + 2_000, providerReceiveTime: T0 + 2_004 });
  const v = tape(t1, t2, c);
  assert.equal(v.cancels[0]!.outcome, 'UNRESOLVED_AMBIGUOUS');
  assert.deepEqual([stateOf(v, t1), stateOf(v, t2)], ['CANCEL_UNRESOLVED', 'CANCEL_UNRESOLVED']);
});

// ─── Codes, availability, validation ─────────────────────────────────────────

test('codes: contradictions and unknowns are UNKNOWN, never REGULAR', () => {
  assert.equal(readCodes(null).lifecycle, 'REGULAR');
  assert.equal(readCodes('LATE', ['OSEQ']).lifecycle, 'UNKNOWN', 'two mutually exclusive lifecycle codes');
  assert.equal(readCodes('ZZZZ').lifecycle, 'UNKNOWN');
  assert.deepEqual(readCodes('ZZZZ').uninterpretedCodes, ['ZZZZ']);
  assert.equal(readCodes('AUTO').lifecycle, 'UNKNOWN', 'a recognised qualifier with no asserted meaning');
  assert.equal(readCodes('ISOI').iso, true);
  assert.equal(readCodes('SPRD').complex, true);
  assert.equal(readCodes('ZZZZ').iso, null, 'an unknown code might have been the ISO marker');
  assert.equal(readCodes('CANC', ['CNCL']).cancelScope, 'UNKNOWN', 'two cancel scopes name different trades');
  assert.equal(readCodes('v').lifecycle, 'REGULAR', 'the session marker is not a lifecycle code');
});

test('availableAt: the latest clock, the strongest basis, and skew made visible', () => {
  assert.deepEqual(availabilityOf(T0), { availableAt: T0, availableAtBasis: 'EVENT_TIME_LOWER_BOUND', clockInversion: false });
  assert.deepEqual(availabilityOf(T0, T0 + 5), { availableAt: T0 + 5, availableAtBasis: 'PROVIDER_RECEIPT', clockInversion: false });
  assert.deepEqual(availabilityOf(T0, T0 + 5, T0 + 9), { availableAt: T0 + 9, availableAtBasis: 'QUANTFLOW_RECEIPT', clockInversion: false });
  // A receipt stamped before the event is skew: never earlier than the event.
  assert.deepEqual(availabilityOf(T0, T0 - 3), { availableAt: T0, availableAtBasis: 'PROVIDER_RECEIPT', clockInversion: true });
  // Our receipt before the provider's: the later one wins, and it is flagged.
  assert.deepEqual(availabilityOf(T0, T0 + 9, T0 + 5), { availableAt: T0 + 9, availableAtBasis: 'QUANTFLOW_RECEIPT', clockInversion: true });
});

test('builder: a record that cannot describe a trade is refused with its reason', () => {
  const bad: Array<[Partial<RawTradeRecord>, RegExp]> = [
    [{ instrument: { ...SPY, strike: 0 } }, /strike/],
    [{ instrument: { ...SPY, expiry: '20261016' } }, /expiry/],
    [{ instrument: { ...SPY, right: 'X' as 'C' } }, /right/],
    [{ price: -1 }, /price/],
    [{ size: 0 }, /size/],
    [{ providerSequence: '7.5' }, /sequence/],
    [{ eventTime: Number.NaN }, /event time/],
    [{ price: undefined }, /price/],
  ];
  for (const [over, why] of bad) {
    assert.throws(() => buildTradeEvent(base(over)), (e: unknown) => e instanceof MalformedRecordError && why.test(e.message));
  }
  assert.equal(trade({ price: 0 }).price, 0, 'a zero price is data (a cabinet trade), not a defect');
  const q: RawQuoteRecord = { ...base(), bid: null, ask: 2.2, bidSize: null, askSize: 10 };
  assert.equal(buildQuoteEvent(q).bid, null, 'a missing bid stays missing');
  // The same record as an adapter parsing JSON delivers it: the key is simply
  // absent. The typed case above could never catch this — the type forbids
  // `undefined`, JSON.parse does not — and the book read the hole as a price.
  const absent = JSON.parse(JSON.stringify({ ...base(), ask: 2.2, askSize: 10 })) as RawQuoteRecord;
  const one = buildQuoteEvent(absent);
  assert.equal(one.bid, null);
  assert.equal(one.bidSize, null);
  assert.equal(bookStateOf(one), 'ONE_SIDED');
  const none = JSON.parse(JSON.stringify(base())) as RawQuoteRecord;
  assert.equal(bookStateOf(buildQuoteEvent(none)), 'EMPTY', 'no side at all is an empty book, not a locked one');
  assert.equal(buildQuoteEvent(absent).eventId, buildQuoteEvent({ ...absent, bid: null, bidSize: null }).eventId,
    'absent and null are one record');
});

// ─── Causal quotes and revisions ─────────────────────────────────────────────

test('causal quote: the latest book is the book, even when it is crossed', () => {
  const t = trade({ providerSequence: '9', eventTime: T0 + 1_000, providerReceiveTime: T0 + 1_004, price: 2.2 });
  const older = buildQuoteEvent({ ...base(), providerSequence: '7', eventTime: T0 + 100, providerReceiveTime: T0 + 102, bid: 2.1, ask: 2.2, bidSize: 1, askSize: 1 });
  const crossed = buildQuoteEvent({ ...base(), providerSequence: '8', eventTime: T0 + 900, providerReceiveTime: T0 + 902, bid: 2.3, ask: 2.2, bidSize: 1, askSize: 1 });
  const got = causalQuoteFor(t, [older, crossed]);
  assert.equal(got.status, 'FOUND');
  assert.equal(got.status === 'FOUND' && got.book, 'CROSSED');

  const twin = buildQuoteEvent({ ...base(), providerSequence: '10', eventTime: T0 + 900, providerReceiveTime: T0 + 903, bid: 2.0, ask: 2.4, bidSize: 1, askSize: 1 });
  assert.equal(causalQuoteFor(t, [crossed, twin]).status, 'AMBIGUOUS_SIMULTANEOUS_QUOTES');

  const arrivesLater = buildQuoteEvent({ ...base(), providerSequence: '11', eventTime: T0 + 950, providerReceiveTime: T0 + 5_000, bid: 2.15, ask: 2.25, bidSize: 1, askSize: 1 });
  const g2 = causalQuoteFor(t, [older, arrivesLater]);
  assert.equal(g2.status === 'FOUND' && g2.finalAnswerDiffers, true, 'the live book and the final book differ');

  const otherProvider = buildQuoteEvent({ ...base(), provider: 'other', providerSequence: '12', eventTime: T0 + 990, providerReceiveTime: T0 + 991, bid: 2.1, ask: 2.2, bidSize: 1, askSize: 1 });
  assert.equal(causalQuoteFor(t, [otherProvider]).status, 'NONE_PRIOR', 'another provider\'s clock is not this trade\'s');
});

test('revision: lookahead evidence, a view before the decision, and a stale ledger entry are refused', () => {
  const t = trade({ providerSequence: '1', providerReceiveTime: T0 + 5_000 });
  const log = new EventLog();
  log.append(t);
  const sig = { signalId: 's', evidenceEventIds: [t.eventId], decidedAt: T0 + 1_000, underlying: 'SPY', firstEventAt: T0, lastEventAt: T0 };
  const policy = { finalityHorizonMs: 60_000, clusterGapMs: 100 };
  assert.throws(() => reviseSignal(sig, log.finalCorrected(), policy), LookaheadEvidenceError);
  const ok = { ...sig, decidedAt: T0 + 6_000 };
  assert.throws(() => reviseSignal(ok, log.asKnownAt(T0 + 5_500), policy), RangeError);
  const missing = reviseSignal({ ...ok, evidenceEventIds: ['ev_nope'] }, log.finalCorrected(), policy);
  assert.equal(missing.status, 'EVIDENCE_UNRESOLVED');
  const ledger = new RevisionLedger();
  const later = reviseSignal(ok, log.finalCorrected(), policy);
  const earlier = reviseSignal(ok, log.asKnownAt(T0 + 7_000), policy);
  ledger.record(earlier);
  ledger.record(later);
  assert.throws(() => ledger.record(earlier), RangeError);
  assert.equal(ledger.history('s').length, 2);
});

test('revision: a signal\'s own evidence is never late evidence against it', () => {
  const t = trade({ providerSequence: '1' });
  const log = new EventLog();
  log.append(t);
  const sig = { signalId: 's', evidenceEventIds: [t.eventId], decidedAt: t.availableAt, underlying: 'SPY', firstEventAt: T0, lastEventAt: T0 };
  const rev = reviseSignal(sig, log.finalCorrected(), { finalityHorizonMs: 0, clusterGapMs: 100 }, { lateEvents: [t] });
  assert.equal(rev.status, 'FINAL');
  assert.deepEqual(rev.lateEvidence, []);
});

test('revision: a sequence gap counts only on the evidence\'s own stream, and only once it was known', () => {
  const t = trade({ providerSequence: '10', sequenceScope: 'line-1:2026-09-24' });
  const log = new EventLog();
  log.append(t);
  const sig = { signalId: 's', evidenceEventIds: [t.eventId], decidedAt: t.availableAt + 500, underlying: 'SPY', firstEventAt: T0, lastEventAt: T0 };
  const policy = { finalityHorizonMs: 0, clusterGapMs: 100 };
  const gap = (scope: string, revealedAt: number) => ({
    scope, from: '11', to: '11', count: '1', openedAfterAvailableAt: t.availableAt, revealedAtAvailableAt: revealedAt,
  });
  // A hole on another line cannot have held this contract's evidence.
  assert.equal(reviseSignal(sig, log.finalCorrected(), policy, { openGaps: [gap('line-2:2026-09-24', T0 + 200)] }).status, 'FINAL');
  // The same hole on the evidence's line does.
  assert.equal(reviseSignal(sig, log.finalCorrected(), policy, { openGaps: [gap('line-1:2026-09-24', T0 + 200)] }).status, 'EVIDENCE_UNRESOLVED');
  // A caller passing the END-STATE gaps to an as-known view must not leak a
  // hole into a moment before anyone could have seen it.
  const asKnown = log.asKnownAt(t.availableAt + 1_000);
  assert.equal(reviseSignal(sig, asKnown, { ...policy, finalityHorizonMs: 60_000 },
    { openGaps: [gap('line-1:2026-09-24', t.availableAt + 50_000)] }).status, 'PROVISIONAL');
});
