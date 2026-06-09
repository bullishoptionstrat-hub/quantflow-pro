import { Router, Request, Response } from 'express';
import axios from 'axios';

const router = Router();

const TRADIER_TOKEN = process.env.TRADIER_TOKEN || '';
const TRADIER_BASE = 'https://api.tradier.com/v1';

// GET /api/chain?symbol=SPY&expiration=2025-01-17
router.get('/', async (req: Request, res: Response) => {
  const symbol = ((req.query.symbol as string) || 'SPY').toUpperCase();
  const expiration = (req.query.expiration as string) || '';

  if (!TRADIER_TOKEN) {
    // Return mock chain if no token
    return res.json(buildMockChain(symbol, expiration));
  }

  try {
    const url = `${TRADIER_BASE}/markets/options/chains`;
    const { data } = await axios.get(url, {
      headers: { Authorization: `Bearer ${TRADIER_TOKEN}`, Accept: 'application/json' },
      params: { symbol, expiration, greeks: 'true' },
      timeout: 8000,
    });

    const options = data?.options?.option ?? [];
    const calls = options.filter((o: any) => o.option_type === 'call');
    const puts = options.filter((o: any) => o.option_type === 'put');

    const strikes = [...new Set(options.map((o: any) => o.strike))].sort(
      (a: any, b: any) => (a as number) - (b as number)
    );

    res.json({ symbol, expiration, strikes, calls, puts, source: 'tradier' });
  } catch (err: any) {
    console.error('[chain] tradier error:', err.message);
    res.json(buildMockChain(symbol, expiration));
  }
});

// GET /api/chain/expirations?symbol=SPY
router.get('/expirations', async (req: Request, res: Response) => {
  const symbol = ((req.query.symbol as string) || 'SPY').toUpperCase();

  if (!TRADIER_TOKEN) {
    return res.json({ symbol, expirations: generateExpirations() });
  }

  try {
    const { data } = await axios.get(`${TRADIER_BASE}/markets/options/expirations`, {
      headers: { Authorization: `Bearer ${TRADIER_TOKEN}`, Accept: 'application/json' },
      params: { symbol, includeAllRoots: 'true' },
      timeout: 5000,
    });

    const dates = data?.expirations?.date ?? [];
    res.json({ symbol, expirations: Array.isArray(dates) ? dates : [dates] });
  } catch (err: any) {
    console.error('[chain] expirations error:', err.message);
    res.json({ symbol, expirations: generateExpirations() });
  }
});

function generateExpirations(): string[] {
  const dates: string[] = [];
  const now = new Date();
  for (let i = 0; i < 8; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() + i * 7);
    // Round to nearest Friday
    const day = d.getDay();
    const diff = (5 - day + 7) % 7;
    d.setDate(d.getDate() + diff);
    dates.push(d.toISOString().split('T')[0]);
  }
  return [...new Set(dates)];
}

function buildMockChain(symbol: string, expiration: string) {
  const basePrice: Record<string, number> = {
    SPY: 580, QQQ: 480, NVDA: 140, AAPL: 220, TSLA: 250, MSFT: 410, SPX: 5800,
  };
  const spot = basePrice[symbol] ?? 100;
  const strikes = Array.from({ length: 20 }, (_, i) => Math.round(spot * (0.92 + i * 0.008)));

  const calls = strikes.map((k) => ({
    symbol: `${symbol}${expiration}C${k}`,
    description: `${symbol} ${expiration} Call ${k}`,
    strike: k,
    option_type: 'call',
    expiration_date: expiration || new Date().toISOString().split('T')[0],
    bid: Math.max(0, parseFloat(((spot - k + 5 + Math.random() * 3) * 0.8).toFixed(2))),
    ask: Math.max(0, parseFloat(((spot - k + 5 + Math.random() * 3) * 0.82).toFixed(2))),
    volume: Math.floor(Math.random() * 5000 + 100),
    open_interest: Math.floor(Math.random() * 20000 + 500),
    greeks: {
      delta: parseFloat((0.5 - (k - spot) / (spot * 0.1)).toFixed(4)),
      gamma: parseFloat((0.03 + Math.random() * 0.02).toFixed(4)),
      theta: parseFloat((-0.1 - Math.random() * 0.05).toFixed(4)),
      vega: parseFloat((0.2 + Math.random() * 0.1).toFixed(4)),
      iv: parseFloat((0.25 + Math.random() * 0.15).toFixed(4)),
    },
  }));

  const puts = strikes.map((k) => ({
    symbol: `${symbol}${expiration}P${k}`,
    description: `${symbol} ${expiration} Put ${k}`,
    strike: k,
    option_type: 'put',
    expiration_date: expiration || new Date().toISOString().split('T')[0],
    bid: Math.max(0, parseFloat(((k - spot + 5 + Math.random() * 3) * 0.8).toFixed(2))),
    ask: Math.max(0, parseFloat(((k - spot + 5 + Math.random() * 3) * 0.82).toFixed(2))),
    volume: Math.floor(Math.random() * 5000 + 100),
    open_interest: Math.floor(Math.random() * 20000 + 500),
    greeks: {
      delta: parseFloat((-0.5 + (k - spot) / (spot * 0.1)).toFixed(4)),
      gamma: parseFloat((0.03 + Math.random() * 0.02).toFixed(4)),
      theta: parseFloat((-0.1 - Math.random() * 0.05).toFixed(4)),
      vega: parseFloat((0.2 + Math.random() * 0.1).toFixed(4)),
      iv: parseFloat((0.25 + Math.random() * 0.15).toFixed(4)),
    },
  }));

  return { symbol, expiration, strikes, calls, puts, source: 'mock' };
}

export default router;
