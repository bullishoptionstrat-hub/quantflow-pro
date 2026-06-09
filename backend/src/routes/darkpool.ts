import { Router, Request, Response } from 'express';
import { getDarkPoolPrints, DarkPoolPrint } from '../ingestion/index';

const router = Router();

// GET /api/darkpool — paginated dark pool prints (24-hour delay)
router.get('/', (req: Request, res: Response) => {
  const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
  const symbol = (req.query.symbol as string)?.toUpperCase() || '';
  const minSize = parseFloat(req.query.minSize as string) || 0;

  let prints: DarkPoolPrint[] = getDarkPoolPrints();

  if (symbol) prints = prints.filter((p) => p.symbol === symbol);
  if (minSize > 0) prints = prints.filter((p) => p.size >= minSize);

  const items = prints.slice(0, limit);

  res.json({
    data: items,
    total: items.length,
    notice: 'Dark pool data is delayed by approximately 24 hours per regulatory requirements.',
    disclaimer: 'Dark pool prints are informational only and do not constitute investment advice.',
  });
});

// GET /api/darkpool/summary — aggregate stats by symbol
router.get('/summary', (_req: Request, res: Response) => {
  const prints = getDarkPoolPrints();

  const bySymbol = prints.reduce<
    Record<string, { count: number; totalValue: number; avgSize: number }>
  >((acc, p) => {
    if (!acc[p.symbol]) acc[p.symbol] = { count: 0, totalValue: 0, avgSize: 0 };
    acc[p.symbol].count++;
    acc[p.symbol].totalValue += p.price * p.size;
    acc[p.symbol].avgSize = Math.round(acc[p.symbol].totalValue / acc[p.symbol].count);
    return acc;
  }, {});

  res.json({
    summary: Object.entries(bySymbol)
      .map(([symbol, stats]) => ({ symbol, ...stats }))
      .sort((a, b) => b.totalValue - a.totalValue),
  });
});

export default router;
