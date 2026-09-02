/**
 * CoinGecko — Crypto prices, market cap, DeFi, onchain data
 * Free Demo plan: 10K calls/month, 100 calls/min — no credit card
 * Docs: https://docs.coingecko.com
 */
import axios from 'axios';
import { num } from '../parseNumeric';

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
  /**
   * Non-null by construction: a quote with no price is not a quote, so
   * `fetchPrices` skips the row rather than publishing `price: 0`. BTC at
   * $0.00 rendered in the same markup as a real quote was the failure mode.
   */
  price: number;
  /**
   * `null` when CoinGecko omitted the field — never 0, which is a real reading
   * ("unchanged on the day") and would be indistinguishable from absence.
   */
  change24h: number | null;
  changePct24h: number | null;
  marketCap: number | null;
  volume24h: number | null;
  high24h: number | null;
  low24h: number | null;
  ath: number | null;
  athChangePct: number | null;
  lastUpdated: string;
  source: 'coingecko';
}

export interface GlobalCryptoData {
  /**
   * `null` for any field CoinGecko's /global response omitted. Zero would be a
   * reading — a total market cap of $0 or a BTC dominance of 0% are both
   * statements about the market, not about the request.
   */
  totalMarketCap: number | null;
  totalVolume: number | null;
  btcDominance: number | null;
  ethDominance: number | null;
  activeCurrencies: number | null;
  marketCapChangePct24h: number | null;
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
      // A quote with no price is not a quote. This used to publish `price: 0`,
      // which the macro page rendered as "$0.00" beside real quotes in the same
      // markup — the reader had no way to tell a dead field from a real one.
      const price = num(coin.current_price);
      if (price === null || price <= 0) continue;

      const quote: CryptoQuote = {
        id: coin.id,
        symbol: CRYPTO_SYMBOLS[coin.id] ?? coin.symbol?.toUpperCase(),
        name: coin.name,
        price,
        change24h: num(coin.price_change_24h),
        changePct24h: num(coin.price_change_percentage_24h),
        marketCap: num(coin.market_cap),
        volume24h: num(coin.total_volume),
        high24h: num(coin.high_24h),
        low24h: num(coin.low_24h),
        ath: num(coin.ath),
        athChangePct: num(coin.ath_change_percentage),
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
      totalMarketCap: num(d.total_market_cap?.usd),
      totalVolume: num(d.total_volume?.usd),
      btcDominance: num(d.market_cap_percentage?.btc),
      ethDominance: num(d.market_cap_percentage?.eth),
      activeCurrencies: num(d.active_cryptocurrencies),
      marketCapChangePct24h: num(d.market_cap_change_percentage_24h_usd),
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
