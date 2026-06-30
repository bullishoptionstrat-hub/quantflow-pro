/**
 * Charles Schwab Trader API — Real-time options chains + quotes
 * Free with any Schwab brokerage account
 * Docs: https://developer.schwab.com
 * NOTE: Requires OAuth2 flow — tokens are auto-refreshed every 29 min
 */
import axios from 'axios';
import { FlowEvent } from '../index';
import { computeHeatScore } from '../heatScore';
import { classifySweep } from '../sweepDetector';

const APP_KEY = process.env.SCHWAB_APP_KEY || '';
const APP_SECRET = process.env.SCHWAB_APP_SECRET || '';
const REFRESH_TOKEN = process.env.SCHWAB_REFRESH_TOKEN || '';
const BASE = 'https://api.schwabapi.com/marketdata/v1';
const AUTH_BASE = 'https://api.schwabapi.com/v1/oauth/token';
const WATCHED = ['SPY', 'QQQ', 'NVDA', 'AAPL', 'TSLA', 'MSFT', 'AMD'];

let accessToken = '';
let tokenExpiry = 0;
let onFlowEvent: ((e: FlowEvent) => void) | null = null;

export function onSchwabFlow(handler: (e: FlowEvent) => void): void {
  onFlowEvent = handler;
}

async function refreshAccessToken(): Promise<boolean> {
  if (!REFRESH_TOKEN) return false;
  try {
    const creds = Buffer.from(`${APP_KEY}:${APP_SECRET}`).toString('base64');
    const { data } = await axios.post(AUTH_BASE,
      new URLSearchParams({ grant_type: 'refresh_token', refresh_token: REFRESH_TOKEN }),
      {
        headers: {
          Authorization: `Basic ${creds}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        timeout: 8000,
      }
    );
    accessToken = data.access_token;
    tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
    console.log('[schwab] Access token refreshed');
    return true;
  } catch (err: any) {
    console.error('[schwab] Token refresh failed:', err.message);
    return false;
  }
}

async function ensureToken(): Promise<boolean> {
  if (accessToken && Date.now() < tokenExpiry) return true;
  return refreshAccessToken();
}

async function fetchOptionsChain(symbol: string): Promise<void> {
  if (!(await ensureToken())) return;
  try {
    const { data } = await axios.get(`${BASE}/chains`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      params: {
        symbol,
        contractType: 'ALL',
        strikeCount: 10,
        includeUnderlyingQuote: true,
        strategy: 'SINGLE',
        range: 'NTM',
      },
      timeout: 8000,
    });

    const spot = data.underlyingPrice ?? 0;
    const processMap = (optionMap: Record<string, any[]>, cp: 'C' | 'P') => {
      Object.values(optionMap).forEach((strikes: any) => {
        Object.values(strikes).forEach((contracts: any) => {
          const c = Array.isArray(contracts) ? contracts[0] : contracts;
          if (!c || c.totalVolume < 100) return;

          const heat = computeHeatScore({
            bid: c.bid, ask: c.ask, price: c.last,
            size: c.totalVolume, avgVolume: c.totalVolume * 0.3,
            openInterest: c.openInterest,
          });

          onFlowEvent?.({
            id: `schwab-${c.symbol}-${Date.now()}`,
            timestamp: new Date().toISOString(),
            symbol,
            expiration: c.expirationDate?.split('T')[0] ?? '',
            strike: c.strikePrice,
            callPut: cp,
            type: classifySweep({ size: c.totalVolume, exchanges: ['C'] }),
            size: c.totalVolume,
            premium: c.last * c.totalVolume * 100,
            heatScore: heat,
            sentiment: cp === 'C' ? 'bullish' : 'bearish',
            source: 'schwab',
            bid: c.bid, ask: c.ask,
            iv: c.volatility ? c.volatility / 100 : undefined,
            delta: c.delta,
          } as FlowEvent);
        });
      });
    };

    if (data.callExpDateMap) processMap(data.callExpDateMap, 'C');
    if (data.putExpDateMap) processMap(data.putExpDateMap, 'P');
  } catch (err: any) {
    if (err.response?.status === 401) { accessToken = ''; }
    console.error('[schwab] chain error:', err.message);
  }
}

export async function startSchwab(): Promise<void> {
  if (!APP_KEY || !APP_SECRET || !REFRESH_TOKEN) {
    console.log('[schwab] Missing credentials — skipped');
    console.log('[schwab] Get free access at: https://developer.schwab.com');
    return;
  }

  const ok = await refreshAccessToken();
  if (!ok) return;

  // Refresh token every 28 min
  setInterval(refreshAccessToken, 28 * 60_000);

  async function poll(): Promise<void> {
    for (const sym of WATCHED) {
      await fetchOptionsChain(sym);
      await new Promise(r => setTimeout(r, 1500));
    }
  }

  await poll();
  setInterval(poll, 60_000); // every minute during market hours
  console.log('[schwab] Started — polling options chains every 60s');
}
