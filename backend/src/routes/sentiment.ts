import { Router, Request, Response } from 'express';
import { getRedditSentiment, getSymbolSentiment } from '../ingestion/connectors/reddit';
import { getNewsHeadlines } from '../ingestion/connectors/newsApi';
import { getFMPNews, getEarnings, getInsiderTrades } from '../ingestion/connectors/fmp';

const router = Router();

function getSymbols(item: ReturnType<typeof getNewsHeadlines>[number] | ReturnType<typeof getFMPNews>[number]): string[] {
  return 'symbols' in item ? item.symbols : [item.symbol];
}

function getPublishedAt(item: ReturnType<typeof getNewsHeadlines>[number] | ReturnType<typeof getFMPNews>[number]): string {
  return 'publishedAt' in item ? item.publishedAt : item.publishedDate;
}

// GET /api/sentiment — aggregate sentiment scores per symbol
router.get('/', (_req: Request, res: Response) => {
  const reddit = getRedditSentiment();
  const news = getNewsHeadlines().slice(0, 50);
  const fmpNews = getFMPNews().slice(0, 50);

  // Merge news sentiment
  const symbolScores: Record<string, { reddit: number; news: number; combined: number; mentions: number }> = {};

  reddit.forEach(r => {
    if (!symbolScores[r.symbol]) symbolScores[r.symbol] = { reddit: 0, news: 0, combined: 0, mentions: 0 };
    symbolScores[r.symbol].reddit = r.sentimentScore;
    symbolScores[r.symbol].mentions = r.mentions;
  });

  [...news, ...fmpNews].forEach(n => {
    getSymbols(n).forEach(sym => {
      if (!symbolScores[sym]) symbolScores[sym] = { reddit: 0, news: 0, combined: 0, mentions: 0 };
      const score = n.sentiment === 'bullish' ? 10 : n.sentiment === 'bearish' ? -10 : 0;
      symbolScores[sym].news += score;
    });
  });

  Object.keys(symbolScores).forEach(sym => {
    const s = symbolScores[sym];
    s.combined = Math.round((s.reddit * 0.6 + Math.min(Math.max(s.news, -100), 100) * 0.4));
  });

  res.json({
    scores: symbolScores,
    reddit,
    newsCount: news.length + fmpNews.length,
    updatedAt: new Date().toISOString(),
  });
});

// GET /api/sentiment/:symbol
router.get('/:symbol', (req: Request, res: Response) => {
  const symbol = req.params.symbol.toUpperCase();
  const reddit = getSymbolSentiment(symbol);
  const symbolNews = getNewsHeadlines().filter(n => getSymbols(n).includes(symbol)).slice(0, 20);
  const fmpSymbolNews = getFMPNews().filter(n => n.symbol === symbol).slice(0, 10);

  res.json({
    symbol,
    reddit,
    news: [...symbolNews, ...fmpSymbolNews].slice(0, 25),
    updatedAt: new Date().toISOString(),
  });
});

// GET /api/sentiment/news/headlines — all news
router.get('/news/headlines', (_req: Request, res: Response) => {
  const all = [
    ...getNewsHeadlines().slice(0, 100),
    ...getFMPNews().slice(0, 50),
  ].sort((a, b) => new Date(getPublishedAt(b)).getTime() - new Date(getPublishedAt(a)).getTime());

  res.json({ headlines: all.slice(0, 100), total: all.length });
});

// GET /api/sentiment/earnings — upcoming earnings
router.get('/earnings/calendar', (_req: Request, res: Response) => {
  res.json({ earnings: getEarnings() });
});

// GET /api/sentiment/insiders — insider trades
router.get('/insiders/trades', (_req: Request, res: Response) => {
  res.json({ trades: getInsiderTrades().slice(0, 50) });
});

export default router;
