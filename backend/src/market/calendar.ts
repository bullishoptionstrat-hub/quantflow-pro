/**
 * The US equity-options trading calendar, effective-dated, with a hard bound.
 *
 * This repository refused a holiday calendar twice, for a reason worth keeping
 * in front of whoever reads this file: `isMarketOpen()` once checked a weekday
 * and a clock with no calendar at all, so `MARKET OPEN` was green on
 * Thanksgiving and through a half-day's afternoon — and `coverage.ts` still
 * declines to emit `MARKET_CLOSED` because *"the union's `MARKET_CLOSED` needs
 * a holiday calendar this codebase does not have"*.
 *
 * **The objection was never to a calendar. It was to an ASSUMED one** — a
 * table with no stated coverage that keeps answering confidently after the
 * year it was written for has passed. That failure is silent and it flatters:
 * a session wrongly called closed turns missing data into data nobody expected.
 *
 * So this table carries `COVERAGE`, and **a date outside it returns `UNKNOWN`
 * rather than a guess**. Running past the end of the table is loud — callers
 * that need a verdict get none and must say so — which is the failure
 * direction this repo chooses everywhere else: `putCallUnavailable`,
 * `INSUFFICIENT_SAMPLE`, `flipUnavailable`, `moneyness: UNKNOWN`.
 *
 * §15 calls these external facts and says they are versioned data, not
 * constants buried in a comment. `SOURCE` and `READ_AT` are here for that
 * reason, and `docs/` records the review date.
 *
 * **What this is NOT.** It is not settlement data. An AM-settled SPX monthly
 * stops trading the preceding Thursday, which is a *product* fact this table
 * knows nothing about — F-10's other half stays open and `expiryInstant` is
 * still wrong for those. A calendar answers "was the market open that day";
 * it does not answer "could this contract still be traded".
 */

/** Effective-dated source for the facts below (§15). */
export const SOURCE = 'NYSE/Cboe published holiday schedules';
export const READ_AT = '2026-09-23';

/**
 * The inclusive date range this table can answer for.
 *
 * Deliberately narrow. A table claiming to cover 2030 would be asserting
 * holidays nobody has published, and the whole point of the bound is that it
 * expires loudly instead of drifting quietly.
 */
export const COVERAGE = { from: '2026-01-01', to: '2026-12-31' } as const;

/** Full closures. */
const HOLIDAYS_2026 = new Set([
  '2026-01-01', // New Year's Day
  '2026-01-19', // Martin Luther King, Jr. Day
  '2026-02-16', // Washington's Birthday
  '2026-04-03', // Good Friday
  '2026-05-25', // Memorial Day
  '2026-06-19', // Juneteenth
  '2026-07-03', // Independence Day (observed — July 4 falls on Saturday)
  '2026-09-07', // Labor Day
  '2026-11-26', // Thanksgiving Day
  '2026-12-25', // Christmas Day
]);

/** Early closes: 13:00 America/New_York. */
const EARLY_CLOSE_2026 = new Set([
  '2026-11-27', // day after Thanksgiving
  '2026-12-24', // Christmas Eve
]);

export type SessionKind =
  /** Open, regular close. */
  | 'REGULAR'
  /** Open, 13:00 ET close. */
  | 'EARLY_CLOSE'
  /** Exchange holiday. */
  | 'HOLIDAY'
  /** Saturday or Sunday. */
  | 'WEEKEND'
  /**
   * Outside `COVERAGE`, or an unparseable date. **Not a synonym for closed.**
   * A caller that cannot proceed without a verdict must say so rather than
   * pick one — the reason this state exists at all.
   */
  | 'UNKNOWN';

export interface Session {
  kind: SessionKind;
  /** Wall-clock close in `America/New_York`, or null when not open. */
  closeHour: number | null;
  closeMinute: number | null;
  /** Why this verdict — carried so a reader never has to guess the basis. */
  basis: string;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The session on a calendar date, given as `YYYY-MM-DD` in market-local terms.
 *
 * The caller supplies a date already expressed in the market's own zone. This
 * function deliberately does not convert an instant, because doing so would
 * put a second timezone rule here beside the one in `flow-engine/expiry.ts`,
 * and two tables that must agree about what day it is in New York is exactly
 * the duplication this repo keeps closing.
 */
export function sessionOn(isoDate: string): Session {
  if (!ISO_DATE.test(isoDate)) {
    return {
      kind: 'UNKNOWN', closeHour: null, closeMinute: null,
      basis: `"${isoDate}" is not a YYYY-MM-DD date`,
    };
  }
  if (isoDate < COVERAGE.from || isoDate > COVERAGE.to) {
    return {
      kind: 'UNKNOWN', closeHour: null, closeMinute: null,
      basis:
        `${isoDate} is outside the calendar's coverage ` +
        `(${COVERAGE.from}..${COVERAGE.to}, ${SOURCE}, read ${READ_AT}). ` +
        'The table is not extrapolated: a holiday nobody published is not a ' +
        'holiday, and guessing one would silently turn an open session into a ' +
        'closure.',
    };
  }

  // Midday UTC keeps the date stable regardless of the host's offset.
  const day = new Date(`${isoDate}T12:00:00Z`).getUTCDay();
  if (day === 0 || day === 6) {
    return {
      kind: 'WEEKEND', closeHour: null, closeMinute: null,
      basis: `${isoDate} is a ${day === 0 ? 'Sunday' : 'Saturday'}`,
    };
  }
  if (HOLIDAYS_2026.has(isoDate)) {
    return {
      kind: 'HOLIDAY', closeHour: null, closeMinute: null,
      basis: `${isoDate} is a published exchange holiday (${SOURCE})`,
    };
  }
  if (EARLY_CLOSE_2026.has(isoDate)) {
    return {
      kind: 'EARLY_CLOSE', closeHour: 13, closeMinute: 0,
      basis: `${isoDate} is a published early close, 13:00 ET (${SOURCE})`,
    };
  }
  return {
    kind: 'REGULAR', closeHour: 16, closeMinute: 0,
    basis: `${isoDate} is a regular session, 16:00 ET`,
  };
}

/**
 * `true` only when the calendar positively establishes a closure.
 *
 * Three-valued on purpose. `UNKNOWN` answers `false` here — the caller has not
 * been told the market was closed, because nothing established that — and a
 * caller that needs to distinguish "open" from "we cannot say" must read
 * `sessionOn().kind` rather than this convenience.
 */
export function isEstablishedClosure(isoDate: string): boolean {
  const k = sessionOn(isoDate).kind;
  return k === 'HOLIDAY' || k === 'WEEKEND';
}
