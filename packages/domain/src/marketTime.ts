/**
 * MARKET TIME — DST-aware ET handling and a trading calendar.
 *
 * THE DEFECT THIS EXISTS TO PREVENT
 * ---------------------------------
 * Hardcoded UTC-4 offsets (`hour_et = (created.hour - 4) % 24`) are wrong for
 * the ~4 months of EST each year. Everything here resolves through the IANA
 * zone America/New_York instead, and is tested across both DST boundaries.
 *
 * Also replaces "decrement the calendar day and retry" loops, which walk
 * forever through a long holiday weekend and silently hammer the provider.
 */
import { etOffsetMsAt } from "./pointInTime.js";

/** ET wall-clock parts for an instant, DST-aware. */
export function etParts(instant: Date): {
  year: number; month: number; day: number;
  hour: number; minute: number; second: number;
  isoDate: string;
} {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  });
  const p = Object.fromEntries(fmt.formatToParts(instant).map((x) => [x.type, x.value]));
  const hour = p.hour === "24" ? 0 : Number(p.hour);
  return {
    year: Number(p.year), month: Number(p.month), day: Number(p.day),
    hour, minute: Number(p.minute), second: Number(p.second),
    isoDate: `${p.year}-${p.month}-${p.day}`,
  };
}

/** Hour of day in ET. Correct in both EST and EDT. */
export function etHour(instant: Date): number {
  return etParts(instant).hour;
}

/** True if the instant falls in EDT (daylight time) rather than EST. */
export function isEasternDaylightTime(instant: Date): boolean {
  return etOffsetMsAt(instant) === 4 * 3_600_000;
}

// ---------------------------------------------------------------- calendar

/**
 * US equity/options market holidays. Full-day closures only.
 * Deliberately explicit rather than rule-derived: Good Friday moves with
 * Easter, and observed-date rules for fixed holidays are fiddly enough that a
 * table is more auditable than a computation.
 */
export const MARKET_HOLIDAYS = new Set<string>([
  // 2025
  "2025-01-01","2025-01-09","2025-01-20","2025-02-17","2025-04-18","2025-05-26",
  "2025-06-19","2025-07-04","2025-09-01","2025-11-27","2025-12-25",
  // 2026
  "2026-01-01","2026-01-19","2026-02-16","2026-04-03","2026-05-25","2026-06-19",
  "2026-07-03","2026-09-07","2026-11-26","2026-12-25",
  // 2027
  "2027-01-01","2027-01-18","2027-02-15","2027-03-26","2027-05-31","2027-06-18",
  "2027-07-05","2027-09-06","2027-11-25","2027-12-24",
]);

/** Early closes (13:00 ET). Data files still publish, but volume is truncated. */
export const EARLY_CLOSES = new Set<string>([
  "2025-07-03","2025-11-28","2025-12-24",
  "2026-11-27","2026-12-24",
  "2027-11-26",
]);

export function isWeekend(isoDate: string): boolean {
  const [y, m, d] = isoDate.split("-").map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return dow === 0 || dow === 6;
}

export function isTradingDay(isoDate: string): boolean {
  return !isWeekend(isoDate) && !MARKET_HOLIDAYS.has(isoDate);
}

export function isEarlyClose(isoDate: string): boolean {
  return EARLY_CLOSES.has(isoDate);
}

export function addDays(isoDate: string, n: number): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}

/**
 * Previous trading day. Bounded: throws after `maxBack` rather than looping
 * indefinitely if the holiday table is wrong or a date is malformed.
 */
export function previousTradingDay(isoDate: string, maxBack = 10): string {
  let cur = isoDate;
  for (let i = 0; i < maxBack; i++) {
    cur = addDays(cur, -1);
    if (isTradingDay(cur)) return cur;
  }
  throw new Error(`no trading day found within ${maxBack} days before ${isoDate}`);
}

/** Descending list of the N most recent trading days at or before isoDate. */
export function recentTradingDays(isoDate: string, count: number): string[] {
  const out: string[] = [];
  let cur = isTradingDay(isoDate) ? isoDate : previousTradingDay(isoDate);
  out.push(cur);
  while (out.length < count) {
    cur = previousTradingDay(cur);
    out.push(cur);
  }
  return out;
}

/** ET calendar date for an instant — the correct "what session is it" answer. */
export function currentEtDate(instant: Date = new Date()): string {
  return etParts(instant).isoDate;
}
