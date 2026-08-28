/**
 * POINT-IN-TIME DATA CONTRACT — lookahead prevention.
 *
 * Two distinct lookahead bugs are possible with regulatory data, and only one
 * of them is obvious:
 *
 *  1. FUTURE-SNAPSHOT LOOKAHEAD (obvious): reading a snapshot created after the
 *     decision timestamp.
 *
 *  2. PUBLICATION-LAG LOOKAHEAD (subtle, and the one that quietly ruins
 *     backtests): using a record whose *trade date* precedes the decision time
 *     but whose *publication time* does not. FINRA's CNMS file describing
 *     Friday's session is posted by 6:00 PM ET Friday. A backtest making a
 *     decision at Friday 10:00 AM that reads Friday's DIX is using information
 *     that did not exist for another eight hours.
 *
 * asOf() enforces BOTH by filtering on availableAt, never on effectiveAt.
 */
import type { Provenance } from "./provenance.js";

export interface TemporalRecord {
  /** When the underlying activity happened. NOT the filter key. */
  effectiveAt: string;
  /** When the record became publicly retrievable. THE filter key. */
  availableAt: string;
}

export class LookaheadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LookaheadError";
  }
}

/**
 * Filter records to those knowable at `decisionTime`.
 *
 * Records missing `availableAt` are EXCLUDED, not assumed available. Assuming
 * availability is precisely how publication-lag lookahead enters a study.
 */
export function asOf<T extends TemporalRecord>(records: T[], decisionTime: Date | string): T[] {
  const t = typeof decisionTime === "string" ? Date.parse(decisionTime) : decisionTime.getTime();
  if (Number.isNaN(t)) throw new LookaheadError(`invalid decision time: ${String(decisionTime)}`);

  return records.filter((r) => {
    if (!r.availableAt) return false;
    const avail = Date.parse(r.availableAt);
    if (Number.isNaN(avail)) return false;
    return avail <= t;
  });
}

/**
 * Most recent record knowable at decisionTime, or undefined.
 *
 * TIE-BREAKING IS DETERMINISTIC AND DELIBERATE.
 *
 * An earlier version reduced on `availableAt` alone, which made the result
 * depend on array order: two records published in the same instant returned
 * whichever happened to come first in the input. A point-in-time lookup whose
 * answer changes with fetch order is not point-in-time — the same backtest
 * would produce different features on a re-run, and the difference would be
 * invisible because both answers look plausible.
 *
 * So ties on `availableAt` fall through to `effectiveAt` (the record describing
 * the later activity is the newer information — this is what a same-instant
 * revision looks like), and a remaining tie is broken by comparing the records'
 * stable serialization, which is arbitrary but *fixed*.
 */
export function latestAsOf<T extends TemporalRecord>(
  records: T[],
  decisionTime: Date | string
): T | undefined {
  const eligible = asOf(records, decisionTime);
  if (eligible.length === 0) return undefined;
  return eligible.reduce((a, b) => (compareRecency(a, b) >= 0 ? a : b));
}

/** Positive when `a` is the more recent record. Total order, never 0 for distinct input. */
function compareRecency(a: TemporalRecord, b: TemporalRecord): number {
  const av = Date.parse(a.availableAt) - Date.parse(b.availableAt);
  if (av !== 0) return av;
  const ef = (Date.parse(a.effectiveAt) || 0) - (Date.parse(b.effectiveAt) || 0);
  if (ef !== 0) return ef;
  // Last resort: arbitrary but stable, so repeated runs agree with each other.
  const as = JSON.stringify(a);
  const bs = JSON.stringify(b);
  return as < bs ? -1 : as > bs ? 1 : 0;
}

/**
 * Assert a record was knowable. Throws rather than returning false so a caller
 * cannot ignore it. Used inside feature builders as a tripwire.
 */
export function assertKnowable(record: TemporalRecord, decisionTime: Date | string): void {
  const t = typeof decisionTime === "string" ? Date.parse(decisionTime) : decisionTime.getTime();
  const avail = Date.parse(record.availableAt);
  if (Number.isNaN(avail)) {
    throw new LookaheadError(
      `record has no parseable availableAt; cannot prove it was knowable at ${new Date(t).toISOString()}`
    );
  }
  if (avail > t) {
    throw new LookaheadError(
      `LOOKAHEAD: record became available ${record.availableAt} but decision time is ` +
        `${new Date(t).toISOString()} (${Math.round((avail - t) / 60000)} minutes early)`
    );
  }
}

/**
 * Publication-lag model per dataset. Converts a trade date into the timestamp
 * at which that data actually became retrievable.
 */
export interface PublicationLagModel {
  dataset: string;
  /** Compute availability time from the effective (trade) date. */
  availableAtFor(effectiveDate: string): string;
  note: string;
}

/** FINRA daily short-volume files: posted "no later than 6:00 PM ET" same day. */
export const FINRA_DAILY_LAG: PublicationLagModel = {
  dataset: "FINRA CNMS daily short volume",
  availableAtFor(effectiveDate: string): string {
    // 18:00 America/New_York on the trade date. Offset resolved DST-aware by
    // formatting through the IANA zone rather than a hardcoded -04:00.
    return etTimeOnDate(effectiveDate, 18, 0);
  },
  note: "FINRA states files post no later than 6:00:00 PM ET on the trade date.",
};

/** Cboe end-of-session symbol statistics: treat as available after the close. */
export const CBOE_EOD_LAG: PublicationLagModel = {
  dataset: "Cboe symbol_data daily CSV",
  availableAtFor(effectiveDate: string): string {
    return etTimeOnDate(effectiveDate, 17, 0);
  },
  note: "End-of-session file; conservatively treated as available 17:00 ET.",
};

/** OCC cleared volume: next-business-day clearing publication, conservative. */
export const OCC_CLEARING_LAG: PublicationLagModel = {
  dataset: "OCC volume-query",
  availableAtFor(effectiveDate: string): string {
    return etTimeOnDate(effectiveDate, 9, 0, 1);
  },
  note: "Cleared volume; conservatively treated as available 09:00 ET the following day.",
};

/**
 * Build an ISO instant for a given wall-clock time in America/New_York on a
 * given date, DST-aware. No hardcoded -04:00 anywhere.
 */
export function etTimeOnDate(
  isoDate: string,
  hour: number,
  minute: number,
  addDays = 0
): string {
  const [y, m, d] = isoDate.slice(0, 10).split("-").map(Number);
  // Start from the UTC instant of that wall time, then correct by the zone's
  // actual offset on that date (which differs across the DST boundary).
  const naiveUtc = Date.UTC(y, m - 1, d + addDays, hour, minute, 0);
  const offsetMs = etOffsetMsAt(new Date(naiveUtc));
  return new Date(naiveUtc + offsetMs).toISOString();
}

/**
 * Offset to ADD to a naive-UTC-interpreted ET wall time to get the true UTC
 * instant. Positive because ET is behind UTC (EDT +4h, EST +5h).
 */
export function etOffsetMsAt(instant: Date): number {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(instant).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour === "24" ? "00" : parts.hour),
    Number(parts.minute),
    Number(parts.second)
  );
  return instant.getTime() - asUtc;
}
