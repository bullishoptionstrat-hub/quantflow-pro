/**
 * OCC (Options Clearing Corporation) — market-wide cleared options volume.
 * No API key required.
 *
 * Every listed US option clears through the OCC, so this is the authoritative
 * total rather than one venue's share. Useful as the denominator when judging
 * whether a day's single-name activity is actually outsized.
 *
 * Docs: https://marketdata.theocc.com/
 *
 * ─── TWO DEFECTS FIXED HERE (docs/FORENSIC_AUDIT.md #27) ────────────────────
 *
 * 1. ZERO SENTINELS. Every field was `Number(x) || 0`. That is worse than the
 *    `?? 0` fixed in cboe.ts, because `||` also collapses a legitimate `0` and
 *    `NaN`. Worst was `vsMonthlyAverage`, which asserted "today is 0x the
 *    trailing average" whenever the average was simply unknown — and this
 *    value is the denominator for "is today's activity outsized", so a silent
 *    0 makes every day look unremarkable.
 *
 *    Note `fiftytwo_week_high` is snake_case among camelCase siblings. If that
 *    key is wrong, the old code would have read 0 forever and the sentinel
 *    would have concealed it. It now reads null, which is visible.
 *
 * 2. UNDECLARED DELAY. OCC publishes *cleared* volume on a next-business-day
 *    cycle — clearing settles overnight, so this is never today's tape. The
 *    connector declared no delay at all, and its output reaches `/api/health`.
 *    It now carries a provenance envelope saying so.
 */
import axios from 'axios';
import { num, ratio } from '../parseNumeric';
import { type Provenance, upstreamProvenance } from '../../config/provenance';
import { currentEtDate, previousTradingDay } from '../../domain/marketTime';
import { OCC_CLEARING_LAG, etTimeOnDate } from '../../domain/pointInTime';

/**
 * `null` means "not retrieved", never "zero". Consumers MUST branch on null
 * rather than formatting — `.toFixed()` on null throws loudly, which is the
 * intended outcome versus silently printing a fabricated 0.
 */
export interface OccVolume {
  totalVolume: number | null;
  optionsVolume: number | null;
  futuresVolume: number | null;
  fiftyTwoWeekHigh: number | null;
  fiftyTwoWeekLow: number | null;
  monthlyDailyAverage: number | null;
  yearlyDailyAverage: number | null;
  /**
   * Today's options volume as a multiple of the trailing monthly average.
   * `null` when either leg is missing — never 0, which would read as
   * "no activity at all" rather than "we could not compute this".
   */
  vsMonthlyAverage: number | null;
  fetchedAt: string;
  source: 'occ';
  /** The completed trading session this cleared volume describes. */
  effectiveDate: string;
  /** When the OCC made it retrievable. The point-in-time filter key. */
  availableAt: string;
  provenance: Provenance;
}

/**
 * Model the clearing cycle from the trading calendar rather than asserting a
 * flat constant.
 *
 * This previously declared `86_400` (one calendar day) with a note that it was
 * a floor, not a measurement, and was therefore WRONG over weekends and
 * holidays — on a Monday the real lag is ~72 hours, and the flat value
 * understated it by two thirds. That is the number a reader would use to
 * decide whether the data is current enough to act on.
 *
 * `@quantflow/domain` already models both halves of this, so neither is
 * invented here: `previousTradingDay` walks the real holiday calendar (bounded,
 * so a bad table throws instead of looping), and `OCC_CLEARING_LAG` encodes the
 * OCC's next-business-day 09:00 ET publication. DST is handled by resolving
 * through the IANA zone, not a hardcoded offset.
 */
export function occClearingWindow(now: Date = new Date()): {
  effectiveDate: string;
  availableAt: string;
  delaySeconds: number;
} {
  // Cleared volume published now describes the previous completed session.
  const effectiveDate = previousTradingDay(currentEtDate(now));
  const availableAt = OCC_CLEARING_LAG.availableAtFor(effectiveDate);
  // Age is measured from that session's 16:00 ET close — the moment the
  // activity being reported actually finished.
  const sessionClose = Date.parse(etTimeOnDate(effectiveDate, 16, 0));
  return {
    effectiveDate,
    availableAt,
    delaySeconds: Math.max(0, Math.round((now.getTime() - sessionClose) / 1000)),
  };
}

let latest: OccVolume | null = null;

export function getOccVolume(): OccVolume | null {
  return latest;
}

export async function fetchOccVolume(): Promise<OccVolume | null> {
  const { data } = await axios.get('https://marketdata.theocc.com/mdapi/volume-totals', {
    timeout: 10_000,
  });
  const e = data?.entity;

  // The one field that must parse for the record to mean anything. Without it
  // there is no volume total, so return null rather than a shell of nulls that
  // a caller might mistake for a successful fetch.
  const optionsVolume = num(e?.optionsVolume);
  if (optionsVolume === null) return null;

  const monthlyDailyAverage = num(e.monthlyDailyAverage);
  const window = occClearingWindow();

  latest = {
    totalVolume: num(e.totalVolume),
    optionsVolume,
    futuresVolume: num(e.futuresVolume),
    fiftyTwoWeekHigh: num(e.fiftytwo_week_high),
    fiftyTwoWeekLow: num(e.fiftytwo_week_low),
    monthlyDailyAverage,
    yearlyDailyAverage: num(e.yearlyDailyAverage),
    vsMonthlyAverage: ratio(optionsVolume, monthlyDailyAverage),
    fetchedAt: new Date().toISOString(),
    source: 'occ',
    effectiveDate: window.effectiveDate,
    availableAt: window.availableAt,
    provenance: upstreamProvenance({
      source: 'occ',
      // The OCC is the clearing house, not a reseller — this is first-party
      // cleared data, which is why it is worth carrying despite the delay.
      source_type: 'exchange',
      is_delayed: true,
      // Derived from the trading calendar, so a Monday correctly reports ~72h
      // rather than the flat 24h this used to assert.
      estimated_delay_seconds: window.delaySeconds,
    }),
  };
  return latest;
}
