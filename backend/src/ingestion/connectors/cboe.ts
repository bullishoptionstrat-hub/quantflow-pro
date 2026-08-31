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
  /** Nasdaq-100 volatility. Cboe publishes it; the Yahoo path never fetched it. */
  vxn: number;
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

// CBOE JSON endpoints (no auth required), all on cdn.cboe.com.
//
// The delayed *quote* endpoint, not the historical chart. The chart JSON for
// _VIX is ~1.1MB of daily bars back to 1990 and its most recent row is the
// previous session's close; the quote is ~500 bytes and carries the current
// delayed print. Six of them is about 3KB per poll, which matters on a 512MB
// free-tier host.
const QUOTE_URL = (symbol: string) =>
  `https://cdn.cboe.com/api/global/delayed_quotes/quotes/${symbol}.json`;
const PCR_URL = 'https://cdn.cboe.com/data/us/options/market_statistics/options_volume.json';

/** Cboe index symbols, in the order the term structure is read. */
const VIX_SYMBOLS = {
  vix: '_VIX',
  vix9d: '_VIX9D',
  vix3m: '_VIX3M',
  vix6m: '_VIX6M',
  vix1y: '_VIX1Y',
  vxn: '_VXN',
} as const;

type VixTerms = Record<keyof typeof VIX_SYMBOLS, number>;

/**
 * The VIX term structure, from Cboe.
 *
 * This used to be `fetchVIXYahoo`, and it fetched all five tenors from Yahoo's
 * chart API — the one publisher the rights registry classifies PROHIBITED for
 * display in *both* business modes, quoting Yahoo's own terms. The connector
 * gate refuses `startYahoo`, but this path is inside `startCBOE` and reached
 * Yahoo anyway, five requests every five minutes, under a dataset id that
 * records `cdn.cboe.com` as its host. A gate keyed on connector names cannot
 * see a connector that dials a prohibited host, which is why
 * `test/prohibitedHosts.test.ts` now reads the hosts out of the registry and
 * checks them against the code (comments stripped — a comment issues no
 * requests, and the note you are reading has to be allowed to exist).
 *
 * Cboe publishes every one of these tenors itself, plus VXN, which the Yahoo
 * path never fetched at all. There was nothing to trade away.
 *
 * A tenor that fails or returns a non-positive price stays 0 and is rendered
 * as unavailable rather than as a reading of zero.
 */
async function fetchVixTerms(): Promise<VixTerms> {
  const entries = Object.entries(VIX_SYMBOLS) as [keyof VixTerms, string][];

  const settled = await Promise.all(entries.map(async ([key, symbol]) => {
    try {
      const { data } = await axios.get(QUOTE_URL(symbol), { timeout: 8000 });
      const px = Number(data?.data?.current_price);
      return [key, Number.isFinite(px) && px > 0 ? px : 0] as const;
    } catch {
      return [key, 0] as const;
    }
  }));

  return Object.fromEntries(settled) as VixTerms;
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
      fetchVixTerms(),
      fetchPutCallRatios(),
    ]);

    cboeData = {
      vix: vixData.vix,
      vix9d: vixData.vix9d,
      vix3m: vixData.vix3m,
      vix6m: vixData.vix6m,
      vix1y: vixData.vix1y,
      vxn: vixData.vxn,
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
