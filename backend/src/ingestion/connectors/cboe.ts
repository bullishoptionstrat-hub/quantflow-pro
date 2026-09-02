/**
 * CBOE — VIX, Put/Call Ratio, daily options volume
 * No API key required — public endpoints
 * Docs: https://www.cboe.com/us/options/market_statistics/
 */
import axios from 'axios';
import { describeHttpError } from '../httpError';
import { num } from '../parseNumeric';

export interface CBOEData {
  /**
   * The VIX term structure. `null` for any tenor Cboe did not return — never
   * 0, which is a well-formed reading and would render as a real number.
   */
  vix: number | null;
  vix9d: number | null;
  vix3m: number | null;
  vix6m: number | null;
  vix1y: number | null;
  /** Nasdaq-100 volatility. Cboe publishes it; the Yahoo path never fetched it. */
  vxn: number | null;
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

type VixTerms = Record<keyof typeof VIX_SYMBOLS, number | null>;

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
 * A tenor that fails or returns a non-positive price is `null`, not 0. Zero was
 * the previous answer, with the renderer expected to know it meant "no data" —
 * but 0 is a well-formed VIX reading at the type level, so nothing downstream
 * could tell a dead feed from a calm one except by convention.
 */
async function fetchVixTerms(): Promise<VixTerms> {
  const entries = Object.entries(VIX_SYMBOLS) as [keyof VixTerms, string][];

  const settled = await Promise.all(entries.map(async ([key, symbol]) => {
    try {
      const { data } = await axios.get(QUOTE_URL(symbol), { timeout: 8000 });
      const px = num(data?.data?.current_price);
      return [key, px !== null && px > 0 ? px : null] as const;
    } catch (err: any) {
      // Never swallow, and never fabricate. This returned 0 on failure, so a
      // Cboe outage rendered "VIX 0.00" — a number no market has ever printed,
      // displayed with the same authority as a real one. null is the honest
      // answer and the panel formats it as unavailable.
      console.error(`[cboe] ${symbol} quote failed: ${describeHttpError(err)}`);
      return [key, null] as const;
    }
  }));

  return Object.fromEntries(settled) as VixTerms;
}

interface PutCallValues {
  // `number | null` per field, not just per block. Cboe answering while
  // omitting one ratio is absence of that ratio; `0` would be a reading.
  putCallRatioEquity: number | null;
  putCallRatioIndex: number | null;
  putCallRatioTotal: number | null;
  equityCallVolume: number | null;
  equityPutVolume: number | null;
  indexCallVolume: number | null;
  indexPutVolume: number | null;
  totalOptionsVolume: number | null;
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

    return { ok: true, values: {
      // `num()` rather than parseFloat/parseInt with `?? 0`. The block is
      // nullable precisely so absence is distinguishable from a reading, and
      // `?? 0` reintroduces the confusion one field at a time: a missing
      // equity ratio would land as 0.00 — a real, bullish-looking value — in
      // a payload that otherwise reports absence honestly. parseFloat is also
      // a prefix parser, so an error string like "403 Forbidden" reads as 403.
      putCallRatioEquity: num(today.equity_put_call_ratio),
      putCallRatioIndex: num(today.index_put_call_ratio),
      putCallRatioTotal: num(today.total_put_call_ratio),
      equityCallVolume: num(today.equity_call_volume),
      equityPutVolume: num(today.equity_put_volume),
      indexCallVolume: num(today.index_call_volume),
      indexPutVolume: num(today.index_put_volume),
      totalOptionsVolume: num(today.total_volume),
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
      `[cboe] Updated — VIX: ${cboeData.vix?.toFixed(2) ?? 'unavailable'} | P/C Ratio: ` +
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
