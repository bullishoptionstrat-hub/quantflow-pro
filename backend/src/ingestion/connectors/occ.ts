/**
 * OCC (Options Clearing Corporation) — market-wide cleared options volume.
 * No API key required.
 *
 * Every listed US option clears through the OCC, so this is the authoritative
 * total rather than one venue's share. Useful as the denominator when judging
 * whether a day's single-name activity is actually outsized.
 *
 * Docs: https://marketdata.theocc.com/
 */
import axios from 'axios';
import { num } from '../optionalNumber';

/**
 * Every figure is nullable, and every one of them used to be `Number(x) || 0`.
 *
 * This payload is served on `/api/health`, which is **unauthenticated** by
 * design (`render.yaml` sets it as the health check path), so a zero here is a
 * market-wide claim published to anyone. "The options market cleared zero
 * contracts today" is a statement; "the OCC response did not carry that field"
 * is not, and `|| 0` erased the difference for all seven.
 *
 * `Number(undefined) || 0` and `Number(null) || 0` are both `0`, so a schema
 * change at the OCC — a renamed key, a field dropped from the free feed —
 * would have published a zeroed market rather than failing visibly.
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
   * Today's options volume as a multiple of the trailing monthly average, or
   * `null` when either side of that division is unknown.
   *
   * It was `monthlyAvg > 0 ? optionsVolume / monthlyAvg : 0` — so an OCC
   * response with no monthly average published **0.00x**, which reads as
   * "today is a dead session" and is the strongest claim on this payload. The
   * same shape as the Cboe put/call ratio that reported 0.00 from a denied
   * request, and the reason that one is nullable now too.
   */
  vsMonthlyAverage: number | null;
  fetchedAt: string;
  source: 'occ';
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
  if (!e || typeof e.optionsVolume !== 'number') return null;

  const monthlyAvg = num(e.monthlyDailyAverage);
  const optionsVolume = num(e.optionsVolume);
  latest = {
    totalVolume: num(e.totalVolume),
    optionsVolume,
    futuresVolume: num(e.futuresVolume),
    fiftyTwoWeekHigh: num(e.fiftytwo_week_high),
    fiftyTwoWeekLow: num(e.fiftytwo_week_low),
    monthlyDailyAverage: monthlyAvg,
    yearlyDailyAverage: num(e.yearlyDailyAverage),
    // Null, not 0, when either side is unknown: a ratio computed against an
    // absent denominator is not a small ratio.
    vsMonthlyAverage: optionsVolume !== null && monthlyAvg !== null && monthlyAvg > 0
      ? optionsVolume / monthlyAvg
      : null,
    fetchedAt: new Date().toISOString(),
    source: 'occ',
  };
  return latest;
}
