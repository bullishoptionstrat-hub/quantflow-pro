/**
 * Financial Modeling Prep (FMP) — Earnings, news, DCF, insider trades
 * Free: 250 req/day
 * Docs: https://site.financialmodelingprep.com/developer/docs
 */
import axios from 'axios';

const API_KEY = process.env.FMP_API_KEY || '';
const BASE = 'https://financialmodelingprep.com/api/v3';
const WATCHED = ['SPY', 'QQQ', 'NVDA', 'AAPL', 'TSLA', 'MSFT', 'AMD', 'META', 'AMZN', 'MSTR'];

export interface EarningsEvent {
  symbol: string;
  date: string;
  eps: number | null;
  epsEstimated: number | null;
  revenue: number | null;
  revenueEstimated: number | null;
  source: 'fmp';
}

export interface InsiderTrade {
  symbol: string;
  reportingName: string;
  transactionType: string;
  securitiesTransacted: number;
  price: number;
  date: string;
  source: 'fmp';
}

export interface NewsItem {
  symbol: string;
  title: string;
  url: string;
  publishedDate: string;
  sentiment: 'bullish' | 'bearish' | 'neutral';
  source: 'fmp';
}

let earnings: EarningsEvent[] = [];
let insiderTrades: InsiderTrade[] = [];
let newsItems: NewsItem[] = [];
let reqCount = 0;
const DAILY_LIMIT = 240;

export function getEarnings(): EarningsEvent[] { return earnings; }
export function getInsiderTrades(): InsiderTrade[] { return insiderTrades; }
export function getFMPNews(): NewsItem[] { return newsItems; }

function usesCredit(): boolean {
  if (reqCount >= DAILY_LIMIT) return false;
  reqCount++;
  return true;
}

async function fetchEarningsCalendar(): Promise<void> {
  if (!usesCredit()) return;
  try {
    const today = new Date().toISOString().split('T')[0];
    const future = new Date(Date.now() + 14 * 86400000).toISOString().split('T')[0];
    const { data } = await axios.get(`${BASE}/earning_calendar`, {
      params: { from: today, to: future, apikey: API_KEY },
      timeout: 8000,
    });
    earnings = (data ?? [])
      .filter((e: any) => WATCHED.includes(e.symbol))
      .map((e: any) => ({
        symbol: e.symbol, date: e.date,
        eps: e.eps, epsEstimated: e.epsEstimated,
        revenue: e.revenue, revenueEstimated: e.revenueEstimated,
        source: 'fmp' as const,
      }));
    console.log(`[fmp] Earnings calendar: ${earnings.length} events`);
  } catch (err: any) { console.error('[fmp] earnings error:', err.message); }
}

async function fetchInsiderTrades(): Promise<void> {
  if (!usesCredit()) return;
  try {
    const { data } = await axios.get(`${BASE}/insider-trading`, {
      params: { page: 0, apikey: API_KEY },
      timeout: 8000,
    });
    insiderTrades = (data ?? [])
      .filter((t: any) => WATCHED.includes(t.symbol))
      .slice(0, 50)
      .map((t: any) => ({
        symbol: t.symbol,
        reportingName: t.reportingName,
        transactionType: t.transactionType,
        securitiesTransacted: t.securitiesTransacted,
        price: t.price,
        date: t.transactionDate,
        source: 'fmp' as const,
      }));
    console.log(`[fmp] Insider trades: ${insiderTrades.length}`);
  } catch (err: any) { console.error('[fmp] insider error:', err.message); }
}

async function fetchNews(): Promise<void> {
  if (!usesCredit()) return;
  try {
    const { data } = await axios.get(`${BASE}/stock_news`, {
      params: { tickers: WATCHED.join(','), limit: 50, apikey: API_KEY },
      timeout: 8000,
    });
    newsItems = (data ?? []).map((n: any) => {
      const text = (n.title + ' ' + n.text).toLowerCase();
      const bullish = ['surge', 'rally', 'beat', 'record', 'buy', 'upgrade', 'bullish'].some(w => text.includes(w));
      const bearish = ['drop', 'fall', 'miss', 'decline', 'sell', 'downgrade', 'bearish'].some(w => text.includes(w));
      return {
        symbol: n.symbol, title: n.title, url: n.url,
        publishedDate: n.publishedDate,
        sentiment: bullish ? 'bullish' : bearish ? 'bearish' : 'neutral',
        source: 'fmp' as const,
      };
    });
    console.log(`[fmp] News: ${newsItems.length} items`);
  } catch (err: any) { console.error('[fmp] news error:', err.message); }
}

export async function startFMP(): Promise<void> {
  if (!API_KEY) { console.log('[fmp] No key — skipped'); return; }

  // Reset daily counter at midnight
  const now = new Date();
  const msUntilMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime() - now.getTime();
  setTimeout(() => { reqCount = 0; }, msUntilMidnight);

  await fetchEarningsCalendar();
  await fetchInsiderTrades();
  await fetchNews();

  setInterval(fetchEarningsCalendar, 6 * 60 * 60_000); // every 6h
  setInterval(fetchInsiderTrades, 60 * 60_000);          // every 1h
  setInterval(fetchNews, 15 * 60_000);                    // every 15min
  console.log('[fmp] Started — earnings, insider trades, news');
}
