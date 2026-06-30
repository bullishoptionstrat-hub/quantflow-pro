/**
 * CBOE — VIX, Put/Call Ratio, daily options volume
 * No API key required — public endpoints
 * Docs: https://www.cboe.com/us/options/market_statistics/
 */
import axios from 'axios';

export interface CBOEData {
  vix: number;
  vix9d: number;
  vix3m: number;
  vix6m: number;
  vix1y: number;
  putCallRatioEquity: number;
  putCallRatioIndex: number;
  putCallRatioTotal: number;
  equityCallVolume: number;
  equityPutVolume: number;
  indexCallVolume: number;
  indexPutVolume: number;
  totalOptionsVolume: number;
  updatedAt: string;
  source: 'cboe';
}

let cboeData: CBOEData | null = null;
let onCBOEUpdate: ((d: CBOEData) => void) | null = null;

export function onCBOEData(handler: (d: CBOEData) => void): void {
  onCBOEUpdate = handler;
}
export function getCBOEData(): CBOEData | null { return cboeData; }

// CBOE JSON endpoints (no auth required)
const VIX_URL = 'https://cdn.cboe.com/api/global/delayed_quotes/charts/historical/_VIX.json';
const PCR_URL = 'https://cdn.cboe.com/data/us/options/market_statistics/options_volume.json';

async function fetchVIX(): Promise<number> {
  try {
    const { data } = await axios.get(VIX_URL, { timeout: 8000 });
    const obs = data?.data;
    if (Array.isArray(obs) && obs.length > 0) {
      const latest = obs[obs.length - 1];
      return parseFloat(latest?.[4] ?? latest?.[1] ?? 0); // close price
    }
    return 0;
  } catch {
    return 0;
  }
}

// Alternative VIX from Yahoo Finance (no-auth fallback)
async function fetchVIXYahoo(): Promise<{ vix: number; vix9d: number; vix3m: number; vix6m: number; vix1y: number }> {
  const symbols = ['^VIX', '^VIX9D', '^VIX3M', '^VIX6M', '^VIX1Y'];
  const results: Record<string, number> = {};

  for (const sym of symbols) {
    try {
      const { data } = await axios.get(
        `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}`,
        {
          params: { interval: '1d', range: '1d' },
          headers: { 'User-Agent': 'Mozilla/5.0' },
          timeout: 5000,
        }
      );
      const price = data?.chart?.result?.[0]?.meta?.regularMarketPrice;
      if (price) results[sym] = parseFloat(price);
    } catch {}
  }

  return {
    vix: results['^VIX'] ?? 0,
    vix9d: results['^VIX9D'] ?? 0,
    vix3m: results['^VIX3M'] ?? 0,
    vix6m: results['^VIX6M'] ?? 0,
    vix1y: results['^VIX1Y'] ?? 0,
  };
}

async function fetchPutCallRatios(): Promise<Partial<CBOEData>> {
  try {
    const { data } = await axios.get(PCR_URL, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 8000,
    });

    const today = data?.data?.[0];
    if (!today) return {};

    return {
      putCallRatioEquity: parseFloat(today.equity_put_call_ratio ?? 0),
      putCallRatioIndex: parseFloat(today.index_put_call_ratio ?? 0),
      putCallRatioTotal: parseFloat(today.total_put_call_ratio ?? 0),
      equityCallVolume: parseInt(today.equity_call_volume ?? 0),
      equityPutVolume: parseInt(today.equity_put_volume ?? 0),
      indexCallVolume: parseInt(today.index_call_volume ?? 0),
      indexPutVolume: parseInt(today.index_put_volume ?? 0),
      totalOptionsVolume: parseInt(today.total_volume ?? 0),
    };
  } catch {
    return {};
  }
}

async function fetchAll(): Promise<void> {
  try {
    const [vixData, pcr] = await Promise.all([
      fetchVIXYahoo(),
      fetchPutCallRatios(),
    ]);

    cboeData = {
      vix: vixData.vix,
      vix9d: vixData.vix9d,
      vix3m: vixData.vix3m,
      vix6m: vixData.vix6m,
      vix1y: vixData.vix1y,
      putCallRatioEquity: pcr.putCallRatioEquity ?? 0,
      putCallRatioIndex: pcr.putCallRatioIndex ?? 0,
      putCallRatioTotal: pcr.putCallRatioTotal ?? 0,
      equityCallVolume: pcr.equityCallVolume ?? 0,
      equityPutVolume: pcr.equityPutVolume ?? 0,
      indexCallVolume: pcr.indexCallVolume ?? 0,
      indexPutVolume: pcr.indexPutVolume ?? 0,
      totalOptionsVolume: pcr.totalOptionsVolume ?? 0,
      updatedAt: new Date().toISOString(),
      source: 'cboe',
    };

    onCBOEUpdate?.(cboeData);
    console.log(`[cboe] Updated — VIX: ${cboeData.vix.toFixed(2)} | P/C Ratio: ${cboeData.putCallRatioTotal.toFixed(2)}`);
  } catch (err: any) {
    console.error('[cboe] fetch error:', err.message);
  }
}

export async function startCBOE(): Promise<void> {
  await fetchAll();
  setInterval(fetchAll, 5 * 60_000); // every 5 min
  console.log('[cboe] Started — VIX + put/call ratios (no key required)');
}
