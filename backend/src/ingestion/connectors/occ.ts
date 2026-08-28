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

export interface OccVolume {
  totalVolume: number;
  optionsVolume: number;
  futuresVolume: number;
  fiftyTwoWeekHigh: number;
  fiftyTwoWeekLow: number;
  monthlyDailyAverage: number;
  yearlyDailyAverage: number;
  /** Today's options volume as a multiple of the trailing monthly average. */
  vsMonthlyAverage: number;
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

  const monthlyAvg = Number(e.monthlyDailyAverage) || 0;
  latest = {
    totalVolume: Number(e.totalVolume) || 0,
    optionsVolume: Number(e.optionsVolume) || 0,
    futuresVolume: Number(e.futuresVolume) || 0,
    fiftyTwoWeekHigh: Number(e.fiftytwo_week_high) || 0,
    fiftyTwoWeekLow: Number(e.fiftytwo_week_low) || 0,
    monthlyDailyAverage: monthlyAvg,
    yearlyDailyAverage: Number(e.yearlyDailyAverage) || 0,
    vsMonthlyAverage: monthlyAvg > 0 ? Number(e.optionsVolume) / monthlyAvg : 0,
    fetchedAt: new Date().toISOString(),
    source: 'occ',
  };
  return latest;
}
