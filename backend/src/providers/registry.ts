/**
 * Provider declarations.
 *
 * HONESTY RULE FOR THIS FILE: every rate limit is either
 *   - `verified`   — confirmed against current sources, with the date, or
 *   - `unverified` — with the reason it could not be confirmed.
 *
 * No number here was invented. An `unverified` limit is enforced
 * pessimistically by the quota manager (see quota.ts), because guessing high
 * would get the account banned and guessing silently would be dishonest.
 *
 * Cross-reference: DATA_SOURCE_REGISTRY.md holds the human-readable version.
 */

import type { ProviderCapabilities } from './types';

const UNVERIFIED_NO_NETWORK = {
  state: 'unverified' as const,
  reason: 'Vendor docs unreachable from this environment (egress proxy blocks the domain); not confirmed.',
};

export const PROVIDERS: readonly ProviderCapabilities[] = [
  {
    id: 'tradier',
    displayName: 'Tradier',
    capabilities: ['option_trades', 'option_chain', 'option_quotes'],
    priority: 0,
    // Tradier streams realtime market events for accounts entitled to them.
    latency: 'realtime',
    rateLimit: { requests: null, windowSeconds: 60, verification: UNVERIFIED_NO_NETWORK },
    authKind: 'bearer',
    requiredEnv: ['TRADIER_TOKEN'],
    tosNotes: 'Realtime entitlement requires a funded brokerage account; sandbox is delayed.',
    docsUrl: 'https://documentation.tradier.com/',
    fallbackProviderId: 'polygon',
  },
  {
    id: 'polygon',
    displayName: 'Polygon.io',
    capabilities: ['option_trades'],
    priority: 0,
    // VERIFIED: the free tier serves end-of-day / 15-min-delayed data, NOT
    // realtime option trades. Declaring this honestly is the whole point.
    latency: 'delayed',
    estimatedDelaySeconds: 900,
    rateLimit: {
      requests: 5,
      windowSeconds: 60,
      verification: {
        state: 'verified',
        source: 'Polygon free tier: 5 API calls/min, EOD & 15-min-delayed data',
        verifiedOn: '2026-08-15',
      },
    },
    authKind: 'api_key',
    requiredEnv: ['POLYGON_API_KEY'],
    tosNotes: 'Free tier is for development/testing; realtime options require a paid plan (BLOCKED at $0).',
    docsUrl: 'https://polygon.io/docs',
  },
  {
    id: 'finnhub',
    displayName: 'Finnhub',
    capabilities: ['equity_trades', 'equity_quotes'],
    priority: 1,
    latency: 'realtime',
    rateLimit: { requests: null, windowSeconds: 60, verification: UNVERIFIED_NO_NETWORK },
    authKind: 'api_key',
    requiredEnv: ['FINNHUB_API_KEY'],
    // Recorded because the existing connector abused this: it fabricated OPTION
    // trades from EQUITY ticks (audit #4). Equity trades are all it can supply.
    tosNotes: 'Supplies EQUITY trades only. Option flow must never be derived from these ticks.',
    docsUrl: 'https://finnhub.io/docs/api',
  },
  {
    id: 'yahoo',
    displayName: 'Yahoo Finance (unofficial)',
    capabilities: ['equity_quotes', 'option_chain'],
    priority: 2,
    latency: 'delayed',
    estimatedDelaySeconds: 900,
    rateLimit: { requests: null, windowSeconds: 60, verification: UNVERIFIED_NO_NETWORK },
    authKind: 'none',
    requiredEnv: [],
    tosNotes:
      'Unofficial endpoint. v7 requires crumb+cookie since 2023 (verified 2026-08) — the current ' +
      'connector sends neither and is likely non-functional. Chain volume is DAILY CUMULATIVE, ' +
      'not per-trade. Scraping/redistribution restricted.',
    docsUrl: 'https://finance.yahoo.com',
  },
  {
    id: 'cboe',
    displayName: 'CBOE (delayed public data)',
    capabilities: ['volatility_index', 'index_quotes'],
    priority: 3,
    latency: 'delayed',
    estimatedDelaySeconds: 900,
    rateLimit: { requests: null, windowSeconds: 60, verification: UNVERIFIED_NO_NETWORK },
    authKind: 'none',
    requiredEnv: [],
    tosNotes: 'Public delayed quotes CDN. Term structure must be COMPUTED, never hardcoded.',
    docsUrl: 'https://www.cboe.com/us/options/market_statistics/',
  },
  {
    id: 'flashalpha',
    displayName: 'FlashAlpha GEX',
    capabilities: ['gex'],
    priority: 2,
    latency: 'delayed',
    estimatedDelaySeconds: 900,
    rateLimit: {
      requests: null,
      windowSeconds: 86_400,
      perDay: 5,
      verification: {
        state: 'unverified',
        reason: '5/day taken from the connector source comment; vendor docs unreachable to confirm.',
      },
    },
    authKind: 'api_key',
    requiredEnv: ['FLASHALPHA_API_KEY'],
    tosNotes: 'Dealer-positioning outputs are vendor MODELS, not observations — never present as fact.',
    docsUrl: 'https://flashalpha.com/api-documentation',
  },
  {
    id: 'marketdata',
    displayName: 'MarketData.app',
    capabilities: ['option_chain', 'option_quotes'],
    priority: 1,
    latency: 'delayed',
    estimatedDelaySeconds: 900,
    rateLimit: { requests: null, windowSeconds: 86_400, verification: UNVERIFIED_NO_NETWORK },
    authKind: 'bearer',
    requiredEnv: ['MARKETDATA_TOKEN'],
    docsUrl: 'https://docs.marketdata.app/',
  },
  {
    id: 'schwab',
    displayName: 'Schwab Developer',
    capabilities: ['option_chain', 'option_quotes', 'equity_quotes'],
    priority: 1,
    latency: 'delayed',
    estimatedDelaySeconds: 900,
    rateLimit: { requests: null, windowSeconds: 60, verification: UNVERIFIED_NO_NETWORK },
    authKind: 'oauth',
    requiredEnv: ['SCHWAB_APP_KEY', 'SCHWAB_APP_SECRET', 'SCHWAB_REFRESH_TOKEN'],
    tosNotes: 'Requires a Schwab brokerage account.',
    docsUrl: 'https://developer.schwab.com',
  },
  {
    id: 'tastytrade',
    displayName: 'Tastytrade',
    capabilities: ['option_chain', 'option_quotes'],
    priority: 1,
    latency: 'delayed',
    estimatedDelaySeconds: 900,
    rateLimit: { requests: null, windowSeconds: 60, verification: UNVERIFIED_NO_NETWORK },
    authKind: 'basic',
    requiredEnv: ['TASTYTRADE_USER', 'TASTYTRADE_PASS'],
    tosNotes: 'Requires an account. Session expires ~24h.',
    docsUrl: 'https://developer.tastytrade.com',
  },
  {
    id: 'twelvedata',
    displayName: 'Twelve Data',
    capabilities: ['equity_quotes', 'index_quotes'],
    priority: 3,
    latency: 'delayed',
    estimatedDelaySeconds: 60,
    rateLimit: { requests: null, windowSeconds: 60, verification: UNVERIFIED_NO_NETWORK },
    authKind: 'api_key',
    requiredEnv: ['TWELVE_DATA_API_KEY'],
    docsUrl: 'https://twelvedata.com/docs',
  },
  {
    id: 'fmp',
    displayName: 'Financial Modeling Prep',
    capabilities: ['earnings', 'insider_trades', 'news'],
    priority: 4,
    latency: 'delayed',
    estimatedDelaySeconds: 3_600,
    rateLimit: { requests: null, windowSeconds: 86_400, verification: UNVERIFIED_NO_NETWORK },
    authKind: 'api_key',
    requiredEnv: ['FMP_API_KEY'],
    docsUrl: 'https://financialmodelingprep.com/developer/docs',
  },
  {
    id: 'coingecko',
    displayName: 'CoinGecko',
    capabilities: ['crypto_quotes'],
    priority: 4,
    latency: 'delayed',
    estimatedDelaySeconds: 60,
    rateLimit: { requests: null, windowSeconds: 60, verification: UNVERIFIED_NO_NETWORK },
    authKind: 'api_key',
    requiredEnv: [],
    docsUrl: 'https://www.coingecko.com/en/api/documentation',
  },
  {
    id: 'fred',
    displayName: 'FRED (St. Louis Fed)',
    capabilities: ['macro_series'],
    priority: 3,
    latency: 'periodic',
    estimatedDelaySeconds: 86_400,
    rateLimit: { requests: null, windowSeconds: 60, verification: UNVERIFIED_NO_NETWORK },
    authKind: 'api_key',
    requiredEnv: ['FRED_API_KEY'],
    tosNotes: 'Official US government data. Genuinely free and stable.',
    docsUrl: 'https://fred.stlouisfed.org/docs/api/fred/',
  },
  {
    id: 'reddit',
    displayName: 'Reddit',
    capabilities: ['sentiment'],
    priority: 5,
    latency: 'periodic',
    estimatedDelaySeconds: 3_600,
    rateLimit: { requests: null, windowSeconds: 60, verification: UNVERIFIED_NO_NETWORK },
    authKind: 'oauth',
    requiredEnv: ['REDDIT_CLIENT_ID', 'REDDIT_CLIENT_SECRET'],
    tosNotes: 'User content — no redistribution. Sentiment is an INFERENCE, never an observation.',
    docsUrl: 'https://www.reddit.com/dev/api',
  },
  {
    id: 'newsapi',
    displayName: 'NewsAPI',
    capabilities: ['news'],
    priority: 4,
    latency: 'delayed',
    estimatedDelaySeconds: 3_600,
    rateLimit: { requests: null, windowSeconds: 86_400, verification: UNVERIFIED_NO_NETWORK },
    authKind: 'api_key',
    requiredEnv: ['NEWS_API_KEY'],
    tosNotes:
      'Free tier has historically been development-only with no production use permitted. ' +
      'MUST be confirmed against current terms before any deploy.',
    docsUrl: 'https://newsapi.org/docs',
  },
  {
    id: 'stooq',
    displayName: 'Stooq',
    capabilities: ['index_quotes', 'macro_series'],
    priority: 3,
    latency: 'end_of_day',
    estimatedDelaySeconds: 86_400,
    rateLimit: { requests: null, windowSeconds: 60, verification: UNVERIFIED_NO_NETWORK },
    authKind: 'none',
    requiredEnv: [],
    docsUrl: 'https://stooq.com',
  },
  {
    id: 'finra',
    displayName: 'FINRA ATS (not integrated)',
    capabilities: ['equity_trades'],
    priority: 5,
    latency: 'periodic',
    estimatedDelaySeconds: 604_800, // weekly
    rateLimit: { requests: null, windowSeconds: 86_400, verification: UNVERIFIED_NO_NETWORK },
    authKind: 'none',
    requiredEnv: [],
    blockedOnFreeTier: true,
    blockedReason:
      'Not integrated. FINRA ATS data is WEEKLY AGGREGATED VOLUME, never intraday prints — ' +
      'a future integration must not be labeled "dark pool prints". True intraday prints ' +
      'require a licensed TRF/SIP feed (paid).',
    tosNotes: 'Weekly aggregates only.',
    docsUrl: 'https://www.finra.org/finra-data/browse-catalog/otc-transparency',
  },
];

const BY_ID = new Map(PROVIDERS.map((p) => [p.id, p]));

export function getProvider(id: string): ProviderCapabilities | undefined {
  return BY_ID.get(id);
}

export function providersWithCapability(cap: string): ProviderCapabilities[] {
  return PROVIDERS.filter((p) => (p.capabilities as readonly string[]).includes(cap))
    .filter((p) => !p.blockedOnFreeTier)
    .sort((a, b) => a.priority - b.priority);
}

/** Providers whose required env is fully present. */
export function configuredProviders(env: NodeJS.ProcessEnv = process.env): ProviderCapabilities[] {
  return PROVIDERS.filter(
    (p) => !p.blockedOnFreeTier && p.requiredEnv.every((k) => (env[k] ?? '').trim().length > 0),
  );
}

export function missingEnvFor(
  p: ProviderCapabilities,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  return p.requiredEnv.filter((k) => (env[k] ?? '').trim().length === 0);
}
