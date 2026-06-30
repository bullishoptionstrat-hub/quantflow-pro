/**
 * Stooq — Free global quotes via CSV (no API key needed)
 * Good for: International indices, commodities, futures
 * Endpoint: https://stooq.com/q/d/l/?s={symbol}&i=d
 */
import axios from 'axios';

const ENABLED = process.env.STOOQ_ENABLED !== 'false';

// Stooq symbol format: lowercase with ^ prefix for indices
const SYMBOLS: Record<string, string> = {
  '^spx': 'SPX',
  '^ndx': 'NDX',
  '^dji': 'DJIA',
  '^vix': 'VIX',
  '^tnx': 'TNX', // 10Y yield
  '^fvx': 'FVX', // 5Y yield
  '^tyx': 'TYX', // 30Y yield
  'gc.f': 'GOLD',
  'si.f': 'SILVER',
  'cl.f': 'OIL',
  'ng.f': 'NATGAS',
  'dx.f': 'DXY',
};

export interface StooqQuote {
  stooqSymbol: string;
  symbol: string;
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  source: 'stooq';
}

const stooqCache = new Map<string, StooqQuote>();
let onStooqUpdate: ((q: StooqQuote) => void) | null = null;

export function onStooqQuote(handler: (q: StooqQuote) => void): void { onStooqUpdate = handler; }
export function getStooqQuotes(): Map<string, StooqQuote> { return stooqCache; }

async function fetchQuote(stooqSym: string): Promise<void> {
  try {
    const { data } = await axios.get(
      `https://stooq.com/q/d/l/?s=${encodeURIComponent(stooqSym)}&i=d`,
      {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        timeout: 6000,
        responseType: 'text',
      }
    );

    const lines = (data as string).trim().split('\n');
    if (lines.length < 2) return;

    const headers = lines[0].split(',').map((h: string) => h.trim().toLowerCase());
    const latest = lines[lines.length - 1].split(',');

    const get = (field: string) => {
      const idx = headers.indexOf(field);
      return idx >= 0 ? latest[idx]?.trim() : '';
    };

    const quote: StooqQuote = {
      stooqSymbol: stooqSym,
      symbol: SYMBOLS[stooqSym] ?? stooqSym.toUpperCase(),
      date: get('date'),
      open: parseFloat(get('open') || '0'),
      high: parseFloat(get('high') || '0'),
      low: parseFloat(get('low') || '0'),
      close: parseFloat(get('close') || '0'),
      volume: parseInt(get('volume') || '0'),
      source: 'stooq',
    };

    stooqCache.set(quote.symbol, quote);
    onStooqUpdate?.(quote);
  } catch {}
}

export async function startStooq(): Promise<void> {
  if (!ENABLED) { console.log('[stooq] Disabled'); return; }

  async function fetchAll(): Promise<void> {
    for (const sym of Object.keys(SYMBOLS)) {
      await fetchQuote(sym);
      await new Promise(r => setTimeout(r, 800)); // 800ms between requests
    }
  }

  await fetchAll();
  setInterval(fetchAll, 10 * 60_000); // every 10 min
  console.log('[stooq] Started — global indices, commodities, futures (no key required)');
}
