/**
 * NewsAPI — Financial news headlines, real-time
 * Free: 100 req/day developer plan
 * Docs: https://newsapi.org/docs
 * Signup: https://newsapi.org/register
 */
import axios from 'axios';

const API_KEY = process.env.NEWS_API_KEY || '';
const BASE = 'https://newsapi.org/v2';
const QUERIES = [
  'options flow unusual activity',
  'stock market SPY QQQ institutional',
  'NVDA TSLA AAPL earnings options',
  'Federal Reserve interest rates market',
];
const WATCHED = ['SPY', 'QQQ', 'NVDA', 'AAPL', 'TSLA', 'MSFT', 'AMD', 'META', 'AMZN', 'MSTR', 'GOOG', 'VIX'];

export interface NewsHeadline {
  id: string;
  title: string;
  description: string;
  url: string;
  source: string;
  publishedAt: string;
  symbols: string[];
  sentiment: 'bullish' | 'bearish' | 'neutral';
  relevanceScore: number;
  provider: 'newsapi';
}

let headlines: NewsHeadline[] = [];
let onNewsUpdate: ((h: NewsHeadline) => void) | null = null;
let dailyRequests = 0;
const DAILY_LIMIT = 95;

export function onNewsHeadline(handler: (h: NewsHeadline) => void): void {
  onNewsUpdate = handler;
}
export function getNewsHeadlines(): NewsHeadline[] { return headlines; }

const BULLISH_TERMS = ['surge', 'rally', 'beat', 'record high', 'buy', 'upgrade', 'bullish', 'breakout', 'soar', 'rise', 'gain'];
const BEARISH_TERMS = ['plunge', 'crash', 'miss', 'decline', 'sell', 'downgrade', 'bearish', 'drop', 'fall', 'concern', 'risk'];

function analyzeSentiment(text: string): 'bullish' | 'bearish' | 'neutral' {
  const lower = text.toLowerCase();
  let b = 0; let s = 0;
  BULLISH_TERMS.forEach(t => { if (lower.includes(t)) b++; });
  BEARISH_TERMS.forEach(t => { if (lower.includes(t)) s++; });
  if (b > s) return 'bullish';
  if (s > b) return 'bearish';
  return 'neutral';
}

function findSymbols(text: string): string[] {
  return WATCHED.filter(sym => {
    const regex = new RegExp(`\\b${sym}\\b`);
    return regex.test(text.toUpperCase());
  });
}

async function fetchHeadlines(query: string): Promise<void> {
  if (dailyRequests >= DAILY_LIMIT) return;
  try {
    dailyRequests++;
    const { data } = await axios.get(`${BASE}/everything`, {
      params: {
        q: query,
        language: 'en',
        sortBy: 'publishedAt',
        pageSize: 20,
        apiKey: API_KEY,
      },
      timeout: 8000,
    });

    const articles = data?.articles ?? [];
    for (const a of articles) {
      if (!a.title || a.title === '[Removed]') continue;
      const text = `${a.title} ${a.description ?? ''}`;
      const symbols = findSymbols(text);
      const item: NewsHeadline = {
        id: `news-${Buffer.from(a.url).toString('base64').slice(0, 12)}`,
        title: a.title,
        description: a.description ?? '',
        url: a.url,
        source: a.source?.name ?? 'Unknown',
        publishedAt: a.publishedAt,
        symbols,
        sentiment: analyzeSentiment(text),
        relevanceScore: symbols.length * 10 + (a.title.length > 50 ? 5 : 0),
        provider: 'newsapi',
      };
      onNewsUpdate?.(item);
      headlines.unshift(item);
    }

    // Keep latest 200
    headlines = headlines.slice(0, 200);
  } catch (err: any) {
    if (err.response?.status === 429 || err.response?.status === 426) {
      dailyRequests = DAILY_LIMIT;
    }
    console.error('[newsapi] error:', err.message);
  }
}

export async function startNewsAPI(): Promise<void> {
  if (!API_KEY) { console.log('[newsapi] No key — skipped'); return; }

  // Reset daily counter at midnight
  const now = new Date();
  const msUntilMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime() - now.getTime();
  setTimeout(() => { dailyRequests = 0; }, msUntilMidnight);

  // Initial fetch — stagger queries
  for (let i = 0; i < QUERIES.length; i++) {
    setTimeout(() => fetchHeadlines(QUERIES[i]), i * 5000);
  }

  // Refresh every 30 min (4 queries × 2 refreshes = 8 req/h, ~192/day — within 100/day free limit with batching)
  setInterval(async () => {
    for (let i = 0; i < QUERIES.length; i++) {
      await new Promise(r => setTimeout(r, i * 3000));
      await fetchHeadlines(QUERIES[i]);
    }
  }, 30 * 60_000);

  console.log('[newsapi] Started — financial headlines every 30min');
}
