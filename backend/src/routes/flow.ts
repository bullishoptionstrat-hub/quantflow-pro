import { Router, Request, Response } from 'express';
import { queryInt, queryNonNegative, queryString } from './queryParams';
import { getRecentFlow, getFlowStats, getUnusualActivity, FlowEvent } from '../ingestion/index';

const router = Router();

// GET /api/flow/unusual — real (delayed) unusual options activity from CBOE
// chains, ranked by notional. Distinct from /api/flow, which is the live tape:
// this is a daily volume aggregate, so each row carries its own asOf and
// delayedMinutes rather than pretending to be real time.
router.get('/unusual', (req: Request, res: Response) => {
  const symbol = queryString(req.query.symbol)?.toUpperCase();
  const limit = queryInt(req.query.limit, 50, 1, 200);
  const rows = getUnusualActivity(symbol).slice(0, limit);
  res.json({
    contracts: rows,
    count: rows.length,
    source: 'cboe',
    realtime: false,
    note: 'Daily cumulative volume per contract, delayed ~15 minutes. Not a trade tape.',
  });
});

// GET /api/flow — paginated recent flow events
router.get('/', (req: Request, res: Response) => {
  const limit = queryInt(req.query.limit, 100, 1, 500);
  const page = queryInt(req.query.page, 1, 1, Number.MAX_SAFE_INTEGER);
  const symbol = queryString(req.query.symbol)?.toUpperCase() ?? '';
  const type = queryString(req.query.type)?.toUpperCase() ?? '';
  const sentiment = queryString(req.query.sentiment)?.toUpperCase() ?? '';
  const minPremium = queryNonNegative(req.query.minPremium, 0);
  const minHeat = queryNonNegative(req.query.minHeat, 0);
  const unusualOnly = req.query.unusualOnly === 'true';
  const side = queryString(req.query.side)?.toUpperCase() ?? '';

  let events: FlowEvent[] = getRecentFlow();

  // Filters
  if (symbol) events = events.filter((e) => e.underlying === symbol);
  if (type) events = events.filter((e) => e.order_type === type);
  if (sentiment) events = events.filter((e) => e.sentiment === sentiment);
  if (side) events = events.filter((e) => e.side === side);
  if (minPremium > 0) events = events.filter((e) => e.total_premium >= minPremium);
  if (minHeat > 0) events = events.filter((e) => e.heat_score >= minHeat);
  if (unusualOnly) events = events.filter((e) => e.is_unusual);

  const total = events.length;
  const offset = (page - 1) * limit;
  const items = events.slice(offset, offset + limit);

  res.json({
    data: items,
    pagination: {
      total,
      page,
      limit,
      pages: Math.ceil(total / limit),
    },
  });
});

// GET /api/flow/stats — aggregated statistics
router.get('/stats', (_req: Request, res: Response) => {
  res.json(getFlowStats());
});

// GET /api/flow/symbols — available symbols
router.get('/symbols', (_req: Request, res: Response) => {
  const events = getRecentFlow();
  const symbols = [...new Set(events.map((e) => e.underlying))].sort();
  res.json({ symbols });
});

export default router;
