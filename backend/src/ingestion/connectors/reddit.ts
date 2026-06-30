/**
 * Reddit WSB/Options Sentiment — r/wallstreetbets, r/options, r/stocks
 * Free for personal use via Reddit API (OAuth2 app)
 * Docs: https://www.reddit.com/dev/api/
 * Sign up: https://reddit.com/prefs/apps → create "script" app
 */
import axios from 'axios';

const CLIENT_ID = process.env.REDDIT_CLIENT_ID || '';
const CLIENT_SECRET = process.env.REDDIT_CLIENT_SECRET || '';
const USER_AGENT = process.env.REDDIT_USER_AGENT || 'QuantFlowPro/1.0';
const SUBREDDITS = ['wallstreetbets', 'options', 'stocks', 'investing', 'StockMarket'];
const WATCHED = ['SPY', 'QQQ', 'NVDA', 'AAPL', 'TSLA', 'MSFT', 'AMD', 'META', 'AMZN', 'MSTR', 'SPX', 'VIX'];

export interface RedditSentiment {
  symbol: string;
  mentions: number;
  bullishMentions: number;
  bearishMentions: number;
  sentimentScore: number; // -100 to +100
  topPosts: { title: string; score: number; url: string }[];
  updatedAt: string;
  source: 'reddit';
}

const sentimentCache = new Map<string, RedditSentiment>();
let accessToken = '';
let tokenExpiry = 0;
let onSentimentUpdate: ((s: RedditSentiment) => void) | null = null;

export function onRedditSentiment(handler: (s: RedditSentiment) => void): void {
  onSentimentUpdate = handler;
}
export function getRedditSentiment(): RedditSentiment[] {
  return Array.from(sentimentCache.values());
}
export function getSymbolSentiment(symbol: string): RedditSentiment | null {
  return sentimentCache.get(symbol) ?? null;
}

async function getToken(): Promise<boolean> {
  if (accessToken && Date.now() < tokenExpiry) return true;
  try {
    const { data } = await axios.post(
      'https://www.reddit.com/api/v1/access_token',
      'grant_type=client_credentials',
      {
        auth: { username: CLIENT_ID, password: CLIENT_SECRET },
        headers: { 'User-Agent': USER_AGENT, 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 8000,
      }
    );
    accessToken = data.access_token;
    tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
    return true;
  } catch (err: any) {
    console.error('[reddit] Auth failed:', err.message);
    return false;
  }
}

const BULLISH_WORDS = ['calls', 'bullish', 'moon', 'buy', 'long', 'yolo', 'pump', 'gains', 'breakout', 'squeeze', 'rip'];
const BEARISH_WORDS = ['puts', 'bearish', 'short', 'sell', 'crash', 'dump', 'bag', 'loss', 'drop', 'rekt', 'drill'];

function scoreSentiment(text: string): { bullish: number; bearish: number } {
  const lower = text.toLowerCase();
  let bullish = 0; let bearish = 0;
  BULLISH_WORDS.forEach(w => { if (lower.includes(w)) bullish++; });
  BEARISH_WORDS.forEach(w => { if (lower.includes(w)) bearish++; });
  return { bullish, bearish };
}

async function fetchSubredditPosts(subreddit: string): Promise<any[]> {
  if (!(await getToken())) return [];
  try {
    const { data } = await axios.get(
      `https://oauth.reddit.com/r/${subreddit}/new.json?limit=50`,
      {
        headers: { Authorization: `Bearer ${accessToken}`, 'User-Agent': USER_AGENT },
        timeout: 8000,
      }
    );
    return data?.data?.children?.map((c: any) => c.data) ?? [];
  } catch (err: any) {
    if (err.response?.status === 401) { accessToken = ''; }
    return [];
  }
}

async function analyzeSentiment(): Promise<void> {
  const allPosts: any[] = [];

  // Stagger requests 1s apart
  for (const sub of SUBREDDITS) {
    const posts = await fetchSubredditPosts(sub);
    allPosts.push(...posts);
    await new Promise(r => setTimeout(r, 1000));
  }

  // Count mentions per symbol
  const symbolData = new Map<string, {
    mentions: number; bullish: number; bearish: number;
    posts: { title: string; score: number; url: string }[];
  }>();

  WATCHED.forEach(sym => symbolData.set(sym, { mentions: 0, bullish: 0, bearish: 0, posts: [] }));

  for (const post of allPosts) {
    const text = `${post.title} ${post.selftext ?? ''}`.toUpperCase();
    const score = scoreSentiment(text);

    for (const sym of WATCHED) {
      const regex = new RegExp(`\\b${sym}\\b`);
      if (regex.test(text)) {
        const d = symbolData.get(sym)!;
        d.mentions++;
        d.bullish += score.bullish;
        d.bearish += score.bearish;
        if (d.posts.length < 3) {
          d.posts.push({
            title: post.title,
            score: post.score,
            url: `https://reddit.com${post.permalink}`,
          });
        }
      }
    }
  }

  for (const [sym, d] of symbolData.entries()) {
    if (d.mentions === 0) continue;
    const total = d.bullish + d.bearish || 1;
    const sentimentScore = Math.round(((d.bullish - d.bearish) / total) * 100);

    const sentiment: RedditSentiment = {
      symbol: sym,
      mentions: d.mentions,
      bullishMentions: d.bullish,
      bearishMentions: d.bearish,
      sentimentScore,
      topPosts: d.posts,
      updatedAt: new Date().toISOString(),
      source: 'reddit',
    };
    sentimentCache.set(sym, sentiment);
    onSentimentUpdate?.(sentiment);
  }

  console.log(`[reddit] Sentiment updated — ${sentimentCache.size} symbols tracked`);
}

export async function startReddit(): Promise<void> {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    console.log('[reddit] No credentials — skipped. Sign up: https://reddit.com/prefs/apps');
    return;
  }

  await analyzeSentiment();
  setInterval(analyzeSentiment, 15 * 60_000); // every 15 min
  console.log('[reddit] Started — WSB/options sentiment every 15min');
}
