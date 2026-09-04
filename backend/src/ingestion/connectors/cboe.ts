/**
 * CBOE — VIX, Put/Call Ratio, daily options volume
 * No API key required — public endpoints
 * Docs: https://www.cboe.com/us/options/market_statistics/
 */
import axios from 'axios';
import { describeHttpError } from '../httpError';
import { numeric } from '../optionalNumber';

export interface CBOEData {
  vix: number;
  vix9d: number;
  vix3m: number;
  vix6m: number;
  vix1y: number;
  /** Nasdaq-100 volatility. Cboe publishes it; the Yahoo path never fetched it. */
  vxn: number;
  /**
   * Put/call ratios and volumes, or `null` when the statistics endpoint did
   * not answer.
   *
   * Nullable rather than 0. Cboe's `options_volume.json` now returns HTTP 403,
   * `fetchPutCallRatios` swallowed it in a bare `catch` and returned `{}`, and
   * `fetchAll` filled every field with `?? 0` — so the terminal displayed an
   * equity put/call ratio of 0.00, coloured green for "bullish", sourced from
   * a request that was denied. A ratio of zero is a reading; absence is not,
   * and the two have to be tellable apart on the wire.
   */
  putCallRatioEquity: number | null;
  putCallRatioIndex: number | null;
  putCallRatioTotal: number | null;
  equityCallVolume: number | null;
  equityPutVolume: number | null;
  indexCallVolume: number | null;
  indexPutVolume: number | null;
  totalOptionsVolume: number | null;
  /** Why the put/call block is null. Absent when it is populated. */
  putCallUnavailable?: string;
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

interface PutCallValues {
  putCallRatioEquity: number;
  putCallRatioIndex: number;
  putCallRatioTotal: number;
  equityCallVolume: number;
  equityPutVolume: number;
  indexCallVolume: number;
  indexPutVolume: number;
  totalOptionsVolume: number;
}

/** Either the block or the reason there isn't one. Never a silent `{}`. */
type PutCallBlock =
  | { ok: true; values: PutCallValues }
  | { ok: false; reason: string };

async function fetchPutCallRatios(): Promise<PutCallBlock> {
  try {
    const { data } = await axios.get(PCR_URL, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 8000,
    });

    const today = data?.data?.[0];
    if (!today) {
      return { ok: false, reason: 'options_volume.json returned no rows.' };
    }

    // Each field parsed on its own terms. The outer failure was handled, but
    // a *present* row missing a field fell to `parseFloat(undefined ?? 0)` —
    // which is 0 — inside an `ok: true` block. That is the defect this file's
    // own header describes, surviving at field granularity: a put/call ratio
    // of 0.00, coloured green, from a response that simply did not carry one.
    const ratios = {
      putCallRatioEquity: numeric(today.equity_put_call_ratio),
      putCallRatioIndex: numeric(today.index_put_call_ratio),
      putCallRatioTotal: numeric(today.total_put_call_ratio),
    };
    const missing = Object.entries(ratios)
      .filter(([, v]) => v === null)
      .map(([k]) => k);
    if (missing.length > 0) {
      return {
        ok: false,
        reason: `options_volume.json carried no ${missing.join(', ')}.`,
      };
    }

    return { ok: true, values: {
      putCallRatioEquity: ratios.putCallRatioEquity!,
      putCallRatioIndex: ratios.putCallRatioIndex!,
      putCallRatioTotal: ratios.putCallRatioTotal!,
      equityCallVolume: numeric(today.equity_call_volume) ?? 0,
      equityPutVolume: numeric(today.equity_put_volume) ?? 0,
      indexCallVolume: numeric(today.index_call_volume) ?? 0,
      indexPutVolume: numeric(today.index_put_volume) ?? 0,
      totalOptionsVolume: numeric(today.total_volume) ?? 0,
    } };
  } catch (err: any) {
    // Reported, not swallowed. This is currently a 403, and for a long time it
    // was rendered as a put/call ratio of 0.00.
    return { ok: false, reason: describeHttpError(err) };
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
      ...(pcr.ok
        ? pcr.values
        : {
            putCallRatioEquity: null, putCallRatioIndex: null, putCallRatioTotal: null,
            equityCallVolume: null, equityPutVolume: null, indexCallVolume: null,
            indexPutVolume: null, totalOptionsVolume: null,
            putCallUnavailable: pcr.reason,
          }),
      updatedAt: new Date().toISOString(),
      source: 'cboe',
    };

    onCBOEUpdate?.(cboeData);
    console.log(
      `[cboe] Updated — VIX: ${cboeData.vix.toFixed(2)} | P/C Ratio: ` +
      (cboeData.putCallRatioTotal != null
        ? cboeData.putCallRatioTotal.toFixed(2)
        : `unavailable (${cboeData.putCallUnavailable})`),
    );
  } catch (err: any) {
    console.error('[cboe] fetch error:', err.message);
  }
}

export async function startCBOE(): Promise<void> {
  await fetchAll();
  // See the note in stooq.ts: the listener keeps the server alive, not this.
  setInterval(fetchAll, 5 * 60_000).unref(); // every 5 min
  console.log('[cboe] Started — VIX + put/call ratios (no key required)');
}
