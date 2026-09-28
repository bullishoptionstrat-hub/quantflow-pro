/**
 * The append-only market-event log, and the two tapes derived from it.
 *
 * Nothing in here edits or deletes an event. A cancel is appended like any
 * other event and the effect it has is DERIVED, per view:
 *
 *   AS_KNOWN_AT(t)   every event with availableAt <= t, cancels applied only
 *                    where they had arrived by t — what QuantFlow could
 *                    legitimately have believed at t. The live-decision replay.
 *   FINAL_CORRECTED  every event, every cancel. What the effective tape holds
 *                    after the corrections. Final market-history research.
 *
 * They are the same derivation at different horizons (FINAL is AS_KNOWN_AT(∞))
 * and neither is stored, so neither can overwrite the other. A trade removed
 * by a cancel is still in the FINAL view, marked CANCELLED with the cancel
 * that did it; it is still in `events()`; it is still in every earlier view.
 *
 * ── Resolving a cancel never guesses ──────────────────────────────────────────
 *
 * An OPRA-style cancel usually does not name its trade: it states a scope (the
 * last report, the opening report, the only report, or some previous report)
 * and restates the price and size. Each scope is resolved by a deterministic
 * rule, and every rule has an honest failure:
 *
 *   - a scope that points at several possible trades is AMBIGUOUS, never "the
 *     most recent one";
 *   - order that cannot be established — two reports in the same millisecond
 *     with no shared sequence — is treated as unknown, not tie-broken by id;
 *   - a restated price or size that disagrees with the positional target is a
 *     MISMATCH, not a cancel of the nearest match.
 *
 * An unresolved cancel does not vanish either. Every trade it could have
 * referred to is marked CANCEL_UNRESOLVED, so research can exclude them rather
 * than count a trade the market may have taken back. The dangerous failure is
 * a cancelled trade staying ACTIVE in a corrected tape, and it is the one this
 * design is shaped to prevent.
 *
 * Every rule here reads the code table's meanings, which are UNVERIFIED today
 * (semantics.ts says why). Each view reports the weakest standing of anything
 * it relied on, so a corrected tape built on an unverified reading of "CNCL"
 * says so on its face.
 */
import type { MarketEvent, QuoteEvent, TradeCancelEvent, TradeReportEvent } from './types';
import { eventIdOf, rawContentHashOf } from './eventId';
import { weakestStatus } from './semantics';
import type { SourceStatus } from './semantics';
import { marketDateOf } from '../flow-engine/calendar';

export class EventIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EventIdentityError';
  }
}

export type AppendOutcome =
  | { status: 'APPENDED'; eventId: string }
  /** Same identity, same raw content: a re-delivery. The stored event stands. */
  | { status: 'DUPLICATE_IDENTICAL'; eventId: string }
  /**
   * Same identity, DIFFERENT raw content. Recorded; the stored event stands.
   * Treating it as idempotent would silently accept a rewrite of the tape —
   * the same refusal `persistence/` makes for a HISTORY_COLLISION.
   */
  | { status: 'DUPLICATE_CONFLICT'; eventId: string; storedHash: string; incomingHash: string };

export interface DuplicateArrival {
  eventId: string;
  status: 'DUPLICATE_IDENTICAL' | 'DUPLICATE_CONFLICT';
  storedHash: string;
  incomingHash: string;
  storedAvailableAt: number;
  incomingAvailableAt: number;
}

export type TradeState =
  /** On the effective tape as far as this view knows. */
  | 'ACTIVE'
  /** Removed by a resolved cancel — present, marked, never deleted. */
  | 'CANCELLED'
  /** An unresolved cancel may refer to it. Neither state can be established. */
  | 'CANCEL_UNRESOLVED';

export interface TradeInView {
  event: TradeReportEvent;
  state: TradeState;
  /** The cancel that removed it, when `state` is CANCELLED. */
  cancelledBy?: string;
  /** Unresolved cancels that might refer to it. */
  disputedBy: string[];
}

export type CancelOutcome =
  | 'RESOLVED'
  | 'UNRESOLVED_REFERENCE_UNKNOWN'
  | 'UNRESOLVED_ALREADY_CANCELLED'
  | 'UNRESOLVED_NO_MATCH'
  | 'UNRESOLVED_AMBIGUOUS'
  | 'UNRESOLVED_RESTATEMENT_MISMATCH'
  | 'UNRESOLVED_INSUFFICIENT_RESTATEMENT'
  | 'UNRESOLVED_SCOPE_UNKNOWN'
  | 'UNRESOLVED_SCOPE_CONTRADICTION';

export type CancelRule = 'EXPLICIT_REFERENCE' | 'LAST' | 'OPENING' | 'ONLY' | 'PRICE_SIZE_MATCH';

export interface CancelResolution {
  cancelEventId: string;
  outcome: CancelOutcome;
  rule: CancelRule | null;
  targetEventId: string | null;
  /** Trades the cancel might refer to, when it could not be resolved. */
  candidates: string[];
  why: string;
}

export interface TapeView {
  basis: 'AS_KNOWN_AT' | 'FINAL_CORRECTED';
  /** The knowledge horizon, or null for FINAL_CORRECTED. */
  asOf: number | null;
  /** Every trade report known by the horizon, by event time. */
  trades: TradeInView[];
  /** Every cancel known by the horizon, in the order it was applied. */
  cancels: CancelResolution[];
  quotes: QuoteEvent[];
  /** Weakest standing of every code-table row and session rule relied on. */
  semanticsStatus: SourceStatus;
}

// ─── Order ───────────────────────────────────────────────────────────────────

/**
 * Where two events sit in the provider's REPORTING order: -1 before, 1 after,
 * 0 not established.
 *
 * A shared sequence scope is authoritative — it is the dissemination order,
 * which receipt stamps only approximate. Otherwise arrival (`availableAt`)
 * orders them. Event time never does: a late report has an early event time
 * and a late position in the report stream, which is the whole point of it.
 * Equal arrival with no shared sequence is 0, and callers must treat 0 as
 * "unknown" — tie-breaking by id would turn order uncertainty into order
 * certainty, which is INV-EVENT-005's prohibition.
 */
export function reportingOrder(a: MarketEvent, b: MarketEvent): -1 | 0 | 1 {
  if (
    a.sequenceScope !== undefined && a.sequenceScope === b.sequenceScope &&
    a.providerSequence !== undefined && b.providerSequence !== undefined
  ) {
    const x = BigInt(a.providerSequence);
    const y = BigInt(b.providerSequence);
    return x < y ? -1 : x > y ? 1 : 0;
  }
  if (a.availableAt !== b.availableAt) return a.availableAt < b.availableAt ? -1 : 1;
  return 0;
}

/** A total order for applying cancels: arrival, then sequence, then id. */
function applicationOrder(a: MarketEvent, b: MarketEvent): number {
  if (a.availableAt !== b.availableAt) return a.availableAt - b.availableAt;
  const sa = a.sequenceScope ?? '';
  const sb = b.sequenceScope ?? '';
  if (sa !== sb) return sa < sb ? -1 : 1;
  if (a.providerSequence !== undefined && b.providerSequence !== undefined) {
    const x = BigInt(a.providerSequence);
    const y = BigInt(b.providerSequence);
    if (x !== y) return x < y ? -1 : 1;
  }
  return a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0;
}

type Extreme<T> = { unique: true; item: T } | { unique: false; set: T[] };

/**
 * The single latest (or earliest) item in reporting order — or the set that
 * prevents there being one. An item is the unique extreme only if it is
 * STRICTLY after (before) every other; one order-unknown pair is enough to
 * make the answer ambiguous.
 */
function extremeOf<T extends MarketEvent>(items: readonly T[], dir: 'max' | 'min'): Extreme<T> {
  const beats = (a: T, b: T) => reportingOrder(a, b) === (dir === 'max' ? 1 : -1);
  const top = items.filter((a) => !items.some((b) => b !== a && beats(b, a)));
  if (top.length === 1) {
    const e = top[0]!;
    const unordered = items.filter((b) => b !== e && reportingOrder(e, b) === 0);
    if (unordered.length === 0) return { unique: true, item: e };
    return { unique: false, set: [e, ...unordered] };
  }
  return { unique: false, set: top };
}

const samePrice = (a: number, b: number) => Math.abs(a - b) < 1e-9;

// ─── The log ─────────────────────────────────────────────────────────────────

function deepFreeze<T>(o: T): T {
  if (o !== null && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o as Record<string, unknown>)) deepFreeze(v);
  }
  return o;
}

export class EventLog {
  private readonly byId = new Map<string, MarketEvent>();
  private readonly hashes = new Map<string, string>();
  private readonly appendOrder: string[] = [];
  private readonly dupes: DuplicateArrival[] = [];

  /**
   * Append one event. The stored copy is frozen, so "immutable" is a property
   * the runtime enforces rather than a convention a caller can forget.
   */
  append(e: MarketEvent): AppendOutcome {
    const expected = eventIdOf(e);
    if (e.eventId !== expected) {
      // An id that does not follow from the record means someone built the
      // event by hand, or changed it after it was built. Either way the
      // identity rule — and with it duplicate detection — would be void.
      throw new EventIdentityError(`event id ${e.eventId} does not match its record (${expected})`);
    }
    const incomingHash = rawContentHashOf(e);
    const stored = this.byId.get(e.eventId);
    if (stored === undefined) {
      this.byId.set(e.eventId, deepFreeze(structuredClone(e)));
      this.hashes.set(e.eventId, incomingHash);
      this.appendOrder.push(e.eventId);
      return { status: 'APPENDED', eventId: e.eventId };
    }
    const storedHash = this.hashes.get(e.eventId)!;
    const status = storedHash === incomingHash ? 'DUPLICATE_IDENTICAL' : 'DUPLICATE_CONFLICT';
    this.dupes.push({
      eventId: e.eventId, status, storedHash, incomingHash,
      storedAvailableAt: stored.availableAt, incomingAvailableAt: e.availableAt,
    });
    return status === 'DUPLICATE_IDENTICAL'
      ? { status, eventId: e.eventId }
      : { status, eventId: e.eventId, storedHash, incomingHash };
  }

  get(eventId: string): MarketEvent | undefined {
    return this.byId.get(eventId);
  }

  /** Every event, in append order. Nothing is ever removed from this list. */
  events(): MarketEvent[] {
    return this.appendOrder.map((id) => this.byId.get(id)!);
  }

  duplicates(): DuplicateArrival[] {
    return [...this.dupes];
  }

  asKnownAt(t: number): TapeView {
    if (Number.isNaN(t)) throw new RangeError('asKnownAt needs an instant');
    return this.view(t, 'AS_KNOWN_AT');
  }

  finalCorrected(): TapeView {
    return this.view(Number.POSITIVE_INFINITY, 'FINAL_CORRECTED');
  }

  private view(horizon: number, basis: TapeView['basis']): TapeView {
    const known = this.events().filter((e) => e.availableAt <= horizon);
    const trades = known.filter((e): e is TradeReportEvent => e.kind === 'TRADE_REPORT');
    const cancels = known.filter((e): e is TradeCancelEvent => e.kind === 'TRADE_CANCEL');
    const quotes = known.filter((e): e is QuoteEvent => e.kind === 'QUOTE');

    const state = new Map<string, { state: TradeState; cancelledBy?: string; disputedBy: string[] }>();
    for (const t of trades) state.set(t.eventId, { state: 'ACTIVE', disputedBy: [] });

    const resolutions: CancelResolution[] = [];
    for (const c of [...cancels].sort(applicationOrder)) {
      const r = resolveCancel(c, trades, (id) => state.get(id)!.state);
      resolutions.push(r);
      if (r.outcome === 'RESOLVED' && r.targetEventId !== null) {
        const s = state.get(r.targetEventId)!;
        s.state = 'CANCELLED';
        s.cancelledBy = c.eventId;
      } else {
        for (const id of r.candidates) {
          const s = state.get(id)!;
          if (s.state === 'ACTIVE') s.state = 'CANCEL_UNRESOLVED';
          s.disputedBy.push(c.eventId);
        }
      }
    }

    const statuses: SourceStatus[] = [];
    for (const e of known) {
      statuses.push(e.sessionEvidence.semanticsStatus);
      if (e.kind !== 'QUOTE') statuses.push(e.semanticsStatus);
    }

    return {
      basis,
      asOf: basis === 'FINAL_CORRECTED' ? null : horizon,
      trades: [...trades]
        .sort((a, b) => a.eventTime - b.eventTime || (a.eventId < b.eventId ? -1 : 1))
        .map((t) => ({ event: t, ...state.get(t.eventId)!, disputedBy: [...state.get(t.eventId)!.disputedBy] })),
      cancels: resolutions,
      quotes: [...quotes].sort((a, b) => a.eventTime - b.eventTime || (a.eventId < b.eventId ? -1 : 1)),
      semanticsStatus: weakestStatus(statuses),
    };
  }
}

// ─── Cancel resolution ───────────────────────────────────────────────────────

/**
 * The trades a cancel could possibly refer to: the same provider and dataset,
 * the same contract, the same venue when the cancel names one (a participant
 * cancels only its own reports), and the same market date.
 *
 * The date rule is a stated limit, not a claim about the specification: a
 * cancel dated the day after its trade — or a GTH session that crosses civil
 * midnight — comes out NO_MATCH, which is visible, rather than being matched
 * across days by a rule nothing here has read.
 */
function bookOf(c: TradeCancelEvent, trades: readonly TradeReportEvent[]): TradeReportEvent[] {
  const date = marketDateOf(c.eventTime);
  return trades.filter((t) =>
    t.provider === c.provider &&
    t.datasetId === c.datasetId &&
    t.instrument.underlying === c.instrument.underlying &&
    t.instrument.expiry === c.instrument.expiry &&
    t.instrument.strike === c.instrument.strike &&
    t.instrument.right === c.instrument.right &&
    (c.venue === undefined || t.venue === c.venue) &&
    date !== null && marketDateOf(t.eventTime) === date,
  );
}

export function resolveCancel(
  c: TradeCancelEvent,
  trades: readonly TradeReportEvent[],
  stateOf: (eventId: string) => TradeState,
): CancelResolution {
  const out = (
    outcome: CancelOutcome, rule: CancelRule | null, target: TradeReportEvent | null,
    candidates: readonly TradeReportEvent[], why: string,
  ): CancelResolution => ({
    cancelEventId: c.eventId, outcome, rule,
    targetEventId: target?.eventId ?? null,
    // A trade already cancelled is not at risk from this cancel.
    candidates: candidates.filter((t) => stateOf(t.eventId) !== 'CANCELLED').map((t) => t.eventId),
    why,
  });

  // An explicit reference is not a guess, whatever the scope says.
  if (c.referencedProviderEventId !== undefined) {
    const target = trades.find((t) =>
      t.provider === c.provider && t.datasetId === c.datasetId &&
      t.providerEventId === c.referencedProviderEventId);
    if (target === undefined) {
      return out('UNRESOLVED_REFERENCE_UNKNOWN', 'EXPLICIT_REFERENCE', null, [],
        `no trade with provider id ${c.referencedProviderEventId} is known by this horizon`);
    }
    if (stateOf(target.eventId) === 'CANCELLED') {
      return out('UNRESOLVED_ALREADY_CANCELLED', 'EXPLICIT_REFERENCE', null, [],
        `the referenced trade was already cancelled — a second cancel of one trade`);
    }
    return out('RESOLVED', 'EXPLICIT_REFERENCE', target, [], 'the provider named the trade');
  }

  const book = bookOf(c, trades);
  // Reports that were reported before this cancel, or whose order relative to
  // it cannot be established. A cancel cannot refer to a later report.
  const reported = book.filter((t) => reportingOrder(t, c) !== 1);
  const unordered = reported.filter((t) => reportingOrder(t, c) === 0);
  const live = reported.filter((t) => stateOf(t.eventId) !== 'CANCELLED');

  if (c.cancelScope === 'UNKNOWN') {
    return out('UNRESOLVED_SCOPE_UNKNOWN', null, null, live,
      'the cancel\'s codes do not establish which report it refers to');
  }
  if (reported.length === 0) {
    return out('UNRESOLVED_NO_MATCH', null, null, [],
      'no report of this contract precedes the cancel on this date and venue');
  }

  const restates = (t: TradeReportEvent) =>
    (c.price === undefined || samePrice(c.price, t.price)) &&
    (c.size === undefined || c.size === t.size);

  /**
   * The positional scopes share one tail. Positions are computed over every
   * REPORTED trade, cancelled or not, because the definitions speak of what
   * was reported; if the position lands on a trade already cancelled, this is
   * either a second cancel of it or means the next one, and nothing here can
   * say which — so the next one is disputed rather than silently kept.
   */
  const positional = (target: TradeReportEvent, rule: 'LAST' | 'OPENING' | 'ONLY'): CancelResolution => {
    const s = stateOf(target.eventId);
    if (s === 'CANCELLED') {
      const next = rule === 'ONLY' ? [] : (() => {
        const e = extremeOf(live, rule === 'LAST' ? 'max' : 'min');
        return e.unique ? [e.item] : e.set;
      })();
      return out('UNRESOLVED_AMBIGUOUS', rule, null, next,
        `the ${rule.toLowerCase()} report is already cancelled`);
    }
    if (s === 'CANCEL_UNRESOLVED') {
      return out('UNRESOLVED_AMBIGUOUS', rule, null, [target],
        `the ${rule.toLowerCase()} report may already have been cancelled by an unresolved cancel`);
    }
    if (!restates(target)) {
      return out('UNRESOLVED_RESTATEMENT_MISMATCH', rule, null, [target],
        `the cancel restates ${c.size ?? '?'} @ ${c.price ?? '?'} and the ${rule.toLowerCase()} ` +
        `report is ${target.size} @ ${target.price}`);
    }
    return out('RESOLVED', rule, target, [], `the ${rule.toLowerCase()} report of the contract`);
  };

  switch (c.cancelScope) {
    case 'LAST': {
      if (unordered.length > 0) {
        return out('UNRESOLVED_AMBIGUOUS', 'LAST', null, reported,
          'a report shares the cancel\'s arrival instant with no shared sequence, so which report was last is not established');
      }
      const e = extremeOf(reported, 'max');
      if (!e.unique) {
        return out('UNRESOLVED_AMBIGUOUS', 'LAST', null, e.set,
          'more than one report could be the last — their order is not established');
      }
      // A late report reported out of sequence is last in the report stream
      // and not the latest transaction; which of the two "last reported"
      // means is a reading of the specification nothing here has done.
      if (e.item.reportLifecycle === 'LATE_OUT_OF_SEQUENCE' || e.item.reportLifecycle === 'OPENING_LATE_OUT_OF_SEQUENCE') {
        const inSeq = reported.filter((t) => t !== e.item);
        const alt = inSeq.length ? extremeOf(inSeq, 'max') : null;
        const others = alt === null ? [] : alt.unique ? [alt.item] : alt.set;
        return out('UNRESOLVED_AMBIGUOUS', 'LAST', null, [e.item, ...others],
          'the last report is an out-of-sequence late report; "last reported" is not established between it and the latest in-sequence report');
      }
      return positional(e.item, 'LAST');
    }
    case 'OPENING': {
      // A late report OF the opening trade makes "the opening report" mean one
      // of two trades, and choosing is the guess this module does not make.
      const lateOpenings = reported.filter((t) =>
        t.reportLifecycle === 'OPENING_LATE_OUT_OF_SEQUENCE' || t.reportLifecycle === 'OPENING_LATE_IN_SEQUENCE');
      const e = extremeOf(reported, 'min');
      if (!e.unique) {
        return out('UNRESOLVED_AMBIGUOUS', 'OPENING', null, e.set,
          'more than one report could be the opening one — their order is not established');
      }
      if (lateOpenings.some((t) => t !== e.item)) {
        return out('UNRESOLVED_AMBIGUOUS', 'OPENING', null, [e.item, ...lateOpenings.filter((t) => t !== e.item)],
          'a late report of the opening trade exists beside the first-reported trade');
      }
      return positional(e.item, 'OPENING');
    }
    case 'ONLY': {
      if (reported.length > 1) {
        return out('UNRESOLVED_AMBIGUOUS', 'ONLY', null, reported,
          `the cancel says the report was the only one, and ${reported.length} were reported`);
      }
      return positional(reported[0]!, 'ONLY');
    }
    case 'PREVIOUS': {
      if (c.price === undefined || c.size === undefined) {
        // Without a restatement every live report is a candidate — which is
        // the honest size of what one unmatched cancel puts in doubt.
        return out('UNRESOLVED_INSUFFICIENT_RESTATEMENT', 'PRICE_SIZE_MATCH', null, live,
          'the cancel restates no price and size, and names no trade');
      }
      const matches = reported.filter((t) => stateOf(t.eventId) !== 'CANCELLED' && restates(t));
      if (matches.length === 0) {
        return out('UNRESOLVED_NO_MATCH', 'PRICE_SIZE_MATCH', null, [],
          `no live report of ${c.size} @ ${c.price} precedes the cancel`);
      }
      if (matches.length > 1) {
        return out('UNRESOLVED_AMBIGUOUS', 'PRICE_SIZE_MATCH', null, matches,
          `${matches.length} live reports of ${c.size} @ ${c.price} precede the cancel`);
      }
      const m = matches[0]!;
      if (stateOf(m.eventId) === 'CANCEL_UNRESOLVED') {
        return out('UNRESOLVED_AMBIGUOUS', 'PRICE_SIZE_MATCH', null, [m],
          'the only match may already have been cancelled by an unresolved cancel');
      }
      // The corroborated definition excludes "the last or opening report" —
      // a match that IS one of those contradicts the code it arrived with.
      if (reported.length > 1) {
        const first = extremeOf(reported, 'min');
        const last = extremeOf(reported, 'max');
        if ((first.unique && first.item === m) || (last.unique && last.item === m)) {
          return out('UNRESOLVED_SCOPE_CONTRADICTION', 'PRICE_SIZE_MATCH', null, [m],
            'the only match is the opening or last report, which this cancel type excludes');
        }
      }
      return out('RESOLVED', 'PRICE_SIZE_MATCH', m, [], `the only live report of ${c.size} @ ${c.price}`);
    }
  }
}
