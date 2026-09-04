/**
 * Event Registry (newsapi.ai) — financial headlines.
 *
 * A second news source, and a different vendor from `newsApi.ts` despite the
 * similar name: newsapi.org and newsapi.ai are unrelated services with
 * different keys, endpoints and response shapes. A newsapi.ai key sent to
 * newsapi.org comes back `apiKeyInvalid`, which is how this connector came to
 * exist.
 *
 * **It carries the vendor's own sentiment.** Event Registry returns a float in
 * `[-1, 1]` per article. `newsApi.ts` and `fmp.ts` have no such field, so they
 * classify with this service's own keyword list — and the wire has said so
 * since the news route was normalized. Those are different provenances for the
 * same field name, so `NewsWireItem.sentimentBasis` records which produced it:
 * `'vendor'` here, `'keyword'` there. The thresholds that turn their float
 * into our three-way label are ours, and stated below.
 *
 * Rights: `EVENT_REGISTRY_NEWS` is UNVERIFIED for display under
 * `PRIVATE_RESEARCH` and PROHIBITED under `PUBLIC_COMMERCIAL` — §6 forbids
 * redistributing content "including publishing or embedding", which is what
 * showing these headlines to a third party is. The connector gate refuses it
 * before `start()` runs in that mode.
 */
import axios from 'axios';
import { describeHttpError } from '../httpError';
import { num } from '../optionalNumber';

const API_KEY = process.env.EVENT_REGISTRY_API_KEY || '';
const ENDPOINT = 'https://eventregistry.org/api/v1/article/getArticles';

const WATCHED = ['SPY', 'QQQ', 'NVDA', 'AAPL', 'TSLA', 'MSFT', 'AMD', 'META', 'AMZN', 'MSTR', 'GOOG', 'VIX'];

/**
 * One batched query per cycle, hourly.
 *
 * The free tier is metered in tokens per month and the service exposes no
 * usage endpoint to read the remaining balance from, so the budget here is
 * deliberately conservative rather than tuned: one call an hour is ~720 a
 * month. A query *per symbol* would be twelve times that. If the plan is
 * larger this is leaving headroom unused, which is the safe direction to be
 * wrong in — a quota exhausted mid-month is a source that goes dark without
 * saying why.
 */
const POLL_MS = 60 * 60_000;
const ARTICLES_PER_CALL = 50;

/** Turning their float into our label. Our thresholds, stated. */
const BULLISH_ABOVE = 0.15;
const BEARISH_BELOW = -0.15;

export interface EventRegistryHeadline {
  id: string;
  title: string;
  description: string;
  url: string;
  /** The outlet, from `source.title`. */
  source: string;
  publishedAt: string;
  symbols: string[];
  sentiment: 'bullish' | 'bearish' | 'neutral';
  /** The vendor's raw score, kept so the label can be checked against it. */
  sentimentScore: number | null;
  provider: 'eventregistry';
}

/** Health of the last fetch cycle, reported to /api/health each cycle. */
export interface EventRegistryHealth {
  ok: boolean;
  /** Operator-facing, and public: this reaches the unauthenticated /api/health. */
  reason?: string;
}

let headlines: EventRegistryHeadline[] = [];
let onUpdate: ((h: EventRegistryHeadline) => void) | null = null;
let onHealth: ((h: EventRegistryHealth) => void) | null = null;

export function onEventRegistryHeadline(handler: (h: EventRegistryHeadline) => void): void {
  onUpdate = handler;
}
export function onEventRegistryHealth(handler: (h: EventRegistryHealth) => void): void {
  onHealth = handler;
}
export function getEventRegistryHeadlines(): EventRegistryHeadline[] { return headlines; }

/** A number the vendor actually sent, or null. Never a zero standing in. */
function labelFor(score: number | null): 'bullish' | 'bearish' | 'neutral' {
  // A missing score is `neutral` because it is unclassified, not because the
  // article is balanced. `sentimentScore: null` beside it says which.
  if (score === null) return 'neutral';
  if (score > BULLISH_ABOVE) return 'bullish';
  if (score < BEARISH_BELOW) return 'bearish';
  return 'neutral';
}

function findSymbols(text: string): string[] {
  const upper = text.toUpperCase();
  return WATCHED.filter((sym) => new RegExp(`\\b${sym}\\b`).test(upper));
}

async function fetchHeadlines(): Promise<void> {
  try {
    const { data } = await axios.post(
      ENDPOINT,
      {
        action: 'getArticles',
        // One request covering every watched name, rather than one per symbol.
        keyword: WATCHED,
        keywordOper: 'or',
        lang: 'eng',
        dataType: ['news'],
        resultType: 'articles',
        articlesSortBy: 'date',
        articlesCount: ARTICLES_PER_CALL,
        // Body is only used to tag symbols; a full one is bandwidth we discard.
        articlesArticleBodyLen: 400,
        includeArticleSentiment: true,
        includeArticleConcepts: false,
        includeArticleImage: false,
        apiKey: API_KEY,
      },
      // Generous, because the endpoint's latency is wildly variable — measured
      // at 3.2s and then a 60s hang for a smaller result set, minutes apart.
      // Nothing waits on this: it is an hourly background poll feeding a
      // panel, so a slow answer is worth more than a timeout that reports the
      // source as broken when it is only slow.
      { timeout: 45_000 },
    );

    // The API answers 200 with `{ error }` for a rejected key or a malformed
    // query, so a status check alone would read a refusal as success.
    if (typeof data?.error === 'string') {
      onHealth?.({ ok: false, reason: `Event Registry refused the query: ${data.error}` });
      return;
    }

    const results = data?.articles?.results;
    if (!Array.isArray(results)) {
      onHealth?.({ ok: false, reason: 'Event Registry returned no articles array.' });
      return;
    }

    const next: EventRegistryHeadline[] = [];
    for (const a of results) {
      // `isDuplicate` marks a reprint of a story already in the set. Keeping
      // both would double-count a name in any symbol tally built from these.
      if (a?.isDuplicate === true) continue;
      const url = typeof a?.url === 'string' ? a.url : '';
      const title = typeof a?.title === 'string' ? a.title : '';
      if (!url || !title) continue;

      const score = num(a?.sentiment);
      const item: EventRegistryHeadline = {
        id: typeof a?.uri === 'string' ? `er:${a.uri}` : `er:${url}`,
        title,
        description: typeof a?.body === 'string' ? a.body.slice(0, 300) : '',
        url,
        // `source.title` is the outlet's name; `source.uri` is its domain.
        source: typeof a?.source?.title === 'string' ? a.source.title : 'Unknown',
        // `dateTimePub` is when the outlet published it; `dateTime` is when
        // Event Registry saw it. The first is the one a reader means.
        publishedAt: typeof a?.dateTimePub === 'string'
          ? a.dateTimePub
          : (typeof a?.dateTime === 'string' ? a.dateTime : new Date().toISOString()),
        symbols: findSymbols(`${title} ${a?.body ?? ''}`),
        sentiment: labelFor(score),
        sentimentScore: score,
        provider: 'eventregistry',
      };
      next.push(item);
      onUpdate?.(item);
    }

    headlines = next;
    onHealth?.(next.length > 0
      ? { ok: true }
      : { ok: false, reason: 'Event Registry returned no usable articles.' });
    console.log(`[eventregistry] ${next.length} headlines`);
  } catch (err) {
    const reason = describeHttpError(err);
    console.warn('[eventregistry] fetch failed:', reason);
    onHealth?.({ ok: false, reason });
  }
}

export async function startEventRegistry(): Promise<void> {
  // No key is a configuration answer, not a failure. `startConnector` reads
  // `CONNECTOR_CREDENTIALS` and reports `disabled` naming the variable.
  if (!API_KEY) return;

  await fetchHeadlines();
  // `.unref()` so a poller never holds the event loop open.
  setInterval(fetchHeadlines, POLL_MS).unref();
  console.log('[eventregistry] Started — financial headlines hourly');
}
