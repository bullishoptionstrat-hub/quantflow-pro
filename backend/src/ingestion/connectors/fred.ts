/**
 * FRED (Federal Reserve Economic Data) — Macro indicators
 * Free API key: unlimited requests, 500K+ series
 * Key series: VIX, PCR, Yield Curve, CPI, Fed Funds Rate, GDP
 * Docs: https://fred.stlouisfed.org/docs/api/fred/
 */
import axios from 'axios';

const API_KEY = process.env.FRED_API_KEY || '';
const BASE = 'https://api.stlouisfed.org/fred/series/observations';

export interface FREDSeries {
  seriesId: string;
  name: string;
  value: number;
  previousValue: number;
  change: number;
  changePct: number;
  date: string;
  units: string;
  source: 'fred';
}

// Key series for options flow context
const SERIES: Record<string, { name: string; units: string }> = {
  'VIXCLS':     { name: 'CBOE VIX',                 units: 'Index' },
  'DGS10':      { name: '10Y Treasury Yield',        units: '%' },
  'DGS2':       { name: '2Y Treasury Yield',         units: '%' },
  'T10Y2Y':     { name: '10Y-2Y Spread (Yield Curve)', units: '%' },
  'FEDFUNDS':   { name: 'Fed Funds Rate',            units: '%' },
  'CPIAUCSL':   { name: 'CPI YoY',                  units: '%' },
  'UNRATE':     { name: 'Unemployment Rate',         units: '%' },
  'GDP':        { name: 'US GDP (Quarterly)',        units: 'Billions' },
  'DCOILWTICO': { name: 'WTI Crude Oil',             units: 'USD/bbl' },
  'GOLDAMGBD228NLBM': { name: 'Gold Price (London Fix)', units: 'USD/troy oz' },
};

const macroCache = new Map<string, FREDSeries>();
let onMacroUpdate: ((s: FREDSeries) => void) | null = null;

export function onFREDUpdate(handler: (s: FREDSeries) => void): void {
  onMacroUpdate = handler;
}
export function getMacroData(): FREDSeries[] {
  return Array.from(macroCache.values());
}
export function getMacroValue(seriesId: string): number {
  return macroCache.get(seriesId)?.value ?? 0;
}

async function fetchSeries(seriesId: string): Promise<void> {
  try {
    const { data } = await axios.get(BASE, {
      params: {
        series_id: seriesId,
        api_key: API_KEY,
        file_type: 'json',
        sort_order: 'desc',
        limit: 5, // get last 5 observations for change calc
      },
      timeout: 8000,
    });

    const obs = data?.observations?.filter((o: any) => o.value !== '.') ?? [];
    if (obs.length < 1) return;

    const latest = parseFloat(obs[0].value);
    const prev = obs.length > 1 ? parseFloat(obs[1].value) : latest;
    const change = latest - prev;
    const meta = SERIES[seriesId];

    const series: FREDSeries = {
      seriesId,
      name: meta?.name ?? seriesId,
      value: latest,
      previousValue: prev,
      change: parseFloat(change.toFixed(4)),
      changePct: prev !== 0 ? parseFloat(((change / prev) * 100).toFixed(3)) : 0,
      date: obs[0].date,
      units: meta?.units ?? '',
      source: 'fred',
    };

    macroCache.set(seriesId, series);
    onMacroUpdate?.(series);
  } catch (err: any) {
    if (err.response?.status !== 429) {
      console.error(`[fred] ${seriesId} error:`, err.message);
    }
  }
}

async function fetchAll(): Promise<void> {
  const seriesIds = Object.keys(SERIES);
  for (let i = 0; i < seriesIds.length; i++) {
    await fetchSeries(seriesIds[i]);
    await new Promise(r => setTimeout(r, 500)); // 500ms between requests
  }
}

export async function startFRED(): Promise<void> {
  if (!API_KEY) {
    console.log('[fred] No key — skipped. Get free key: https://fred.stlouisfed.org/docs/api/api_key.html');
    return;
  }

  await fetchAll();

  // FRED data updates daily — refresh every 4 hours
  setInterval(fetchAll, 4 * 60 * 60_000);
  console.log('[fred] Started — VIX, yields, CPI, GDP, oil, gold loaded');
}
