import { Router } from 'express';
import { getMacroData } from '../ingestion/connectors/fred';
import { getCBOEData } from '../ingestion/connectors/cboe';
import { getCryptoQuotes, getCryptoGlobal } from '../ingestion/connectors/coinGecko';
import { getStooqQuotes, type StooqQuote } from '../ingestion/connectors/stooq';
import { getSpotQuotes } from '../ingestion/connectors/twelveData';

const router = Router();

/**
 * The Stooq wire shape.
 *
 * The connector caches a daily OHLC bar — `open/high/low/close/volume/date`,
 * no `price` and no change. The macro page's `StooqQuote` interface declared
 * `{ symbol, price, change, changePct }`, none of which has ever existed on
 * the wire, so `q.price.toFixed(2)` would have thrown the moment real data
 * reached it. It never did, because the page read the data off the wrong
 * endpoint and then type-guarded it away.
 *
 * `sessionChange` is named for what it is: close against the *same* bar's
 * open. It is not the day-over-day change a "+0.21%" normally means, and the
 * connector's cache holds one bar, so calling it `change` would be a guess
 * dressed as a measurement.
 */
interface StooqWire {
  symbol: string;
  price: number;
  sessionChange: number;
  sessionChangePct: number;
  date: string;
  source: 'stooq';
}

function toWire(q: StooqQuote): StooqWire {
  return {
    symbol: q.symbol,
    price: q.close,
    sessionChange: q.close - q.open,
    sessionChangePct: q.open > 0 ? ((q.close - q.open) / q.open) * 100 : 0,
    date: q.date,
    source: 'stooq',
  };
}

// GET /api/macro — all macro data (FRED + CBOE + Stooq)
router.get('/', (_req, res) => {
  const cboe = getCBOEData();
  const macro = getMacroData();
  const stooq = Array.from(getStooqQuotes().values()).map(toWire);

  res.json({
    cboe,
    fred: macro,
    futures: stooq.filter(q => ['GOLD', 'SILVER', 'OIL', 'NATGAS', 'DXY'].includes(q.symbol)),
    indices: stooq.filter(q => ['SPX', 'NDX', 'DJIA', 'VIX'].includes(q.symbol)),
    yields: stooq.filter(q => ['TNX', 'FVX', 'TYX'].includes(q.symbol)),
    updatedAt: new Date().toISOString(),
  });
});

// GET /api/macro/vix — VIX term structure
router.get('/vix', (_req, res) => {
  const cboe = getCBOEData();
  // 503, not a 200 carrying an `error` key. A caller that checks the status
  // code was being told the request succeeded.
  if (!cboe) {
    return res.status(503).json({ error: 'VIX data not yet loaded' });
  }
  res.json({
    vix: cboe.vix,
    vix9d: cboe.vix9d,
    vix3m: cboe.vix3m,
    vix6m: cboe.vix6m,
    vix1y: cboe.vix1y,
    // Published for the first time here: the connector fetches VXN from Cboe,
    // and the macro page has had a `vxn` field rendering a permanent "—"
    // because nothing ever sent it.
    vxn: cboe.vxn,
    // The put/call ratios the panel displays. Null when Cboe's statistics
    // endpoint refuses, and null is not 0 — see `CBOEData`.
    putCallRatioEquity: cboe.putCallRatioEquity,
    putCallRatioIndex: cboe.putCallRatioIndex,
    ...(cboe.putCallUnavailable ? { putCallUnavailable: cboe.putCallUnavailable } : {}),
    // Derived, never asserted. This was a hardcoded `'contango'` string; it is
    // now computed from the two tenors above and is `null` when either is
    // missing, so a Cboe outage yields no label rather than a stale default.
    termStructure: classifyTermStructure(cboe.vix, cboe.vix3m),
    updatedAt: cboe.updatedAt,
  });
});

// GET /api/macro/pcr — put/call ratios
router.get('/pcr', (_req, res) => {
  const cboe = getCBOEData();
  res.json(cboe ?? { error: 'CBOE data not yet loaded' });
});

// GET /api/macro/crypto — crypto market data
router.get('/crypto', (_req, res) => {
  const quotes = Array.from(getCryptoQuotes().values());
  const global = getCryptoGlobal();
  res.json({ quotes, global });
});

// GET /api/macro/quotes — spot prices from TwelveData
//
// The Yahoo half of this merge is gone. That connector is refused by the
// rights gate and never starts, so `getYahooQuotes()` returned an empty Map
// and the merge was a no-op over a source the backend has committed to not
// contacting. Importing it here kept a live reference to data we do not take.
router.get('/quotes', (_req, res) => {
  const quotes = Array.from(getSpotQuotes().values());
  res.json({ quotes });
});

export default router;

/**
 * The VIX term structure, derived from the two tenors beside it.
 *
 * `termStructure: 'contango'` used to sit on this payload as a string
 * constant — a regime label asserted as fact regardless of the curve it was
 * printed next to, so it read "contango" during a genuine backwardation,
 * which is precisely when the claim matters. It was removed rather than
 * derived, on the correct grounds that inventing it was the bug. This derives
 * it, which is what makes it publishable again: `null` whenever either leg is
 * missing, so an outage produces no label rather than a default one.
 */
export function classifyTermStructure(
  front: number | null,
  back: number | null,
): 'contango' | 'backwardation' | 'flat' | null {
  if (front === null || back === null || front <= 0 || back <= 0) return null;
  const spread = back - front;
  // Within 1% of front vol reads as flat rather than a directional claim.
  if (Math.abs(spread) < front * 0.01) return 'flat';
  return spread > 0 ? 'contango' : 'backwardation';
}
