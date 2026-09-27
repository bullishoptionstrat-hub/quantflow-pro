/**
 * An event's identity, and the raw content that identity is checked against.
 *
 * Identity comes from the provider when the provider gives one, and from the
 * record's content only when it gives nothing. That ordering is the point:
 *
 *   - With a provider id (or a sequence number in a stream scope), the same
 *     record re-imported gets the same `eventId`, so a re-import is idempotent;
 *     and a DIFFERENT record arriving under a reused id is detectable, because
 *     the log compares raw content under the id and calls a mismatch a
 *     conflict instead of overwriting.
 *   - With neither, identity IS the content. A re-import is still idempotent,
 *     but a changed record is just a different event and the conflict cannot
 *     be seen. That limit belongs to the data, and it is stated rather than
 *     papered over.
 *
 * "Raw content" is only what the provider delivered. Everything QuantFlow
 * derives — `availableAt`, the normalised session, the lifecycle, the status of
 * the rules that read a code — is left out, so a better reading of the
 * specification can reinterpret a record without changing what it IS. Local
 * bookkeeping is left out too: `quantflowReceiveTime` says when this capture
 * saw the record, not what the record says, and two captures of one market
 * record (a primary and a backup line; a live capture and a later historical
 * pull) must be recognised as one event.
 */
import { createHash } from 'crypto';
import type { MarketEvent } from './types';

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** An event before its id is assigned — the shape `eventIdOf` reads. */
export type EventDraft = DistributiveOmit<MarketEvent, 'eventId'>;

/**
 * Fixed-precision rendering, so floating-point noise cannot fork an identity.
 * Same rule as `persistence/identity.ts`: `-0` is `0`, and a non-finite value
 * is a distinct token rather than a `null` that would collide with a real one.
 */
function num(n: number | null | undefined): string | null {
  if (n === undefined || n === null) return null;
  if (!Number.isFinite(n)) return `NONFINITE:${String(n)}`;
  const fixed = n.toFixed(9);
  return fixed === '-0.000000000' ? '0.000000000' : fixed;
}

/** Canonical JSON of the fields the provider delivered, in a fixed key order. */
export function rawContentOf(e: EventDraft): string {
  const common = {
    v: 1,
    kind: e.kind,
    provider: e.provider,
    datasetId: e.datasetId,
    providerEventId: e.providerEventId ?? null,
    providerSequence: e.providerSequence ?? null,
    sequenceScope: e.sequenceScope ?? null,
    eventTime: num(e.eventTime),
    providerReceiveTime: num(e.providerReceiveTime),
    instrument: {
      underlying: e.instrument.underlying,
      expiry: e.instrument.expiry,
      strike: num(e.instrument.strike),
      right: e.instrument.right,
    },
    venue: e.venue ?? null,
    rawSessionIdentifier:
      e.sessionEvidence.rawSessionIdentifier === null
        ? null
        : String(e.sessionEvidence.rawSessionIdentifier),
    rawSaleConditions: e.sessionEvidence.rawSaleConditions,
    synthetic: e.synthetic,
    replay: e.replay,
  };
  switch (e.kind) {
    case 'TRADE_REPORT':
      return JSON.stringify({
        ...common,
        price: num(e.price),
        size: num(e.size),
        rawMessageType: e.rawMessageType,
        rawConditions: e.rawConditions,
      });
    case 'TRADE_CANCEL':
      return JSON.stringify({
        ...common,
        price: num(e.price),
        size: num(e.size),
        rawMessageType: e.rawMessageType,
        rawConditions: e.rawConditions,
        referencedProviderEventId: e.referencedProviderEventId ?? null,
      });
    case 'QUOTE':
      return JSON.stringify({
        ...common,
        bid: num(e.bid),
        ask: num(e.ask),
        bidSize: num(e.bidSize),
        askSize: num(e.askSize),
      });
  }
}

export function rawContentHashOf(e: EventDraft): string {
  return createHash('sha256').update(rawContentOf(e), 'utf8').digest('hex');
}

/** Which of the three identity bases applies, and the key it produces. */
export function identityKeyOf(e: EventDraft): { basis: 'PROVIDER_ID' | 'SEQUENCE' | 'CONTENT'; key: string } {
  // The provider and dataset are always part of the key: one vendor's id 42
  // is not another's, and a cancel from one feed can never name a trade in
  // another.
  if (e.providerEventId !== undefined) {
    return { basis: 'PROVIDER_ID', key: `id|${e.provider}|${e.datasetId}|${e.providerEventId}` };
  }
  if (e.providerSequence !== undefined) {
    return {
      basis: 'SEQUENCE',
      key: `seq|${e.provider}|${e.datasetId}|${e.sequenceScope ?? ''}|${e.providerSequence}`,
    };
  }
  return { basis: 'CONTENT', key: `content|${rawContentHashOf(e)}` };
}

export function eventIdOf(e: EventDraft): string {
  const { key } = identityKeyOf(e);
  return `ev_${createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 32)}`;
}
