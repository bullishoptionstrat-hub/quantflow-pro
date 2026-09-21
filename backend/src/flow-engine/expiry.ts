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
 *   - **Half-days and holidays.** An early close is 13:00 ET, and this returns
 *     16:00. A holiday calendar is a thing to maintain, and CLAUDE.md already
 *     records what happened the last time one was assumed rather than kept:
 *     a `MARKET OPEN` indicator green on Thanksgiving.
 *
 * Both remain open, and both are recorded in `docs/FORENSIC_AUDIT.md` rather
 * than papered over with a guess. What changed is that the part that could be
 * made exactly right now is exactly right, and the rest is written down.
 */

/** The exchange whose clock decides an expiry. */
const MARKET_TZ = "America/New_York";

/** Regular-session close, in that zone's wall clock. */
const CLOSE_HOUR = 16;

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
  for (const offset of CANDIDATE_OFFSETS) {
    const hourUtc = CLOSE_HOUR + offset;
    const candidate = Date.parse(
      `${isoDate}T${String(hourUtc).padStart(2, "0")}:00:00Z`,
    );
    if (Number.isNaN(candidate)) return NaN;

    const p = PARTS.formatToParts(new Date(candidate));
    const at = (k: string) => p.find((x) => x.type === k)?.value ?? "";
    const local = `${at("year")}-${at("month")}-${at("day")}`;
    // `hour12: false` renders midnight as "24" in some ICU versions; the close
    // is 16:00 so that case cannot arise here, but compare numerically anyway.
    if (local === isoDate && Number(at("hour")) === CLOSE_HOUR) return candidate;
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
