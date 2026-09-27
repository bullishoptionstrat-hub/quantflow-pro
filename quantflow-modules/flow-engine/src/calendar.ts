/**
 * The US equity-options trading calendar, effective-dated, with a hard bound.
 *
 * This repository refused a holiday calendar twice, for a reason worth keeping
 * in front of whoever reads this file: `isMarketOpen()` once checked a weekday
 * and a clock with no calendar at all, so `MARKET OPEN` was green on
 * Thanksgiving and through a half-day's afternoon, and `coverage.ts` declined
 * to emit `MARKET_CLOSED` because *"the union's `MARKET_CLOSED` needs a holiday
 * calendar this codebase does not have"*. Both now read this table.
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
 * **Why it lives inside the engine.** `expiry.ts` needs it, and that file is
 * *vendored* — `backend/src/flow-engine/` is a byte-identical copy of this
 * directory, held so by `vendorMirror.test.ts`. The alternative was threading a
 * close lookup through `expiryInstantMs` → `daysToExpiry` → `score.ts`, and an
 * **optional** parameter there would be the failure `classifyWindow` refuses by
 * name: a caller that forgets it silently gets the old answer, and the
 * degradation is invisible because every date classifies exactly as it did
 * before. So the table is engine reference data, at the cost of two edits a
 * year instead of one — and the mirror guard makes a missed second edit loud.
 *
 * **What this is NOT.** It is not settlement data. An AM-settled SPX monthly
 * stops trading the preceding Thursday, which is a *product* fact this table
 * knows nothing about — that half of F-10 stays open. A calendar answers "was
 * the market open that day"; it does not answer "could this contract still be
 * traded".
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
 * The caller supplies a date already expressed in the market's own zone.
 * `marketDateOf()` below is the one conversion from an instant, and it is a
 * separate function on purpose: `sessionOn` taking an epoch would hide a
 * timezone rule inside a table lookup, and a caller passing a UTC-derived date
 * would get a silently wrong answer for every instant between 19:00 and
 * midnight ET. The conversion asks the IANA database rather than carrying an
 * offset table, for the same reason `flow-engine/expiry.ts` does — a hardcoded
 * DST rule is the same class of stale constant as a 2024 price map.
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

/** The exchange whose clock decides what day it is. */
export const MARKET_TZ = 'America/New_York';

// `en-CA` formats as YYYY-MM-DD, which is the shape `sessionOn` reads. Built
// once: constructing an Intl formatter per call is measurable at tick rates.
const MARKET_DATE = new Intl.DateTimeFormat('en-CA', {
  timeZone: MARKET_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/**
 * The market-local calendar date of an instant, or `null` when unreadable.
 *
 * `null` rather than today's date: a caller handed an unparseable clock must
 * not be told what day it is in New York, because the answer would be about a
 * different instant than the one it asked about.
 */
export function marketDateOf(ms: number): string | null {
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  return MARKET_DATE.format(d);
}

/**
 * The longest run of consecutive full closures this table can produce.
 *
 * Christmas 2026 is a Friday, so 25–27 December is three. The bound exists so
 * that `closureThroughout` cannot be made to walk an unbounded number of days
 * by an absurd `startedAt` — a gap row whose start is the epoch, say. Nothing
 * legitimate reaches it: the walk stops at the first date that is not a
 * closure, and outside `COVERAGE` that is the first date it looks at.
 */
const MAX_CLOSURE_RUN_DAYS = 10;

const DAY_MS = 86_400_000;

/**
 * Was the market established as shut for **every** calendar date the window
 * `[startMs, endMs]` touches?
 *
 * Every date, not any — and that is the whole design. A window from Friday
 * afternoon to Monday morning spans a weekend *and two open sessions*, and
 * calling it a closure would convert a real outage into a benign one, which is
 * the flattering direction `collection_gaps` exists to refuse.
 *
 * **Day granularity, stated rather than implied.** This answers "was the
 * market shut all day", so an overnight window on a weekday — 02:00 Tuesday,
 * when the market is just as shut — is NOT established as a closure and the
 * caller will treat it as an ordinary gap. That overstates the gap, which
 * costs a reader's time; the opposite error costs the record its honesty.
 * Narrowing it needs session *open* times, which this table does not publish.
 */
export function closureThroughout(
  startMs: number,
  endMs: number,
): { closed: boolean; basis: string } {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) {
    return { closed: false, basis: 'window bounds are not a readable interval' };
  }
  if (endMs - startMs > MAX_CLOSURE_RUN_DAYS * DAY_MS) {
    return {
      closed: false,
      basis:
        `window spans more than ${MAX_CLOSURE_RUN_DAYS} days, which is longer ` +
        'than any run of closures this calendar can establish',
    };
  }

  const firstDate = marketDateOf(startMs);
  if (firstDate === null) {
    return { closed: false, basis: 'window start is not a readable instant' };
  }
  const lastDate = marketDateOf(endMs);
  if (lastDate === null) {
    return { closed: false, basis: 'window end is not a readable instant' };
  }

  const seen: string[] = [];
  // Step by whole days from the start instant. The final iteration is pinned
  // to `endMs` itself so a window shorter than a day still checks its end
  // date, and so a DST day (23 or 25 hours long) cannot skip one.
  for (let t = startMs; ; t += DAY_MS) {
    const date = marketDateOf(Math.min(t, endMs));
    if (date === null) return { closed: false, basis: 'window start is not a readable instant' };
    if (!seen.includes(date)) {
      const s = sessionOn(date);
      if (s.kind !== 'HOLIDAY' && s.kind !== 'WEEKEND') {
        return { closed: false, basis: s.basis };
      }
      seen.push(date);
    }
    if (t >= endMs) break;
  }

  // Indexed reads are narrowed rather than asserted. The module's tsconfig sets
  // `noUncheckedIndexedAccess` and the backend's does not, so `seen[0]` is
  // `string | undefined` here and `string` there — the vendored copy typechecks
  // under the LOOSER config, which is how this line passed for four days while
  // `${seen[seen.length - 1]}` could have rendered the literal "undefined" into
  // a gap row's reason. `firstDate`/`lastDate` are already narrowed above.
  const only = seen.length === 1 ? seen[0] : undefined;
  return {
    closed: true,
    basis: only !== undefined
      ? sessionOn(only).basis
      : `every date in ${firstDate}..${lastDate} is an established closure`,
  };
}
