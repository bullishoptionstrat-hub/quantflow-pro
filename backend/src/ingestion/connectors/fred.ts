/**
 * FRED (Federal Reserve Economic Data) — Macro indicators
 * Free API key: unlimited requests, 500K+ series
 * Key series: VIX, PCR, Yield Curve, CPI, Fed Funds Rate, GDP
 * Docs: https://fred.stlouisfed.org/docs/api/fred/
 */
import axios from 'axios';
import { describeHttpError, redactSecrets } from '../httpError';

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

/** Health of the last fetch cycle, reported to /api/health via `onFREDHealth`. */
export interface FREDHealth {
  ok: boolean;
  /**
   * The source is contributing, but not everything it was asked for arrived.
   *
   * A few series failing is a per-series problem — one of FRED's series was
   * discontinued upstream, say — and the other nine still fill the panel.
   * Reporting that as `error` sends an operator hunting a key problem that
   * does not exist, which is the mirror image of reporting a dead source as
   * `connected`.
   */
  degraded?: boolean;
  /** Operator-facing, and public: this reaches the unauthenticated /api/health. */
  reason?: string;
}

let onHealth: ((h: FREDHealth) => void) | null = null;

export function onFREDUpdate(handler: (s: FREDSeries) => void): void {
  onMacroUpdate = handler;
}
export function onFREDHealth(handler: (h: FREDHealth) => void): void {
  onHealth = handler;
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
    if (obs.length < 1) {
      throw new Error(`${seriesId}: no usable observations in the response.`);
    }

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
    // Re-thrown so the cycle can count it. It used to be logged and dropped,
    // which meant a key FRED rejects produced ten 400s, an empty macro panel,
    // and `connected` on /api/health — the same shape as the Stooq and Cboe
    // failures: a source that is down presenting itself as fine.
    //
    // `describeHttpError` rather than `err.message`: this connector passes its
    // key as a query parameter (FRED accepts it no other way), and FRED echoes
    // the request URL in some error bodies. The scrubber is what keeps the key
    // out of a public health response and out of the logs.
    throw err?.response
      ? new Error(`${seriesId}: ${describeHttpError(err)}`)
      : new Error(redactSecrets(`${seriesId}: ${err?.message ?? 'fetch failed'}`));
  }
}

async function fetchAll(): Promise<void> {
  const seriesIds = Object.keys(SERIES);
  const failures: string[] = [];

  for (let i = 0; i < seriesIds.length; i++) {
    try {
      await fetchSeries(seriesIds[i]!);
    } catch (err: any) {
      failures.push(err?.message ?? String(err));
    }
    await new Promise(r => setTimeout(r, 500)); // 500ms between requests
  }

  if (failures.length === 0) {
    onHealth?.({ ok: true });
    return;
  }

  // Every series failing is one cause, not ten — almost always a rejected key.
  // A few failing is a per-series problem and the rest of the panel is fine,
  // so the source is still contributing and says what is missing rather than
  // reporting itself broken.
  const allFailed = failures.length === seriesIds.length;
  onHealth?.({
    ok: !allFailed,
    degraded: !allFailed,
    reason:
      `${failures.length}/${seriesIds.length} series failed. ${failures[0]}` +
      (failures.length > 1 ? ` (+${failures.length - 1} more)` : '') +
      (allFailed ? ' Every series failed, which usually means FRED_API_KEY is not accepted.' : ''),
  });
}

export async function startFRED(): Promise<void> {
  if (!API_KEY) {
    console.log('[fred] No key — skipped. Get free key: https://fred.stlouisfed.org/docs/api/api_key.html');
    return;
  }

  await fetchAll();

  // FRED data updates daily — refresh every 4 hours. `unref`'d so a poll timer
  // is never the reason a process cannot exit; the server is held open by its
  // HTTP listener.
  setInterval(fetchAll, 4 * 60 * 60_000).unref();
  console.log('[fred] Started — VIX, yields, CPI, GDP, oil, gold loaded');
}
