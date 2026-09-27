/**
 * Reading a trade's trading session from what the provider actually sent.
 *
 * Two encodings coexist during a migration the operator's audit describes: a
 * dedicated Trading Session Identifier (0 = regular, 1 = extended) and a legacy
 * sale condition `v` marking extended-hours trades from participants that have
 * not migrated. **Neither encoding was read in a primary document** — the OPRA
 * notices are behind this environment's egress policy, and a search on
 * 2026-09-27 confirmed OPRA is carrying extended-hours data but surfaced no
 * detail of the identifier's values. So every rule below is UNVERIFIED, and
 * every evidence object says so in `semanticsStatus`.
 *
 * The rules are the part that does not depend on the encoding details:
 *
 *   - **The provider's own session field outranks everything.** Clock inference
 *     never overrides evidence the provider sent.
 *   - **The absence of the legacy code is not evidence of a regular session.** A
 *     migrated participant sends no `v` for extended trades either; reading
 *     "no v" as "regular" would put every migrated extended-hours print into
 *     a regular-hours sample.
 *   - **Disagreement is `CONFLICT`, never a silent preference.** If the
 *     identifier says regular and the condition says extended, one of them is
 *     wrong and nothing here can say which.
 *   - **An unreadable identifier is `UNKNOWN`,** and the legacy condition does
 *     not get to overrule a primary field the parser could not read.
 */
import type { SessionEvidence } from './types';
import { OPRA_SEMANTICS, weakestStatus } from './semantics';
import type { ProviderSemantics } from './semantics';
import { marketDateOf, sessionOn } from '../flow-engine/calendar';
import { minutesEt } from '../market/civil';

/**
 * @param rawSessionIdentifier the provider's own session field, as delivered
 * @param rawCodes every transaction/sale-condition code on the record, as
 *   delivered — the legacy marker is found by the code table, not by a literal
 *   here, so the one place that says what `v` means is the table
 */
export function readSessionEvidence(
  rawSessionIdentifier: string | number | null | undefined,
  rawCodes: readonly string[] = [],
  semantics: ProviderSemantics = OPRA_SEMANTICS,
): SessionEvidence {
  const table = semantics.codes;
  const encoding = semantics.session;
  const raw = rawSessionIdentifier ?? null;
  const conditions = [...rawCodes];
  const legacyRows = conditions
    .map((c) => table.get(c))
    .filter((r) => r !== undefined && r.meaning.kind === 'SESSION_QUALIFIER');
  const legacyExtended = legacyRows.length > 0;
  const legacyStatuses = legacyRows.map((r) => r!.status);

  const base = { rawSessionIdentifier: raw, rawSaleConditions: conditions };

  if (raw !== null) {
    const key = String(raw).trim();
    // Own properties only: a prototype key such as "constructor" is not a value.
    const fromId = Object.prototype.hasOwnProperty.call(encoding.values, key) ? encoding.values[key] : undefined;
    if (fromId === undefined) {
      // The provider said something and we cannot read it. The legacy code is
      // not allowed to overrule a primary field that was present but unread,
      // and nothing was established, so nothing is claimed about the rules.
      return {
        ...base, normalized: 'UNKNOWN', basis: 'PROVIDER_SESSION_IDENTIFIER',
        semanticsStatus: 'UNVERIFIED',
      };
    }
    if (legacyExtended) {
      const semanticsStatus = weakestStatus([encoding.status, ...legacyStatuses]);
      return fromId === 'EXTENDED'
        ? { ...base, normalized: 'EXTENDED', basis: 'BOTH_AGREE', semanticsStatus }
        : { ...base, normalized: 'CONFLICT', basis: 'BOTH_DISAGREE', semanticsStatus };
    }
    return {
      ...base, normalized: fromId, basis: 'PROVIDER_SESSION_IDENTIFIER',
      semanticsStatus: encoding.status,
    };
  }

  if (legacyExtended) {
    return {
      ...base, normalized: 'EXTENDED', basis: 'LEGACY_SALE_CONDITION',
      semanticsStatus: weakestStatus(legacyStatuses),
    };
  }
  // No identifier and no legacy marker. The absence of the marker is not
  // evidence of a regular session: a migrated participant sends no `v` for an
  // extended-hours trade either.
  return { ...base, normalized: 'UNKNOWN', basis: 'NONE', semanticsStatus: 'UNVERIFIED' };
}

/**
 * A clock-based guess, returned as its own type so it can never be mistaken
 * for evidence.
 *
 * Only ever consulted when `readSessionEvidence` returned basis `NONE`. It can
 * say REGULAR — inside a published session's regular hours no extended session
 * runs — and otherwise says UNKNOWN. It never says EXTENDED: whether an
 * extended session exists at 07:45 or 16:10 depends on the product and the
 * venue (Cboe's single-stock extended sessions cover select names only), which
 * is exactly what a clock cannot know.
 */
export interface ClockSessionInference {
  normalized: 'REGULAR' | 'UNKNOWN';
  basis: 'CLOCK_INFERENCE';
  why: string;
}

export function inferSessionFromClock(eventTime: number): ClockSessionInference {
  const date = marketDateOf(eventTime);
  const minutes = minutesEt(eventTime);
  if (date === null || minutes === null) {
    return { normalized: 'UNKNOWN', basis: 'CLOCK_INFERENCE', why: 'the event time is unreadable' };
  }
  const s = sessionOn(date);
  if (s.openHour === null || s.openMinute === null || s.closeHour === null || s.closeMinute === null) {
    return { normalized: 'UNKNOWN', basis: 'CLOCK_INFERENCE', why: s.basis };
  }
  const open = s.openHour * 60 + s.openMinute;
  const close = s.closeHour * 60 + s.closeMinute;
  if (minutes >= open && minutes < close) {
    return {
      normalized: 'REGULAR',
      basis: 'CLOCK_INFERENCE',
      why: `${s.basis}; inside the exchange's regular hours, where no extended session runs`,
    };
  }
  return {
    normalized: 'UNKNOWN',
    basis: 'CLOCK_INFERENCE',
    why: `${s.basis}; outside regular hours, where the session depends on product and venue`,
  };
}
