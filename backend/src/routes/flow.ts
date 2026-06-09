import { Router, Request, Response } from 'express';
import { getRecentFlow, getFlowStats, FlowEvent } from '../ingestion/index';

const router = Router();

// GET /api/flow — paginated recent flow events
router.get('/', (req: Request, res: Response) => {
  const limit = Math.min(parseInt(req.query.limit as string) || 100, 500);
  const page = Math.max(parseInt(req.query.page as string) || 1, 1);
  const symbol = (req.query.symbol as string)?.toUpperCase() || '';
  const type = (req.query.type as string)?.toUpperCase() || '';
  const sentiment = (req.query.sentiment as string)?.toLowerCase() || '';
  const minPremium = parseFloat(req.query.minPremium as string) || 0;
  const minHeat = parseFloat(req.query.minHeat as string) || 0;

  let events: FlowEvent[] = getRecentFlow();

  // Filters
  if (symbol) events = events.filter((e) => e.symbol === symbol);
  if (type) events = events.filter((e) => e.type === type);
  if (sentiment) events = events.filter((e) => e.sentiment === sentiment);
  if (minPremium > 0) events = events.filter((e) => e.premium >= minPremium);
  if (minHeat > 0) events = events.filter((e) => e.heatScore >= minHeat);

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
  const symbols = [...new Set(events.map((e) => e.symbol))].sort();
  res.json({ symbols });
});

export default router;
