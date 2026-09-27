/**
 * When an option's expiry date becomes an instant.
 *
 * Three call sites parsed `${isoDate}T20:00:00Z` under the comment "~4pm ET
 * close". **That comment is false for about five months of the year.** 20:00Z
 * is 16:00 in New York only while daylight saving is in force; under EST it is
 * 15:00, so the assumed expiry ran an hour early every winter. Measured:
 *
 *   2026-01-16T20:00:00Z -> 15:00 ET
 *   2026-06-19T20:00:00Z -> 16:00 ET
 *
 * The consequence is small and is stated rather than implied: DTE feeds one
 * scoring component with buckets at 2/7/21/45 days, so an hour's error changes
 * the bucket only for a trade landing within an hour of a boundary — 0.16% of
 * sampled trade instants across two expiries, worth at most 3 points of 100.
 * It is fixed because it is exactly fixable and because a false comment in
 * this repository is its own defect, not because the arithmetic was material.
 *
 * **What this does NOT know, which is the honest part.** It answers "16:00 in
 * New York on that date", nothing more:
 *
 *   - **AM-settled index options.** SPX monthlies stop trading the preceding
 *     Thursday and settle from Friday's opening prices, so their last tradeable
 *     instant is roughly a day before what this returns. SPXW weeklys are
 *     PM-settled and are correct here. Distinguishing them needs per-product
 *     settlement data this repository does not carry.
 *   - ~~**Half-days and holidays.** An early close is 13:00 ET, and this returns
 *     16:00.~~ **Closed 2026-09-27**: `./calendar` is an effective-dated table
 *     with a hard `COVERAGE` bound, so a published early close returns 13:00.
 *     The scope is deliberately small and stated: two dates in 2026, three
 *     hours each. It is fixed on the same grounds the DST error was — exactly
 *     fixable, and a false comment in this repository is its own defect.
 *
 * The settlement gap remains open and is recorded in `docs/FORENSIC_AUDIT.md`
 * rather than papered over with a guess.
 *
 * **The fallback is the load-bearing part, and it goes the only safe way.**
 * The calendar answers `UNKNOWN` outside its coverage — which every LEAPS and
 * every date past this year's table is — and `UNKNOWN` is deliberately not a
 * verdict. So an unanswered date falls back to the **regular** close rather
 * than to `NaN`, and the reason is a coupling that is easy to miss:
 * `ingestPrint` gates on `Number.isNaN(expiryInstantMs(print.expiry))`, so
 * returning `NaN` here would make the calendar's coverage bound into a cliff
 * that silently drops every print with a 2027 expiry. A closed day (holiday or
 * weekend) falls back the same way: no listed option expires on one, so such a
 * date is a vendor artifact, and refusing it would drop the print over a
 * disagreement about the calendar rather than about the data.
 */

import { sessionOn, MARKET_TZ } from "./calendar";

/**
 * Regular-session close, in that zone's wall clock.
 *
 * Still here because it is the fallback for a date the calendar will not answer
 * for, and because `CANDIDATE_OFFSETS` needs an hour to probe with. The calendar
 * publishes the same 16:00 for a `REGULAR` session, so the two agree by
 * construction and a test asserts it rather than trusting the coincidence.
 */
const CLOSE_HOUR = 16;
const CLOSE_MINUTE = 0;

/**
 * Candidate UTC offsets for `MARKET_TZ`, in hours behind UTC.
 *
 * Trying both and asking the IANA database which one actually lands on
 * `CLOSE_HOUR` is what makes this correct across a DST transition without
 * hardcoding when the transition is — the rule changes by legislation, and a
 * date arithmetic that encodes this year's rule is the same class of stale
 * constant as a 2024 price map.
 */
const CANDIDATE_OFFSETS = [4, 5] as const;

const PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: MARKET_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  hour12: false,
});

/**
 * The wall-clock close this file will aim at for `isoDate`, and why.
 *
 * Separate from the instant arithmetic because the two questions are different:
 * *which* close applies is a calendar fact, and *what instant* that is in UTC is
 * a timezone computation. Exported so the fallback can be asserted directly —
 * a test that could only reach it through `expiryInstantMs` would be checking
 * an instant when the interesting part is the branch.
 */
export function sessionCloseFor(isoDate: string): {
  hour: number;
  minute: number;
  /** `published` when the calendar answered; `fallback` when it would not. */
  basis: "published" | "fallback";
  why: string;
} {
  const s = sessionOn(isoDate);
  if (s.closeHour !== null && s.closeMinute !== null) {
    return { hour: s.closeHour, minute: s.closeMinute, basis: "published", why: s.basis };
  }
  // UNKNOWN (outside COVERAGE), HOLIDAY or WEEKEND. None of them yields a
  // close, and none of them may yield NaN — see this file's header for the
  // `ingestPrint` coupling that makes refusing here a data-dropping cliff.
  return {
    hour: CLOSE_HOUR,
    minute: CLOSE_MINUTE,
    basis: "fallback",
    why: `${s.basis}; assuming the regular ${CLOSE_HOUR}:00 close`,
  };
}

/**
 * Epoch ms for the regular-session close on `isoDate` (an ISO `YYYY-MM-DD`),
 * or `NaN` when the date cannot be read.
 *
 * `NaN` rather than a fallback instant: every caller already branches on
 * `Number.isNaN`, and inventing an expiry for a date nobody could parse is the
 * `?? 0` move with a clock instead of a price.
 */
export function expiryInstantMs(isoDate: string): number {
  // No date-shape regex in front of this. One was written, and the mutation
  // that deleted it failed no test — because the round-trip below already
  // rejects everything it would have: a date `Date.parse` cannot read gives
  // NaN, and one it reads loosely (`2026-6-19`, a leading space) formats back
  // in a canonical shape that no longer equals what was passed. An unreachable
  // guard is a check with nothing to check, which this repository has watched
  // stop working quietly more than once, so the tested guard does the work
  // alone.
  const close = sessionCloseFor(isoDate);

  for (const offset of CANDIDATE_OFFSETS) {
    const hourUtc = close.hour + offset;
    const candidate = Date.parse(
      `${isoDate}T${String(hourUtc).padStart(2, "0")}:` +
      `${String(close.minute).padStart(2, "0")}:00Z`,
    );
    if (Number.isNaN(candidate)) return NaN;

    const p = PARTS.formatToParts(new Date(candidate));
    const at = (k: string) => p.find((x) => x.type === k)?.value ?? "";
    const local = `${at("year")}-${at("month")}-${at("day")}`;
    // The check is on the hour alone because every UTC offset this zone has
    // ever used is a whole number of hours, so the minute rides through
    // unchanged. `hour12: false` renders midnight as "24" in some ICU versions;
    // no close here is at midnight, but compare numerically anyway.
    if (local === isoDate && Number(at("hour")) === close.hour) return candidate;
  }
  return NaN;
}

/**
 * Days from `tsMs` until the expiry close, floored at zero.
 *
 * One home for the subtraction as well as for the instant: it was written out
 * at three call sites, two of which rounded differently from each other.
 */
export function daysToExpiry(tsMs: number, isoDate: string): number {
  const expiry = expiryInstantMs(isoDate);
  if (Number.isNaN(expiry)) return NaN;
  return Math.max(0, (expiry - tsMs) / 86_400_000);
}
