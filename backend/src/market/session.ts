/**
 * The EXCHANGE'S REGULAR SESSION right now: is it a published session day, and
 * is the clock inside that day's published regular hours?
 *
 * **This used to call itself "is the US options market open right now", and
 * that question has no single answer.** The audit of 2026-09-27 put it plainly:
 * OPRA's supported window, a venue's session, a product's session and a study's
 * sample are four separate facts. At 07:45 ET the OPRA window may be open while
 * SPY has no regular session and H-001 admits nothing; at 21:00 SPX may be
 * trading in its global session while every equity option is shut. A verdict
 * named "open" answered all of those with whichever one this function happened
 * to compute — the exchange's regular hours — and the sidebar printed it as
 * MARKET OPEN.
 *
 * So this is now exactly what it computes and is labelled that way (`authority`
 * below). The other answers have their own modules: `civil.ts` lists them.
 *
 * The browser used to answer even this much by itself, with a weekday test and
 * a clock window and no holiday calendar; the verdict is computed here from
 * `flow-engine/calendar.ts`, published on `/api/health`, and read there.
 */
import { sessionOn, SOURCE, READ_AT, COVERAGE } from '../flow-engine/calendar';
import { marketDateOf, minutesEt } from './civil';

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
  /**
   * What this verdict is about. Only the exchange's published regular session:
   * not the feed window, not a product's extended or global session, not any
   * study's sample. A label rendered from it must say RTH, never MARKET.
   */
  authority: 'EXCHANGE_REGULAR_SESSION';
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

/** The session verdict at an instant. Pure, so the whole table is drivable. */
export function marketSessionAt(atMs: number): MarketSession {
  const meta = {
    authority: 'EXCHANGE_REGULAR_SESSION' as const,
    source: SOURCE, readAt: READ_AT, coverage: { ...COVERAGE },
  };
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
