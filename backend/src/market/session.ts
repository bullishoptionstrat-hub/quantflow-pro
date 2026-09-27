/**
 * Is the US options market open **right now**, and on what basis?
 *
 * The browser used to answer this by itself. `frontend/lib/utils.ts` held
 * `isRegularHours()` — a weekday test and a clock window — and the sidebar
 * rendered its result as `REGULAR HOURS`/`OUTSIDE HOURS`. CLAUDE.md records the
 * function being *renamed* rather than fixed, on the grounds that "a calendar is
 * a thing to maintain":
 *
 *   "There is no holiday calendar here, so Thanksgiving, Good Friday and every
 *    other full closure read as open, and half-days read as open past the 13:00
 *    close."
 *
 * That justification has expired. `flow-engine/calendar.ts` is maintained, and
 * this is the F-16 shape again: the backend knows the answer and the browser was
 * guessing. So the verdict is computed here, published on `/api/health`, and read
 * there — rather than the calendar being copied into the frontend, which is the
 * duplication this repository keeps closing.
 *
 * **Why this is not in `calendar.ts`.** That module is deliberately clock-free:
 * `sessionOn` takes a date string so that no timezone rule can hide inside a
 * table lookup, and `marketDateOf` is the one conversion from an instant. Asking
 * "is it open now" needs both plus a wall clock, which is a different job, and
 * putting it there would give the table a second reason to exist.
 */
import {
  sessionOn, marketDateOf, MARKET_TZ, SOURCE, READ_AT, COVERAGE,
} from '../flow-engine/calendar';

/** What the board may say about the current session. */
export type SessionState =
  /** Inside a published session's hours. */
  | 'OPEN'
  /** A published session, but before the open or after the close. */
  | 'CLOSED_OUTSIDE_HOURS'
  /** A published full closure. */
  | 'CLOSED_HOLIDAY'
  | 'CLOSED_WEEKEND'
  /**
   * The calendar will not answer for today. **Not a synonym for closed** — the
   * same rule `coverage.ts` follows, for the same reason: a reader who converts
   * "cannot say" into "closed" has been told something nobody established.
   */
  | 'UNKNOWN';

export interface MarketSession {
  state: SessionState;
  /** The market-local date this verdict is about. */
  date: string | null;
  /** Minutes past midnight ET, so a client can render its own countdown. */
  nowMinutesEt: number | null;
  openMinutesEt: number | null;
  closeMinutesEt: number | null;
  /** The calendar's own words, plus what this added. */
  basis: string;
  source: string;
  readAt: string;
  coverage: { from: string; to: string };
}

const CLOCK = new Intl.DateTimeFormat('en-US', {
  timeZone: MARKET_TZ, hour: '2-digit', minute: '2-digit', hour12: false,
});

/**
 * Minutes past midnight in the market's zone, or null when unreadable.
 *
 * `hour12: false` renders midnight as "24" in some ICU versions, so the hour is
 * taken modulo 24 rather than trusted — the same defensive read `expiry.ts`
 * makes, and the one hour where getting it wrong would put the verdict a whole
 * day out.
 */
export function minutesEt(atMs: number): number | null {
  if (!Number.isFinite(atMs)) return null;
  const d = new Date(atMs);
  if (Number.isNaN(d.getTime())) return null;
  const parts = CLOCK.formatToParts(d);
  const at = (k: string) => parts.find((p) => p.type === k)?.value;
  const h = Number(at('hour'));
  const m = Number(at('minute'));
  if (!Number.isInteger(h) || !Number.isInteger(m)) return null;
  return (h % 24) * 60 + m;
}

/** The session verdict at an instant. Pure, so the whole table is drivable. */
export function marketSessionAt(atMs: number): MarketSession {
  const meta = { source: SOURCE, readAt: READ_AT, coverage: { ...COVERAGE } };
  const date = marketDateOf(atMs);
  const nowMinutesEt = minutesEt(atMs);

  if (date === null || nowMinutesEt === null) {
    return {
      state: 'UNKNOWN', date: null, nowMinutesEt: null,
      openMinutesEt: null, closeMinutesEt: null,
      basis: 'the current instant could not be read in the market timezone',
      ...meta,
    };
  }

  const s = sessionOn(date);
  const base = { date, nowMinutesEt, openMinutesEt: null, closeMinutesEt: null, ...meta };

  if (s.kind === 'UNKNOWN') return { ...base, state: 'UNKNOWN' as const, basis: s.basis };
  if (s.kind === 'WEEKEND') return { ...base, state: 'CLOSED_WEEKEND' as const, basis: s.basis };
  if (s.kind === 'HOLIDAY') return { ...base, state: 'CLOSED_HOLIDAY' as const, basis: s.basis };

  // REGULAR or EARLY_CLOSE. The table carries both bounds for these, so no
  // clock window is assumed here — which is the whole point: the previous
  // implementation hardcoded 09:30–16:00 and was wrong every half-day
  // afternoon.
  if (s.openHour === null || s.openMinute === null
      || s.closeHour === null || s.closeMinute === null) {
    // Unreachable via `sessionOn`, and answered conservatively rather than with
    // a `!`: a session whose bounds are missing is one nobody established.
    return { ...base, state: 'UNKNOWN' as const, basis: `${s.basis}; session bounds are missing` };
  }
  const openMinutesEt = s.openHour * 60 + s.openMinute;
  const closeMinutesEt = s.closeHour * 60 + s.closeMinute;
  const open = nowMinutesEt >= openMinutesEt && nowMinutesEt < closeMinutesEt;

  return {
    ...base,
    openMinutesEt,
    closeMinutesEt,
    state: open ? ('OPEN' as const) : ('CLOSED_OUTSIDE_HOURS' as const),
    basis: `${s.basis}; ${open ? 'inside' : 'outside'} those hours`,
  };
}
