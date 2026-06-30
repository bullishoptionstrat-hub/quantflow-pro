/**
 * CoinGecko — Crypto prices, market cap, DeFi, onchain data
 * Free Demo plan: 10K calls/month, 100 calls/min — no credit card
 * Docs: https://docs.coingecko.com
 */
import axios from 'axios';

const API_KEY = process.env.COINGECKO_API_KEY || '';
const BASE = API_KEY
  ? 'https://pro-api.coingecko.com/api/v3'
  : 'https://api.coingecko.com/api/v3';

const CRYPTO_IDS = ['bitcoin', 'ethereum', 'solana', 'dogecoin', 'shiba-inu', 'microstrategy'];
const CRYPTO_SYMBOLS: Record<string, string> = {
  bitcoin: 'BTC', ethereum: 'ETH', solana: 'SOL',
  dogecoin: 'DOGE', 'shiba-inu': 'SHIB', microstrategy: 'MSTR',
};

export interface CryptoQuote {
  id: string;
  symbol: string;
  name: string;
  price: number;
  change24h: number;
  changePct24h: number;
  marketCap: number;
  volume24h: number;
  high24h: number;
  low24h: number;
  ath: number;
  athChangePct: number;
  lastUpdated: string;
  source: 'coingecko';
}

export interface GlobalCryptoData {
  totalMarketCap: number;
  totalVolume: number;
  btcDominance: number;
  ethDominance: number;
  activeCurrencies: number;
  marketCapChangePct24h: number;
  source: 'coingecko';
}

const cryptoCache = new Map<string, CryptoQuote>();
let globalData: GlobalCryptoData | null = null;
let onCryptoUpdate: ((q: CryptoQuote) => void) | null = null;

export function onCoinGeckoUpdate(handler: (q: CryptoQuote) => void): void {
  onCryptoUpdate = handler;
}
export function getCryptoQuotes(): Map<string, CryptoQuote> { return cryptoCache; }
export function getCryptoGlobal(): GlobalCryptoData | null { return globalData; }

function headers() {
  return API_KEY ? { 'x-cg-demo-api-key': API_KEY } : {};
}

async function fetchPrices(): Promise<void> {
  try {
    const { data } = await axios.get(`${BASE}/coins/markets`, {
      headers: headers(),
      params: {
        vs_currency: 'usd',
        ids: CRYPTO_IDS.join(','),
        order: 'market_cap_desc',
        per_page: 20,
        page: 1,
        sparkline: false,
        price_change_percentage: '24h',
      },
      timeout: 8000,
    });

    for (const coin of (data ?? [])) {
      const quote: CryptoQuote = {
        id: coin.id,
        symbol: CRYPTO_SYMBOLS[coin.id] ?? coin.symbol?.toUpperCase(),
        name: coin.name,
        price: coin.current_price ?? 0,
        change24h: coin.price_change_24h ?? 0,
        changePct24h: coin.price_change_percentage_24h ?? 0,
        marketCap: coin.market_cap ?? 0,
        volume24h: coin.total_volume ?? 0,
        high24h: coin.high_24h ?? 0,
        low24h: coin.low_24h ?? 0,
        ath: coin.ath ?? 0,
        athChangePct: coin.ath_change_percentage ?? 0,
        lastUpdated: coin.last_updated ?? new Date().toISOString(),
        source: 'coingecko',
      };
      cryptoCache.set(coin.symbol?.toUpperCase(), quote);
      onCryptoUpdate?.(quote);
    }
  } catch (err: any) {
    if (err.response?.status === 429) console.warn('[coingecko] Rate limited — slowing down');
    else console.error('[coingecko] prices error:', err.message);
  }
}

async function fetchGlobal(): Promise<void> {
  try {
    const { data } = await axios.get(`${BASE}/global`, {
      headers: headers(),
      timeout: 8000,
    });
    const d = data?.data;
    if (!d) return;
    globalData = {
      totalMarketCap: d.total_market_cap?.usd ?? 0,
      totalVolume: d.total_volume?.usd ?? 0,
      btcDominance: d.market_cap_percentage?.btc ?? 0,
      ethDominance: d.market_cap_percentage?.eth ?? 0,
      activeCurrencies: d.active_cryptocurrencies ?? 0,
      marketCapChangePct24h: d.market_cap_change_percentage_24h_usd ?? 0,
      source: 'coingecko',
    };
  } catch (err: any) {
    console.error('[coingecko] global error:', err.message);
  }
}

export async function startCoinGecko(): Promise<void> {
  await fetchPrices();
  await fetchGlobal();

  // Free tier: 100 calls/min — poll every 2 min to stay well under
  setInterval(fetchPrices, 2 * 60_000);
  setInterval(fetchGlobal, 5 * 60_000);
  console.log(`[coingecko] Started — ${API_KEY ? 'Demo API key' : 'public endpoint'} polling every 2min`);
}
