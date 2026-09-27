/**
 * CIVIL CALENDAR — timezone, DST and date arithmetic, and nothing about markets.
 *
 * One of four session authorities that used to be one question. They answer
 * different things and are kept apart so one cannot quietly answer for another:
 *
 *   civil.ts                 what date and minute is it in New York?   (this)
 *   flow-engine/calendar.ts  is the exchange holding a session that day, and
 *                            what are its published regular hours?
 *   feedSessions.ts          is the feed (OPRA) inside its supported window?
 *   productSessions.ts       may this product trade now, and in which session?
 *   contractLifecycle.ts     may this CONTRACT still trade; when does it settle?
 *   researchEligibility.ts   does this event belong in a given study's sample?
 *
 * `marketDateOf` and `MARKET_TZ` live in the vendored engine (expiry.ts needs
 * them) and are re-exported here so this module is the one import for civil
 * mechanics.
 */
import { MARKET_TZ, marketDateOf } from '../flow-engine/calendar';

export { MARKET_TZ, marketDateOf };

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

/**
 * Calendar-date arithmetic on `YYYY-MM-DD`, in UTC so no DST rule can move a
 * date: a civil date plus one day is the next civil date, whatever the clocks
 * did overnight. Null for a string that is not a real date.
 */
export function addDays(isoDate: string, n: number): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) return null;
  const ms = Date.parse(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(ms)) return null;
  const out = new Date(ms + n * 86_400_000).toISOString().slice(0, 10);
  // `Date.parse` rolls 2026-02-30 into March; a date that does not round-trip
  // was never a date.
  return new Date(ms).toISOString().slice(0, 10) === isoDate ? out : null;
}

/** "HH:MM" for minutes past midnight — for reasons and labels only. */
export function hhmm(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

/**
 * The instant a New York wall-clock time occurs on a date, or null when that
 * wall-clock time does not exist there (a DST gap) or the date is unreadable.
 * Both US offsets are tried and the answer must round-trip, so no DST rule is
 * assumed — the same approach `expiry.ts` takes.
 */
export function instantEt(isoDate: string, hour: number, minute: number): number | null {
  if (addDays(isoDate, 0) === null) return null;
  const pad = (n: number) => String(n).padStart(2, '0');
  for (const offsetHours of [4, 5]) {
    const ms = Date.parse(`${isoDate}T${pad(hour)}:${pad(minute)}:00Z`) + offsetHours * 3_600_000;
    if (marketDateOf(ms) === isoDate && minutesEt(ms) === hour * 60 + minute) return ms;
  }
  return null;
}
