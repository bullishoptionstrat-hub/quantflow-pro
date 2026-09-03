import { Router, Request, Response } from 'express';
import { getRedditSentiment, getSymbolSentiment } from '../ingestion/connectors/reddit';
import { getNewsHeadlines } from '../ingestion/connectors/newsApi';
import { getEventRegistryHeadlines } from '../ingestion/connectors/eventRegistry';
import { getFMPNews, getEarnings, getInsiderTrades } from '../ingestion/connectors/fmp';
import { requireAuth } from '../middleware/auth';
import {
  fetchNewsContext,
  fetchRegulatoryNotice,
  getEnrichmentStatus,
  EnrichmentUnavailable,
  CONTEXT_ONLY_DISCLAIMER,
} from '../enrichment/index';

const router = Router();

type AnyNewsItem =
  | ReturnType<typeof getNewsHeadlines>[number]
  | ReturnType<typeof getFMPNews>[number]
  | ReturnType<typeof getEventRegistryHeadlines>[number];

function getItemSymbols(item: AnyNewsItem): string[] {
  if ('symbols' in item) {
    return item.symbols;
  }

  return item.symbol ? [item.symbol] : [];
}

function getPublishedTimestamp(item: AnyNewsItem): string {
  return 'publishedAt' in item ? item.publishedAt : item.publishedDate;
}

/**
 * One shape for a news item, whichever connector carried it.
 *
 * The two news connectors publish genuinely different records — NewsAPI's has
 * `id`, `symbols`, `publishedAt` and a publisher name in `source`; FMP's has
 * `symbol` (singular), `publishedDate`, no id, and the literal `'fmp'` in
 * `source`. Both were being concatenated into one array under one key, so the
 * response carried a union that no single client type could describe, and the
 * two `source` fields meant different things under the same name.
 *
 * A client reading `symbols.length` on an FMP item throws; reading
 * `publishedAt` gets `undefined` and dates it to `NaN`. Neither failure needs
 * a client bug to happen — the response is what is malformed — so the union is
 * resolved here, at the boundary, and the route publishes one contract.
 *
 * `sentiment` is our own keyword read of the headline in both cases, not a
 * stance the outlet took. `provider` says which connector's keyword list
 * produced it, so a client can attribute it correctly.
 */
export interface NewsWireItem {
  id: string;
  title: string;
  url: string;
  /** The outlet that ran it. FMP's feed does not name one, so: null. */
  publisher: string | null;
  /** Which of our connectors carried it. */
  provider: 'newsapi' | 'fmp' | 'eventregistry';
  publishedAt: string;
  symbols: string[];
  /** The classification. See `sentimentBasis` for whose it is. */
  sentiment: 'bullish' | 'bearish' | 'neutral';
  /**
   * Who produced `sentiment`.
   *
   * `keyword` — this service ran its own term list over the headline, because
   * the vendor supplies no score. That is newsapi.org and FMP.
   * `vendor` — the vendor scored the article itself and we thresholded it.
   * That is Event Registry, whose `sentiment` float is in `[-1, 1]`; the
   * cutoffs are ours and are stated in the connector.
   *
   * Two provenances behind one field name is exactly what `source` meant
   * before it was split into `publisher` and `provider`. Naming the basis
   * stops the same conflation happening to the value.
   */
  sentimentBasis: 'keyword' | 'vendor';
}

export function toNewsWireItem(item: AnyNewsItem): NewsWireItem {
  // Three shapes now. `symbols` separates the single-symbol FMP record from
  // the two multi-symbol ones, and `provider` separates those two from each
  // other — it is on the record in both cases.
  const fromNewsApi = 'symbols' in item;
  const fromEventRegistry = 'provider' in item && item.provider === 'eventregistry';
  return {
    // FMP sends no id. The URL is what identifies the article to the reader
    // and is stable across polls, which is all a list key needs; prefixing it
    // keeps it from colliding with a NewsAPI id that happens to look like one.
    id: fromNewsApi ? item.id : `fmp:${item.url}`,
    title: item.title,
    url: item.url,
    // NewsAPI's own record already substitutes `'Unknown'` when an article
    // names no outlet. Carrying that through would print "Unknown" as a byline
    // in the same colour as a real one; `null` sends the UI to the connector's
    // name, which is at least a true statement about where the story came from.
    publisher: fromNewsApi && item.source !== 'Unknown' ? item.source : null,
    provider: fromEventRegistry ? 'eventregistry' : fromNewsApi ? 'newsapi' : 'fmp',
    publishedAt: getPublishedTimestamp(item),
    symbols: getItemSymbols(item),
    sentiment: item.sentiment,
    sentimentBasis: fromEventRegistry ? 'vendor' : 'keyword',
  };
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
    getItemSymbols(n).forEach((sym) => {
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

// ─── Web enrichment (Firecrawl) ─────────────────────────────────────────────
//
// Registered above `/:symbol` on purpose: that route matches any single path
// segment, so anything declared after it would be captured as a ticker.
//
// These are the only endpoints in this service that spend metered credits, and
// they spend them only when called — there is no poller behind them. Both carry
// the context-only contract on the response body, because the client rendering
// them has not read the module's README.

/** Cap per request. Firecrawl bills per search; an unbounded limit bills badly. */
const MAX_CONTEXT_ITEMS = 10;

/**
 * Regulatory pages this service is willing to fetch, by slug.
 *
 * Deliberately an allowlist rather than a `?url=` parameter. A caller-supplied
 * URL would turn an authenticated endpoint into a request forwarder — any host
 * the server can reach, billed to this account — which is a server-side request
 * forgery surface and a credit-drain surface at the same time. Adding a source
 * is a code change, reviewed like one.
 */
const REGULATORY_SOURCES: Record<string, { url: string; label: string }> = {
  'finra-trf': {
    url: 'https://www.finra.org/filing-reporting/trade-reporting-facility-trf',
    label: 'FINRA Trade Reporting Facility (TRF)',
  },
  'finra-ats': {
    url: 'https://www.finra.org/filing-reporting/otc-transparency',
    label: 'FINRA OTC (ATS) Transparency',
  },
  'finra-notices': {
    url: 'https://www.finra.org/rules-guidance/notices',
    label: 'FINRA Rules & Guidance Notices',
  },
};

/** Translate an enrichment failure into a response a panel can render. */
function sendEnrichmentError(res: Response, err: unknown): void {
  if (err instanceof EnrichmentUnavailable) {
    res.status(err.httpStatus).json({
      error: 'enrichment_unavailable',
      reason: err.reason,
      code: err.code,
    });
    return;
  }
  res.status(500).json({
    error: 'enrichment_failed',
    reason: err instanceof Error ? err.message : String(err),
  });
}

// GET /api/sentiment/context/status — is enrichment configured, and if not, why
router.get('/context/status', requireAuth, (_req: Request, res: Response) => {
  res.json({
    ...getEnrichmentStatus(),
    context_only: true,
    disclaimer: CONTEXT_ONLY_DISCLAIMER,
    regulatorySources: Object.entries(REGULATORY_SOURCES).map(([slug, s]) => ({
      slug, label: s.label, url: s.url,
    })),
  });
});

// GET /api/sentiment/context?q=<query>&limit=<n> — news context for a theme
router.get('/context', requireAuth, async (req: Request, res: Response) => {
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  if (!q) {
    res.status(400).json({ error: 'q is required', example: '/api/sentiment/context?q=SPY' });
    return;
  }
  if (q.length > 200) {
    res.status(400).json({ error: 'q is too long (max 200 characters)' });
    return;
  }

  const requested = Number(req.query.limit);
  const limit = Number.isFinite(requested)
    ? Math.min(Math.max(Math.trunc(requested), 1), MAX_CONTEXT_ITEMS)
    : 5;

  try {
    res.json(await fetchNewsContext(q, limit));
  } catch (err) {
    sendEnrichmentError(res, err);
  }
});

// GET /api/sentiment/regulatory/:slug — an allowlisted regulatory page as markdown
router.get('/regulatory/:slug', requireAuth, async (req: Request, res: Response) => {
  const entry = REGULATORY_SOURCES[req.params.slug];
  if (!entry) {
    res.status(404).json({
      error: 'unknown regulatory source',
      available: Object.keys(REGULATORY_SOURCES),
    });
    return;
  }

  // Lets a caller holding a prior hash skip a re-fetch it does not need.
  const previousHash = typeof req.query.hash === 'string' ? req.query.hash : undefined;

  try {
    const result = await fetchRegulatoryNotice(entry.url, previousHash);
    res.json({ slug: req.params.slug, label: entry.label, ...result });
  } catch (err) {
    sendEnrichmentError(res, err);
  }
});

// GET /api/sentiment/:symbol
router.get('/:symbol', (req: Request, res: Response) => {
  const symbol = req.params.symbol.toUpperCase();
  const reddit = getSymbolSentiment(symbol);
  const symbolNews = [...getNewsHeadlines(), ...getEventRegistryHeadlines()]
    .filter(n => getItemSymbols(n).includes(symbol)).slice(0, 20);
  const fmpSymbolNews = getFMPNews().filter(n => n.symbol === symbol).slice(0, 10);

  res.json({
    symbol,
    reddit,
    news: [...symbolNews, ...fmpSymbolNews].slice(0, 25).map(toNewsWireItem),
    updatedAt: new Date().toISOString(),
  });
});

// GET /api/sentiment/news/headlines — all news
router.get('/news/headlines', (_req: Request, res: Response) => {
  const all = [
    ...getNewsHeadlines().slice(0, 100),
    ...getEventRegistryHeadlines().slice(0, 100),
    ...getFMPNews().slice(0, 50),
  ].sort((a, b) => new Date(getPublishedTimestamp(b)).getTime() - new Date(getPublishedTimestamp(a)).getTime());

  res.json({ headlines: all.slice(0, 100).map(toNewsWireItem), total: all.length });
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
