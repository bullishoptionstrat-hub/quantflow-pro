import { Router } from 'express';
import { getMacroData } from '../ingestion/connectors/fred';
import { getCBOEData } from '../ingestion/connectors/cboe';
import { getCryptoQuotes, getCryptoGlobal } from '../ingestion/connectors/coinGecko';
import { getStooqQuotes } from '../ingestion/connectors/stooq';
import { getYahooQuotes } from '../ingestion/connectors/yahoo';
import { getSpotQuotes } from '../ingestion/connectors/twelveData';

const router = Router();

// GET /api/macro — all macro data (FRED + CBOE + Stooq)
router.get('/', (_req, res) => {
  const cboe = getCBOEData();
  const macro = getMacroData();
  const stooq = Array.from(getStooqQuotes().values());

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
  if (!cboe) return res.json({ error: 'VIX data not yet loaded' });
  res.json({
    vix: cboe.vix,
    vix9d: cboe.vix9d,
    vix3m: cboe.vix3m,
    vix6m: cboe.vix6m,
    vix1y: cboe.vix1y,
    termStructure: 'contango',
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

// GET /api/macro/quotes — real-time spot prices across all sources
router.get('/quotes', (_req, res) => {
  const yahoo = Array.from(getYahooQuotes().values());
  const twelve = Array.from(getSpotQuotes().values());

  // Merge — prefer Twelve Data (more real-time) over Yahoo
  const merged: Record<string, any> = {};
  yahoo.forEach(q => { merged[q.symbol] = q; });
  twelve.forEach(q => { merged[q.symbol] = { ...merged[q.symbol], ...q }; });

  res.json({ quotes: Object.values(merged) });
});

export default router;
