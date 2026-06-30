/**
 * Tastytrade API — Real-time quotes, option chains, market metrics
 * Free with any Tastytrade brokerage account
 * Docs: https://developer.tastytrade.com/api-overview
 */
import axios from 'axios';
import WebSocket from 'ws';
import { FlowEvent } from '../index';
import { computeHeatScore } from '../heatScore';
import { classifySweep } from '../sweepDetector';

const USER = process.env.TASTYTRADE_USER || '';
const PASS = process.env.TASTYTRADE_PASS || '';
const BASE = 'https://api.tastytrade.com';
const WS_BASE = 'wss://streamer.tastytrade.com';
const WATCHED = ['SPY', 'QQQ', '/ES', '/NQ', 'NVDA', 'AAPL', 'TSLA', 'MSFT', 'AMD', 'MSTR'];

let sessionToken = '';
let onFlowEvent: ((e: FlowEvent) => void) | null = null;

export function onTastytradeFlow(handler: (e: FlowEvent) => void): void {
  onFlowEvent = handler;
}

async function login(): Promise<boolean> {
  try {
    const { data } = await axios.post(`${BASE}/sessions`, {
      login: USER,
      password: PASS,
    }, { timeout: 10000 });

    sessionToken = data?.data?.['session-token'] ?? '';
    console.log('[tastytrade] Login successful');
    return !!sessionToken;
  } catch (err: any) {
    console.error('[tastytrade] Login failed:', err.message);
    return false;
  }
}

async function fetchOptionChain(symbol: string): Promise<void> {
  if (!sessionToken) return;
  try {
    const { data } = await axios.get(`${BASE}/option-chains/${encodeURIComponent(symbol)}/nested`, {
      headers: { Authorization: sessionToken },
      timeout: 8000,
    });

    const expirations = data?.data?.items ?? [];
    for (const exp of expirations.slice(0, 2)) {
      const strikes = exp.strikes ?? [];
      for (const strike of strikes.slice(0, 5)) {
        for (const cp of ['call', 'put'] as const) {
          const opt = strike[cp];
          if (!opt || !opt['root-symbol']) continue;

          const size = opt['day-volume'] ?? 0;
          if (size < 50) continue;

          const bid = parseFloat(opt['bid'] ?? 0);
          const ask = parseFloat(opt['ask'] ?? 0);
          const last = parseFloat(opt['last'] ?? ((bid + ask) / 2));
          const oi = opt['open-interest'] ?? 0;
          const strikePrice = parseFloat(strike['strike-price'] ?? 0);
          const expDate = exp['expiration-date'];

          const heat = computeHeatScore({ bid, ask, price: last, size, avgVolume: size * 0.4, openInterest: oi });

          onFlowEvent?.({
            id: `tasty-${symbol}-${strikePrice}-${cp}-${Date.now()}`,
            timestamp: new Date().toISOString(),
            symbol: symbol.startsWith('/') ? symbol.replace('/', '') : symbol,
            expiration: expDate,
            strike: strikePrice,
            callPut: cp === 'call' ? 'C' : 'P',
            type: classifySweep({ size, exchanges: ['C'] }),
            size,
            premium: last * size * 100,
            heatScore: heat,
            sentiment: cp === 'call' ? 'bullish' : 'bearish',
            source: 'tastytrade',
            bid, ask,
          } as FlowEvent);
        }
      }
    }
  } catch (err: any) {
    if (err.response?.status === 401) { sessionToken = ''; login(); }
  }
}

function startWebSocket(): void {
  if (!sessionToken) return;
  const ws = new WebSocket(`${WS_BASE}?token=${sessionToken}`);

  ws.on('open', () => {
    ws.send(JSON.stringify({
      action: 'connect',
      value: WATCHED.map(s => ({ type: 'quote', symbol: s })),
    }));
    console.log('[tastytrade] WebSocket connected');
  });

  ws.on('message', (raw: Buffer) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'quote' && msg.data?.length) {
        const d = msg.data[0];
        if (d.bidPrice && d.askPrice && Math.random() > 0.9) {
          const sym = d.symbol?.split(' ')[0] ?? d.symbol;
          fetchOptionChain(sym).catch(() => {});
        }
      }
    } catch {}
  });

  ws.on('error', () => {});
  ws.on('close', () => { setTimeout(startWebSocket, 10000); });
}

export async function startTastytrade(): Promise<void> {
  if (!USER || !PASS) {
    console.log('[tastytrade] No credentials — skipped');
    console.log('[tastytrade] Get free access at: https://developer.tastytrade.com');
    return;
  }

  const ok = await login();
  if (!ok) return;

  // Re-login every 23h (session expires in 24h)
  setInterval(login, 23 * 60 * 60_000);

  startWebSocket();

  async function poll(): Promise<void> {
    for (const sym of WATCHED) {
      await fetchOptionChain(sym);
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  await poll();
  setInterval(poll, 5 * 60_000);
  console.log('[tastytrade] Started — streaming + polling every 5min');
}
