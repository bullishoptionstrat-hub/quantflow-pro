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
  provenance: Provenance;
}

/**
 * Conservative floor for the clearing delay: one calendar day.
 *
 * DELIBERATELY NOT MEASURED, AND THAT IS A LIMITATION, NOT A FACT. The payload
 * this connector parses carries no effective/trade date that we read, so real
 * staleness cannot be computed — over a weekend or holiday the true lag is
 * closer to 72 hours. Guessing at a date field name would be exactly the kind
 * of invention this file exists to remove, so the constant is declared as a
 * floor and recorded in KNOWN_LIMITATIONS.md instead.
 */
const CLEARING_DELAY_SECONDS = 86_400;

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
    provenance: upstreamProvenance({
      source: 'occ',
      // The OCC is the clearing house, not a reseller — this is first-party
      // cleared data, which is why it is worth carrying despite the delay.
      source_type: 'exchange',
      is_delayed: true,
      estimated_delay_seconds: CLEARING_DELAY_SECONDS,
    }),
  };
  return latest;
}
