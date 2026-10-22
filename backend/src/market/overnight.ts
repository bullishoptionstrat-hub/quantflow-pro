/**
 * "OVERNIGHT" — the stretch between the exchange's last published regular
 * close and its next published regular open, and nothing looser than that.
 *
 * ROADMAP 5.2 asks for a morning view that opens with "overnight flow". The
 * word has no answer on its own: since 16:00? since midnight? the last twelve
 * hours? A browser-side "since yesterday at four" would be the deleted
 * `isRegularHours()` again — a weekday test and a hardcoded close with no
 * calendar — and it would be wrong in exactly the places that matter: across a
 * holiday, after a 13:00 half day, and on a Monday morning, where the previous
 * close was Friday's.
 *
 * So the window is derived from the same table the RTH verdict reads
 * (`flow-engine/calendar.ts`), here, and published; the frontend renders it.
 * Its authority is the EXCHANGE'S REGULAR SESSION — the same narrow authority
 * `session.ts` names — so "overnight" means *outside regular hours since the
 * last close*. It says nothing about the OPRA feed window or a product's
 * extended sessions; flow that printed in those sessions lands in it, and that
 * is what the reader is asking to see.
 *
 *   - Before today's open, or on a closed day: from the most recent published
 *     close to now.
 *   - During regular hours: from the previous session's close to today's open.
 *     The overnight is over; what it contained does not change as the day goes.
 *   - After today's close: from today's close to now. A new overnight began.
 *
 * Any date the walk back touches that the calendar will not answer for makes
 * the window `UNKNOWN`. That is the `coverage.ts` rule: "cannot say" is not a
 * closure, and skipping an unanswerable date as though it were a weekend would
 * stretch the window over a session nobody established was shut. On
 * 2026-01-02 the walk reaches 2025-12-31, outside the table, and the window is
 * honestly unknown.
 *
 * Pure in the instant it is given, so the whole table is drivable — this
 * module never reads the clock.
 */
import { sessionOn } from '../flow-engine/calendar';
import { addDays, hhmm, instantEt, marketDateOf, minutesEt } from './civil';

export interface OvernightWindow {
  /** The only authority this answers for. Never "the market". */
  authority: 'EXCHANGE_REGULAR_SESSION';
  state: 'ESTABLISHED' | 'UNKNOWN';
  /** The last published regular close, as an ISO instant. Null when UNKNOWN. */
  from: string | null;
  /** Today's published open when RTH has begun, else the instant asked about. */
  to: string | null;
  /** True when `to` is a published open rather than "now". */
  closedBySessionOpen: boolean;
  /** The calendar's own words for every date that decided this window. */
  basis: string;
}

/**
 * How far back to walk for a session. The longest run of non-session days in
 * any US equity calendar is a holiday beside a weekend — four days. Ten is
 * room for that twice, and the bound exists only so an unreachable loop is a
 * refusal rather than a hang.
 */
const MAX_WALK_DAYS = 10;

type CloseLookup =
  | { ok: true; ms: number; basis: string }
  | { ok: false; basis: string };

/** The most recent published regular close strictly before `isoDate`. */
export function previousCloseBefore(isoDate: string): CloseLookup {
  const skipped: string[] = [];
  for (let i = 1; i <= MAX_WALK_DAYS; i++) {
    const d = addDays(isoDate, -i);
    if (d === null) return { ok: false, basis: `"${isoDate}" is not a date` };
    const s = sessionOn(d);
    if (s.kind === 'UNKNOWN') {
      // Not skipped. A date the calendar will not answer for may have held a
      // session, and stepping past it would claim it did not.
      return { ok: false, basis: `${d}: ${s.basis}` };
    }
    if (s.kind === 'WEEKEND' || s.kind === 'HOLIDAY') {
      skipped.push(`${d} (${s.basis})`);
      continue;
    }
    if (s.closeHour === null || s.closeMinute === null) {
      return { ok: false, basis: `${d}: ${s.basis}; its close is missing` };
    }
    const ms = instantEt(d, s.closeHour, s.closeMinute);
    if (ms === null) return { ok: false, basis: `${d}: its close could not be placed in time` };
    const close = `${d} closed at ${hhmm(s.closeHour * 60 + s.closeMinute)} ET (${s.basis})`;
    return {
      ok: true,
      ms,
      basis: skipped.length ? `${close}; skipped ${skipped.join(', ')}` : close,
    };
  }
  return { ok: false, basis: `no published session in the ${MAX_WALK_DAYS} days before ${isoDate}` };
}

function unknown(basis: string): OvernightWindow {
  return {
    authority: 'EXCHANGE_REGULAR_SESSION', state: 'UNKNOWN',
    from: null, to: null, closedBySessionOpen: false, basis,
  };
}

function established(fromMs: number, toMs: number, closedBySessionOpen: boolean, basis: string): OvernightWindow {
  return {
    authority: 'EXCHANGE_REGULAR_SESSION', state: 'ESTABLISHED',
    from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString(),
    closedBySessionOpen, basis,
  };
}

/** The overnight window as of `atMs`. */
export function overnightWindowAt(atMs: number): OvernightWindow {
  const date = marketDateOf(atMs);
  const nowMin = minutesEt(atMs);
  if (date === null || nowMin === null) {
    return unknown('the instant could not be read in the market timezone');
  }

  const today = sessionOn(date);
  if (today.kind === 'UNKNOWN') return unknown(`${date}: ${today.basis}`);

  if (today.kind === 'REGULAR' || today.kind === 'EARLY_CLOSE') {
    if (today.openHour === null || today.openMinute === null
        || today.closeHour === null || today.closeMinute === null) {
      return unknown(`${date}: ${today.basis}; session bounds are missing`);
    }
    const openMs = instantEt(date, today.openHour, today.openMinute);
    const closeMs = instantEt(date, today.closeHour, today.closeMinute);
    if (openMs === null || closeMs === null) {
      return unknown(`${date}: its session bounds could not be placed in time`);
    }

    if (atMs >= closeMs) {
      // Today's session is over: a new overnight started at its close.
      return established(closeMs, atMs, false,
        `since today's close: ${date} closed at ${hhmm(today.closeHour * 60 + today.closeMinute)} ET (${today.basis})`);
    }

    const prev = previousCloseBefore(date);
    if (!prev.ok) return unknown(prev.basis);
    if (atMs >= openMs) {
      // RTH has begun. The overnight is a closed interval now.
      return established(prev.ms, openMs, true,
        `${prev.basis}; to ${date}'s open at ${hhmm(today.openHour * 60 + today.openMinute)} ET`);
    }
    return established(prev.ms, atMs, false, `${prev.basis}; ${date}'s open has not come`);
  }

  // A weekend or a holiday: no session today, so the overnight runs from the
  // last close to now.
  const prev = previousCloseBefore(date);
  if (!prev.ok) return unknown(prev.basis);
  return established(prev.ms, atMs, false, `${prev.basis}; ${date} has no session (${today.basis})`);
}

/** What the buffer could and could not see of the window. */
export interface WindowCoverage {
  /** Events in the server's buffer when asked. */
  buffered: number;
  /** The buffer's cap. At the cap, older events have been evicted. */
  cap: number;
  /** The oldest event still held, or null when the buffer is empty. */
  oldestBufferedAt: string | null;
  /** When this process started. Nothing earlier was ever seen. */
  processStartedAt: string;
  /**
   * True only when nothing in the window can have been missed: the process
   * was running at the window's start AND the buffer has never been full.
   * Anything else is `false`, with `basis` saying which — a partial window
   * labelled "overnight" is a smaller sample under a larger name.
   */
  complete: boolean;
  basis: string;
}

export interface WindowSelection<T> {
  window: OvernightWindow;
  data: T[];
  count: number;
  /** Rows carrying `synthetic: true` — not observed prints. */
  synthetic: number;
  coverage: WindowCoverage;
}

/**
 * The events whose `created_at` falls inside the window.
 *
 * `created_at` is the wire's timestamp, the first print of the cluster.
 * CLAUDE.md deprecates that clock for *measurement*; this is selection for
 * display, where "when did it print" is the question being asked, and
 * `decisionAt` is not on the wire.
 *
 * Generic over the event so this module stays independent of ingestion.
 */
export function selectWindow<T extends { created_at: string; synthetic?: boolean }>(
  window: OvernightWindow,
  events: T[],
  cap: number,
  processStartedAtMs: number,
): WindowSelection<T> {
  let oldest: number | null = null;
  for (const e of events) {
    const t = Date.parse(e.created_at);
    if (Number.isFinite(t) && (oldest === null || t < oldest)) oldest = t;
  }

  const fromMs = window.from === null ? null : Date.parse(window.from);
  const toMs = window.to === null ? null : Date.parse(window.to);
  const data = fromMs === null || toMs === null
    ? []
    : events.filter((e) => {
      const t = Date.parse(e.created_at);
      return Number.isFinite(t) && t >= fromMs && t <= toMs;
    });

  const full = events.length >= cap;
  const startedLate = fromMs !== null && processStartedAtMs > fromMs;
  const reasons: string[] = [];
  if (fromMs === null) reasons.push('the window itself is unknown');
  if (startedLate) reasons.push('this process started after the window opened, so earlier flow was never seen');
  if (full) reasons.push(`the buffer is at its cap of ${cap}, so older events have been evicted`);

  return {
    window,
    data,
    count: data.length,
    synthetic: data.filter((e) => e.synthetic === true).length,
    coverage: {
      buffered: events.length,
      cap,
      oldestBufferedAt: oldest === null ? null : new Date(oldest).toISOString(),
      processStartedAt: new Date(processStartedAtMs).toISOString(),
      complete: reasons.length === 0,
      basis: reasons.length === 0
        ? 'the process was running for the whole window and the buffer has never been full'
        : reasons.join('; '),
    },
  };
}
