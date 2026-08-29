/**
 * CBOE — VIX, Put/Call Ratio, daily options volume
 * No API key required — public endpoints
 * Docs: https://www.cboe.com/us/options/market_statistics/
 *
 * ─── THE ZERO-SENTINEL DEFECT THIS FILE USED TO HAVE ───────────────────────
 *
 * Every field here was `?? 0` on failure, in two layers: the fetchers caught
 * their errors and returned `{}` or `0`, and the assembler then applied `?? 0`
 * again. The put/call endpoint returns HTTP 403; the catch swallowed it; and
 * the UI rendered "P/C Ratio: 0.00" and "VIX: 0.00" as real, plottable market
 * data. The log line even said `[cboe] Updated`, so the failure was invisible.
 *
 * A put/call ratio of 0.00 is not a plausible market state — it means every
 * single option traded was a call. VIX 0.00 is impossible. Presenting either as
 * a number is worse than presenting nothing, because a reader cannot tell it
 * apart from a real reading.
 *
 * In financial infrastructure, absent data and zero are different facts. Every
 * numeric field below is therefore `number | null`, and `null` is the ONLY
 * value used for "we do not know". See packages/domain/src/result.ts for the
 * fuller DataResult<T> treatment this follows.
 */
import axios from 'axios';
import { num } from '../parseNumeric';

/**
 * `null` means "not retrieved", never "zero". Consumers MUST branch on null
 * rather than formatting the value — `.toFixed(2)` on a null is a loud crash,
 * which is the intended outcome versus silently printing 0.00.
 */
export interface CBOEData {
  vix: number | null;
  vix9d: number | null;
  vix3m: number | null;
  vix6m: number | null;
  vix1y: number | null;
  putCallRatioEquity: number | null;
  putCallRatioIndex: number | null;
  putCallRatioTotal: number | null;
  equityCallVolume: number | null;
  equityPutVolume: number | null;
  indexCallVolume: number | null;
  indexPutVolume: number | null;
  totalOptionsVolume: number | null;
  updatedAt: string;
  source: 'cboe';
  /** Which upstream fetches actually succeeded this cycle. */
  fetchStatus: {
    vix: 'ok' | 'failed';
    putCall: 'ok' | 'failed';
    /** Present when something failed — the reason, never swallowed. */
    note?: string;
  };
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

async function fetchVIX(): Promise<number | null> {
  try {
    const { data } = await axios.get(VIX_URL, { timeout: 8000 });
    const obs = data?.data;
    if (Array.isArray(obs) && obs.length > 0) {
      const latest = obs[obs.length - 1];
      return num(latest?.[4]) ?? num(latest?.[1]); // close price
    }
    return null; // endpoint answered but carried nothing — not "VIX is zero"
  } catch {
    return null;
  }
}

// Alternative VIX from Yahoo Finance (no-auth fallback)
async function fetchVIXYahoo(): Promise<{
  vix: number | null; vix9d: number | null; vix3m: number | null;
  vix6m: number | null; vix1y: number | null; failures: string[];
}> {
  const symbols = ['^VIX', '^VIX9D', '^VIX3M', '^VIX6M', '^VIX1Y'];
  const results: Record<string, number> = {};
  const failures: string[] = [];

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
      const price = num(data?.chart?.result?.[0]?.meta?.regularMarketPrice);
      if (price !== null) results[sym] = price;
      else failures.push(`${sym}: no price in payload`);
    } catch (err: any) {
      // Never swallow silently — a bare `catch {}` is how a dead source looks
      // healthy. Record it so fetchStatus can report the truth.
      failures.push(`${sym}: ${err?.response?.status ?? ''} ${err?.message ?? err}`.trim());
    }
  }

  return {
    vix: results['^VIX'] ?? null,
    vix9d: results['^VIX9D'] ?? null,
    vix3m: results['^VIX3M'] ?? null,
    vix6m: results['^VIX6M'] ?? null,
    vix1y: results['^VIX1Y'] ?? null,
    failures,
  };
}

async function fetchPutCallRatios(): Promise<Partial<CBOEData> & { error?: string }> {
  try {
    const { data } = await axios.get(PCR_URL, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 8000,
    });

    const today = data?.data?.[0];
    if (!today) return { error: 'put/call endpoint returned no rows' };

    return {
      putCallRatioEquity: num(today.equity_put_call_ratio),
      putCallRatioIndex: num(today.index_put_call_ratio),
      putCallRatioTotal: num(today.total_put_call_ratio),
      equityCallVolume: num(today.equity_call_volume),
      equityPutVolume: num(today.equity_put_volume),
      indexCallVolume: num(today.index_call_volume),
      indexPutVolume: num(today.index_put_volume),
      totalOptionsVolume: num(today.total_volume),
    };
  } catch (err: any) {
    // The real observed failure here is HTTP 403. It used to become 0.00.
    return { error: `${err?.response?.status ?? ''} ${err?.message ?? err}`.trim() };
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
      putCallRatioEquity: pcr.putCallRatioEquity ?? null,
      putCallRatioIndex: pcr.putCallRatioIndex ?? null,
      putCallRatioTotal: pcr.putCallRatioTotal ?? null,
      equityCallVolume: pcr.equityCallVolume ?? null,
      equityPutVolume: pcr.equityPutVolume ?? null,
      indexCallVolume: pcr.indexCallVolume ?? null,
      indexPutVolume: pcr.indexPutVolume ?? null,
      totalOptionsVolume: pcr.totalOptionsVolume ?? null,
      updatedAt: new Date().toISOString(),
      source: 'cboe',
      fetchStatus: {
        vix: vixData.vix === null ? 'failed' : 'ok',
        putCall: pcr.putCallRatioTotal === undefined || pcr.putCallRatioTotal === null
          ? 'failed' : 'ok',
        ...(vixData.failures.length || pcr.error
          ? { note: [...vixData.failures, pcr.error].filter(Boolean).join('; ') }
          : {}),
      },
    };

    onCBOEUpdate?.(cboeData);

    // The log must not claim success when nothing was retrieved. The previous
    // line called `.toFixed(2)` on values that were 0-on-failure and printed
    // "[cboe] Updated — VIX: 0.00 | P/C Ratio: 0.00" for a total outage.
    const fmt = (v: number | null) => (v === null ? 'unavailable' : v.toFixed(2));
    const { vix, putCall, note } = cboeData.fetchStatus;
    if (vix === 'failed' && putCall === 'failed') {
      console.error(`[cboe] FETCH FAILED — no data retrieved. ${note ?? ''}`.trim());
    } else {
      console.log(
        `[cboe] Updated — VIX: ${fmt(cboeData.vix)} | P/C Ratio: ${fmt(cboeData.putCallRatioTotal)}` +
        (note ? ` | partial: ${note}` : ''),
      );
    }
  } catch (err: any) {
    console.error('[cboe] fetch error:', err.message);
  }
}

export async function startCBOE(): Promise<void> {
  await fetchAll();
  setInterval(fetchAll, 5 * 60_000); // every 5 min
  console.log('[cboe] Started — VIX + put/call ratios (no key required)');
}

/**
 * Re-exported so `backend/test/cboeSentinel.test.ts` keeps testing the real
 * helper. The implementation moved to `ingestion/parseNumeric.ts` when occ.ts
 * needed the same rule (finding #27) — a second copy would have been a third
 * place for the sentinel to come back.
 */
export { num };
