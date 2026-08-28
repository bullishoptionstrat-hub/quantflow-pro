import { Router, Request, Response } from 'express';
import { getGEXLevels, getRealGexSymbols, GEXLevel } from '../ingestion/index';

const router = Router();

// GET /api/gex — gamma exposure levels for a symbol
router.get('/', (req: Request, res: Response) => {
  const symbol = ((req.query.symbol as string) || 'SPX').toUpperCase();
  const levels: GEXLevel[] = getGEXLevels(symbol);
  const isReal = getRealGexSymbols().includes(symbol);

  // Find gamma flip (where gex transitions from + to -)
  let flipStrike: number | null = null;
  for (let i = 0; i < levels.length - 1; i++) {
    if (levels[i].gex > 0 && levels[i + 1].gex < 0) {
      flipStrike = levels[i].strike;
      break;
    }
  }

  // Key levels
  const maxGEX = levels.reduce<GEXLevel | null>(
    (max, l) => (!max || l.gex > max.gex ? l : max),
    null
  );
  const minGEX = levels.reduce<GEXLevel | null>(
    (min, l) => (!min || l.gex < min.gex ? l : min),
    null
  );

  res.json({
    symbol,
    levels,
    flipStrike,
    keyLevels: {
      maxGEXStrike: maxGEX?.strike ?? null,
      maxGEX: maxGEX?.gex ?? null,
      minGEXStrike: minGEX?.strike ?? null,
      minGEX: minGEX?.gex ?? null,
    },
    updatedAt: new Date().toISOString(),
    // Whether these levels came from a real CBOE chain (per-contract gamma and
    // open interest) or the synthetic fallback. The UI must be able to tell
    // them apart — a fabricated gamma flip looks exactly like a real one.
    source: isReal ? 'cboe' : 'synthetic',
    realData: isReal,
    realtime: false,
    delayedMinutes: isReal ? 15 : null,
  });
});

// GET /api/gex/symbols — available GEX symbols
router.get('/symbols', (_req: Request, res: Response) => {
  res.json({ symbols: ['SPX', 'SPY', 'QQQ', 'NDX', 'AAPL', 'TSLA', 'NVDA', 'MSFT'] });
});

export default router;
