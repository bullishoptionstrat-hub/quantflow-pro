/**
 * CoinGecko — Crypto prices, market cap, DeFi, onchain data
 * Free Demo plan: 10K calls/month, 100 calls/min — no credit card
 * Docs: https://docs.coingecko.com
 */
import axios from 'axios';
import { describeHttpError } from '../httpError';
import { num } from '../optionalNumber';

const API_KEY = process.env.COINGECKO_API_KEY || '';
const BASE = API_KEY
  ? 'https://pro-api.coingecko.com/api/v3'
  : 'https://api.coingecko.com/api/v3';

const CRYPTO_IDS = ['bitcoin', 'ethereum', 'solana', 'dogecoin', 'shiba-inu', 'microstrategy'];
const CRYPTO_SYMBOLS: Record<string, string> = {
  bitcoin: 'BTC', ethereum: 'ETH', solana: 'SOL',
  dogecoin: 'DOGE', 'shiba-inu': 'SHIB', microstrategy: 'MSTR',
};

/**
 * A quote from CoinGecko's `/coins/markets`.
 *
 * Every optional field was `?? 0`, so a coin the vendor had no market data for
 * came back priced at **$0.00** with a 0.00% change, and the macro page
 * rendered it through the same markup as a live one. That is the Stooq failure
 * at field granularity: there, a browser-challenge page became twelve quotes
 * priced at zero; here, one absent field is enough.
 *
 * `price` is non-null because a record without one is not a quote and is not
 * cached at all. The rest are nullable, and the page renders `—` for a null.
 */
export interface CryptoQuote {
  id: string;
  symbol: string;
  name: string;
  price: number;
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

/** Health of the last fetch cycle, reported to /api/health. */
export interface CoinGeckoHealth {
  ok: boolean;
  /** Operator-facing, and public: this reaches the unauthenticated /api/health. */
  reason?: string;
}

/** A number the vendor actually sent, or null. Never a zero standing in. */
export interface GlobalCryptoData {
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

let onHealth: ((h: CoinGeckoHealth) => void) | null = null;

export function onCoinGeckoUpdate(handler: (q: CryptoQuote) => void): void {
  onCryptoUpdate = handler;
}
export function onCoinGeckoHealth(handler: (h: CoinGeckoHealth) => void): void {
  onHealth = handler;
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

    let priced = 0;
    let unpriced = 0;

    for (const coin of (data ?? [])) {
      const price = num(coin.current_price);
      if (price === null) {
        // Not a quote. Caching it as `price: 0` put a $0.00 row in the crypto
        // table in the same styling as a live one.
        unpriced++;
        continue;
      }
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
      priced++;
      cryptoCache.set(coin.symbol?.toUpperCase(), quote);
      onCryptoUpdate?.(quote);
    }

    if (priced === 0) {
      onHealth?.({ ok: false, reason: `CoinGecko returned no priced coins${unpriced > 0 ? ` (${unpriced} without a price)` : ''}.` });
    } else {
      onHealth?.({ ok: true });
    }
  } catch (err: any) {
    // Reported, not just logged. `startConnector` records what `start()`
    // returned once and never looks again, so a connector that starts clean
    // and is rate-limited an hour later kept saying `connected` while serving
    // an ageing cache — the finding that gave Stooq `onStooqHealth`.
    const reason = err.response?.status === 429
      ? 'CoinGecko rate limited this deployment (HTTP 429).'
      : describeHttpError(err);
    console.warn('[coingecko] prices error:', reason);
    onHealth?.({ ok: false, reason });
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
  setInterval(fetchPrices, 2 * 60_000).unref();
  setInterval(fetchGlobal, 5 * 60_000).unref();
  console.log(`[coingecko] Started — ${API_KEY ? 'Demo API key' : 'public endpoint'} polling every 2min`);
}
