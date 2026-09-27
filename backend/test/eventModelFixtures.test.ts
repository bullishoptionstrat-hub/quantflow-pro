/**
 * The twenty golden event fixtures, driven through the real pipeline.
 *
 * Directive §10: no signal engine until the event lifecycle passes these. Each
 * fixture is a JSON file in `fixtures/events/` — data, not code, so a reader
 * can check a case without reading TypeScript — and each asserts the four
 * things the directive requires: the CANONICAL EVENT the builder produced, its
 * `availableAt`, its EFFECTIVE STATE in each view it names, and the SIGNAL
 * CONSEQUENCE (a revision status, a research-session verdict, or the side the
 * engine's own `inferSide` reaches with the causal quote).
 *
 * The pipeline is the one a historical import would run: build → append →
 * reorder buffer in arrival order → views and revisions. Nothing is mocked;
 * the side classifier is the vendored engine's, imported, so the fixtures
 * prove the consequence through the classifier that ships.
 *
 * Every fixture is also held to the invariants that must hold for ANY input
 * (INV-EVENT-001/003/004), so a fixture cannot pass by asserting only the
 * interesting part while something structural is broken.
 *
 * `MANIFEST.sha256` pins the fixtures' bytes. They are immutable in the only
 * sense a file can be: changing one is a visible, deliberate act that has to
 * update the manifest in the same diff.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { buildQuoteEvent, buildTradeEvent } from '../src/events/build';
import type { RawQuoteRecord, RawTradeRecord } from '../src/events/build';
import { EventLog } from '../src/events/eventLog';
import type { TapeView } from '../src/events/eventLog';
import { ReorderBuffer } from '../src/events/reorder';
import type { Emission } from '../src/events/reorder';
import { causalQuoteFor } from '../src/events/causalQuote';
import { RevisionLedger, reviseSignal } from '../src/events/signalRevision';
import type { SignalRevision } from '../src/events/signalRevision';
import type { MarketEvent, QuoteEvent, TradeReportEvent } from '../src/events/types';
import { NbboBook } from '../src/flow-engine/nbbo';
import { DEFAULT_CONFIG } from '../src/flow-engine/types';
import { H001_V2_SESSION_RULE, researchEligibility } from '../src/market/researchEligibility';
import { feedSessionAt } from '../src/market/feedSessions';
import { productSessionAt } from '../src/market/productSessions';

const DIR = join(__dirname, 'fixtures', 'events');

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

const files = readdirSync(DIR).filter((f) => f.endsWith('.json')).sort();
const fixtures: Array<{ file: string; f: Json }> = files.map((file) => ({
  file, f: JSON.parse(readFileSync(join(DIR, file), 'utf8')),
}));

const ms = (iso: string) => {
  const v = Date.parse(iso);
  assert.ok(!Number.isNaN(v), `unreadable instant in a fixture: ${iso}`);
  return v;
};

interface Run {
  byRef: Map<string, MarketEvent>;
  refOf: Map<string, string>;
  append: Map<string, string>;
  log: EventLog;
  buffer: ReorderBuffer;
  emissions: Emission[];
}

function run(f: Json): Run {
  const byRef = new Map<string, MarketEvent>();
  const refOf = new Map<string, string>();
  const built: Array<{ ref: string; e: MarketEvent }> = [];
  for (const r of f.records) {
    const { ref, type, ...rest } = r;
    const rec = { ...f.defaults, ...rest, instrument: rest.instrument ?? f.defaults.instrument };
    for (const k of ['eventTime', 'providerReceiveTime', 'quantflowReceiveTime']) {
      if (typeof rec[k] === 'string') rec[k] = ms(rec[k]);
    }
    const e = type === 'quote'
      ? buildQuoteEvent(rec as RawQuoteRecord)
      : buildTradeEvent(rec as RawTradeRecord);
    byRef.set(ref, e);
    if (!refOf.has(e.eventId)) refOf.set(e.eventId, ref);
    built.push({ ref, e });
  }
  // Arrival order is availableAt order; ties keep file order.
  const arrival = built
    .map((b, i) => ({ ...b, i }))
    .sort((a, b) => a.e.availableAt - b.e.availableAt || a.i - b.i);
  const log = new EventLog();
  const buffer = new ReorderBuffer({ allowedLatenessMs: f.reorder.allowedLatenessMs });
  const append = new Map<string, string>();
  const emissions: Emission[] = [];
  for (const { ref, e } of arrival) {
    const out = log.append(e);
    append.set(ref, out.status);
    if (out.status === 'APPENDED') emissions.push(...buffer.push(e));
  }
  emissions.push(...buffer.flush());
  return { byRef, refOf, append, log, buffer, emissions };
}

function viewOf(r: Run, asOf: string): TapeView {
  return asOf === 'FINAL' ? r.log.finalCorrected() : r.log.asKnownAt(ms(asOf));
}

const refs = (r: Run, ids: readonly string[]) => ids.map((id) => r.refOf.get(id) ?? id).sort();
const idOf = (r: Run, ref: string) => {
  const e = r.byRef.get(ref);
  assert.ok(e, `fixture names an unknown ref ${ref}`);
  return e.eventId;
};

function sideWith(trade: TradeReportEvent, quote: QuoteEvent | null): string {
  const book = new NbboBook();
  if (quote !== null && quote.bid !== null && quote.ask !== null) {
    book.onQuote({ contractSymbol: 'X', bid: quote.bid, ask: quote.ask, ts: quote.eventTime });
  }
  return book.inferSide('X', trade.price, trade.eventTime, DEFAULT_CONFIG.nbboMaxAgeMs);
}

test('the fixture set is the twenty cases §10 names, pinned by the manifest', () => {
  assert.deepEqual(fixtures.map(({ f }) => f.case), Array.from({ length: 20 }, (_, i) => i + 1));
  for (const { file, f } of fixtures) {
    assert.equal(f.schema, 'quantflow-event-fixture-v1', file);
    assert.equal(f.defaults.synthetic, true, `${file}: a fixture is not market data and must say so`);
  }
  const manifest = readFileSync(join(DIR, 'MANIFEST.sha256'), 'utf8').trim().split('\n')
    .map((l) => l.split(/\s+/)).map(([h, n]) => [n!, h!] as const);
  const actual = files.map((n) => [n, createHash('sha256').update(readFileSync(join(DIR, n))).digest('hex')] as const);
  assert.deepEqual(new Map(actual), new Map(manifest),
    'a fixture changed without its manifest line: fixtures are evidence, and changing one must be deliberate');
});

for (const { file, f } of fixtures) {
  test(`fixture ${String(f.case).padStart(2, '0')}: ${f.name}`, () => {
    const r = run(f);
    const x = f.expect;

    // ── Invariants that hold for every input ───────────────────────────────
    const appended = [...r.append.entries()].filter(([, s]) => s === 'APPENDED').map(([ref]) => idOf(r, ref));
    for (const e of r.byRef.values()) {
      assert.ok(e.availableAt >= e.eventTime, `${file}: an event knowable before it happened`);
      if (e.kind === 'TRADE_REPORT') {
        // INV-EVENT-003: every report carries an explicit lifecycle.
        assert.ok(['REGULAR', 'LATE_IN_SEQUENCE', 'LATE_OUT_OF_SEQUENCE', 'OPENING_LATE_IN_SEQUENCE',
          'OPENING_LATE_OUT_OF_SEQUENCE', 'UNKNOWN'].includes(e.reportLifecycle));
      }
    }
    for (const em of r.emissions) {
      // INV-EVENT-004: nothing is final before it could be known.
      assert.ok(em.finalizedAt >= em.event.availableAt, `${file}: ${em.kind} finalised before availableAt`);
    }
    assert.deepEqual(r.emissions.map((em) => em.event.eventId).sort(), [...appended].sort(),
      `${file}: every appended event is emitted exactly once, and nothing else is`);
    assert.deepEqual(r.log.events().map((e) => e.eventId).sort(), [...appended].sort());
    const final = r.log.finalCorrected();
    const finalTrades = new Set(final.trades.map((t) => t.event.eventId));
    for (const id of appended) {
      // INV-EVENT-001: a cancel never makes the original disappear.
      if (r.log.get(id)!.kind === 'TRADE_REPORT') assert.ok(finalTrades.has(id), `${file}: a trade vanished`);
    }
    const lastKnown = Math.max(...r.log.events().map((e) => e.availableAt));
    const atLast = r.log.asKnownAt(lastKnown);
    assert.deepEqual({ ...atLast, basis: null, asOf: null }, { ...final, basis: null, asOf: null },
      `${file}: FINAL_CORRECTED must be AS_KNOWN_AT(the last arrival)`);

    // ── Canonical events and availableAt ───────────────────────────────────
    for (const [ref, status] of Object.entries(x.append ?? {})) {
      assert.equal(r.append.get(ref), status, `${file}: append outcome of ${ref}`);
    }
    for (const group of x.sameEventId ?? []) {
      assert.equal(new Set(group.map((ref: string) => idOf(r, ref))).size, 1, `${file}: one identity for ${group}`);
    }
    for (const [ref, want] of Object.entries<Json>(x.events ?? {})) {
      const e = r.byRef.get(ref)! as Json;
      for (const [k, v] of Object.entries<Json>(want)) {
        if (k === 'availableAt') assert.equal(e.availableAt, ms(v), `${file}: ${ref}.availableAt`);
        else if (k === 'session') {
          assert.equal(e.sessionEvidence.normalized, v.normalized, `${file}: ${ref} session`);
          assert.equal(e.sessionEvidence.basis, v.basis, `${file}: ${ref} session basis`);
        } else assert.deepEqual(e[k], v, `${file}: ${ref}.${k}`);
      }
    }
    for (const [ref, price] of Object.entries<number>(x.storedPrice ?? {})) {
      assert.equal((r.log.get(idOf(r, ref)) as TradeReportEvent).price, price, `${file}: the stored ${ref} stands`);
    }

    // ── Effective state per view ───────────────────────────────────────────
    for (const v of x.views ?? []) {
      const view = viewOf(r, v.asOf);
      const got = Object.fromEntries(view.trades.map((t) => [r.refOf.get(t.event.eventId), t.state]));
      assert.deepEqual(got, v.trades, `${file}: trade states as of ${v.asOf}`);
      if (v.cancels !== undefined) {
        const byCancel = new Map(view.cancels.map((c) => [r.refOf.get(c.cancelEventId), c]));
        assert.deepEqual([...byCancel.keys()].sort(), Object.keys(v.cancels).sort(), `${file}: cancels as of ${v.asOf}`);
        for (const [ref, want] of Object.entries<Json>(v.cancels)) {
          const c = byCancel.get(ref)!;
          assert.equal(c.outcome, want.outcome, `${file}: ${ref} outcome — ${c.why}`);
          assert.equal(c.rule, want.rule, `${file}: ${ref} rule`);
          assert.equal(c.targetEventId === null ? null : r.refOf.get(c.targetEventId), want.target, `${file}: ${ref} target`);
          if (want.candidates) assert.deepEqual(refs(r, c.candidates), [...want.candidates].sort(), `${file}: ${ref} candidates`);
        }
      }
      if (v.quotes !== undefined) {
        assert.deepEqual(view.quotes.map((q) => r.refOf.get(q.eventId)), v.quotes, `${file}: quotes as of ${v.asOf}`);
      }
    }

    // ── Reordering ─────────────────────────────────────────────────────────
    const emitted = new Map(r.emissions.map((em) => [r.refOf.get(em.event.eventId), em]));
    for (const [ref, kind] of Object.entries(x.emissions ?? {})) {
      assert.equal(emitted.get(ref)?.kind, kind, `${file}: ${ref} emission`);
    }
    for (const [ref, late] of Object.entries<number>(x.lateByMs ?? {})) {
      const em = emitted.get(ref)!;
      assert.equal(em.kind, 'LATE_EVENT');
      assert.equal(em.kind === 'LATE_EVENT' ? em.lateByMs : null, late, `${file}: ${ref} lateness`);
    }
    if (x.diagnostics) assert.deepEqual(r.buffer.diagnostics().map((d) => d.kind), x.diagnostics);
    if (x.openGaps) assert.deepEqual(r.buffer.openGaps().map((g) => ({ from: g.from, to: g.to })), x.openGaps);
    for (const [at, gaps] of Object.entries<Json>(x.gapsOpenAt ?? {})) {
      assert.deepEqual(r.buffer.gapsOpenAt(ms(at)).map((g) => ({ from: g.from, to: g.to })), gaps, `${file}: gaps at ${at}`);
    }

    // ── Quote causality and the side the engine reaches ─────────────────────
    for (const c of x.causal ?? []) {
      const trade = r.byRef.get(c.trade) as TradeReportEvent;
      const got = causalQuoteFor(trade, final.quotes);
      assert.equal(got.status, c.status, `${file}: causal quote for ${c.trade}`);
      if (c.quote) assert.equal('quote' in got ? r.refOf.get(got.quote.eventId) : null, c.quote);
      for (const k of ['ageMs', 'book', 'finalAnswerDiffers', 'simultaneousExcluded', 'arrivedLaterExcluded']) {
        if (c[k] !== undefined) assert.equal((got as Json)[k], c[k], `${file}: causal ${k}`);
      }
      const usable = got.status === 'FOUND' ? got.quote : null;
      assert.equal(sideWith(trade, usable), c.side, `${file}: the engine's side for ${c.trade}`);
      for (const [q, side] of Object.entries<string>(c.sideWithQuote ?? {})) {
        assert.equal(sideWith(trade, r.byRef.get(q) as QuoteEvent), side, `${file}: counterfactual side with ${q}`);
      }
    }

    // ── Session authorities ────────────────────────────────────────────────
    for (const [ref, want] of Object.entries<Json>(x.research ?? {})) {
      const e = r.byRef.get(ref)!;
      const v = researchEligibility(e.sessionEvidence, e.eventTime, H001_V2_SESSION_RULE);
      assert.equal(v.eligibility, want.eligibility, `${file}: ${ref} research eligibility — ${v.why}`);
      assert.equal(v.basis, want.basis, `${file}: ${ref} eligibility basis`);
    }
    for (const [ref, state] of Object.entries(x.feed ?? {})) {
      assert.equal(feedSessionAt('OPRA', r.byRef.get(ref)!.eventTime).state, state, `${file}: ${ref} feed window`);
    }
    for (const [ref, state] of Object.entries(x.product ?? {})) {
      const e = r.byRef.get(ref)!;
      assert.equal(productSessionAt(e.instrument.underlying, e.eventTime).state, state, `${file}: ${ref} product session`);
    }

    // ── Signal consequences ────────────────────────────────────────────────
    const late = r.emissions.filter((em) => em.kind === 'LATE_EVENT').map((em) => em.event);
    const revisions: SignalRevision[] = [];
    for (const s of x.signals ?? []) {
      const evidence = s.evidence.map((ref: string) => r.byRef.get(ref)!);
      const view = viewOf(r, s.view);
      const rev = reviseSignal(
        {
          signalId: `${file}:signal`,
          evidenceEventIds: evidence.map((e: MarketEvent) => e.eventId),
          decidedAt: ms(s.decidedAt),
          underlying: evidence[0].instrument.underlying,
          firstEventAt: Math.min(...evidence.map((e: MarketEvent) => e.eventTime)),
          lastEventAt: Math.max(...evidence.map((e: MarketEvent) => e.eventTime)),
        },
        view,
        { finalityHorizonMs: s.finalityHorizonMs ?? 3_600_000, clusterGapMs: s.clusterGapMs ?? DEFAULT_CONFIG.sweepWindowMs },
        {
          lateEvents: late,
          openGaps: s.view === 'FINAL' ? r.buffer.openGaps() : r.buffer.gapsOpenAt(ms(s.view)),
        },
      );
      assert.equal(rev.status, s.status, `${file}: signal status as of ${s.view} — ${rev.why}`);
      assert.equal(rev.consequence.finalTapeStudies, s.finalTapeStudies, `${file}: final-tape consequence`);
      // It formed in real time: live-behaviour research always keeps it.
      assert.equal(rev.consequence.asKnownStudies, 'INCLUDE');
      for (const [k, field] of [['cancelledEvidence', 'cancelledEvidence'], ['disputedEvidence', 'disputedEvidence']] as const) {
        if (s[k]) assert.deepEqual(refs(r, rev[field].map((c) => c.eventId)), [...s[k]].sort(), `${file}: ${k}`);
      }
      if (s.lateEvidence) assert.deepEqual(refs(r, rev.lateEvidence), [...s.lateEvidence].sort(), `${file}: lateEvidence`);
      revisions.push(rev);
    }

    if (x.ledger) {
      const ledger = new RevisionLedger();
      for (const rev of revisions) ledger.record(rev);
      const history = ledger.history(`${file}:signal`);
      assert.deepEqual(history.map((h) => h.status), revisions.map((h) => h.status),
        'every revision is kept, in order — the original is never rewritten');
      assert.equal(history[0]!.status, 'PROVISIONAL');
      assert.throws(() => ledger.record(revisions[0]!), RangeError,
        'a reading from an earlier view must not follow a later one');
    }
  });
}
