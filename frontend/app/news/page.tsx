'use client'
import { useState, useEffect, useCallback } from 'react'
import { loadPanel, listAt, type Panel } from '@/lib/panel'
import type { NewsItem, RedditSentiment, EarningsEvent } from '@/lib/types'

/**
 * Three panels, three hardcoded arrays, and none of the three endpoints was
 * ever read correctly.
 *
 * The fetch tested `Array.isArray(response)` against `{ headlines: [...] }`
 * and `{ earnings: [...] }` — the same envelope mistake that emptied the macro
 * page — so `headlines` and `earningsData` were empty on every deployment,
 * keyed or not, and both panels fell through to `headlines.length > 0 ? live :
 * FALLBACK`. What the fallback contained is the part that matters: six
 * invented headlines attributed by name to **Reuters, Bloomberg, CNBC,
 * MarketWatch, the WSJ and Barron's** ("Fed holds rates steady, signals one cut
 * in 2024", "NVDA Q1 earnings crush estimates"), each with a sentiment badge
 * and a timestamp computed backwards from `Date.now()` so it always read as
 * minutes old; six invented Reddit posts in quotation marks with mention
 * counts to four figures; and five invented earnings dates with EPS estimates
 * to the cent. All of it rendered through the identical markup as live data,
 * under a header claiming "NewsAPI headlines · Reddit WSB sentiment · FMP
 * earnings calendar".
 *
 * That is the family this repo has been clearing out — the seeded flow feed,
 * the generated dark-pool prints, the coin-flipped support levels, the
 * hardcoded ticker tape — and this is its worst instance, because the others
 * fabricated numbers while this one fabricates quotations and attributes them
 * to real newsrooms.
 *
 * The Reddit panel is a third failure on its own: the fetch found the array
 * (`sentRes.value?.reddit` is the right key) and the interface described a
 * record the wire has never sent. `sentiment`, `bullishPct`, `bearishPct`,
 * `topPost` and `lastUpdated` are not fields; the wire has `sentimentScore` on
 * a **-100…+100** scale, keyword tallies, `topPosts[]` and `updatedAt`. Live
 * data would have rendered "undefined% bull", "NaN% neutral", a gauge at
 * `width: NaN%` and a NEUTRAL label — visibly broken, but only once someone
 * had a Reddit key, and the fallback array meant nobody ever did.
 *
 * See `lib/types.ts` for the scales, and `backend/test/newsWire.test.ts` for
 * the union the news route now resolves before sending.
 */

/** Matches the ticker tape's poll; these sources update far slower than this. */
const POLL_MS = 60_000

// ─── Helpers ──────────────────────────────────────────────────────────────────

function timeAgo(dateStr: string): string {
  const t = new Date(dateStr).getTime()
  // An unparseable stamp used to render "NaNd ago" in the same muted grey as a
  // real one. Say nothing instead.
  if (!Number.isFinite(t)) return ''
  const m = Math.floor((Date.now() - t) / 60_000)
  if (m < 0) return 'just now'
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

function sentimentColor(s: NewsItem['sentiment']): string {
  if (s === 'bullish') return '#22c55e'
  if (s === 'bearish') return '#ef4444'
  return 'var(--text-muted)'
}

/**
 * Colour and label for a Reddit score, **on the wire's -100…+100 scale**.
 *
 * These were written against -1…+1 and pointed at a field that did not exist,
 * so they were only ever exercised by the fallback array's own numbers. The
 * thresholds are the old ±0.2 / ±0.5 read on the scale the data actually uses.
 */
function scoreColor(score: number): string {
  if (score > 20) return '#22c55e'
  if (score < -20) return '#ef4444'
  return '#fbbf24'
}

function scoreLabel(score: number): string {
  if (score > 50) return '🟢 VERY BULLISH'
  if (score > 20) return '🟢 BULLISH'
  if (score < -50) return '🔴 VERY BEARISH'
  if (score < -20) return '🔴 BEARISH'
  return '🟡 NEUTRAL'
}

/** `YYYY-MM-DD` in New York, for comparing calendar dates against a calendar date. */
function etDate(at: Date): string {
  return at.toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
}

/**
 * Whole days from today to an earnings date.
 *
 * FMP sends a calendar date, not an instant, and `new Date('2026-09-05')`
 * parses as UTC midnight — which is the previous evening in New York, so a
 * naive subtraction reads a day early for most of the US trading session.
 * Both sides are reduced to ET calendar days first.
 */
function daysUntil(date: string): number | null {
  const day = date.slice(0, 10)
  const target = Date.parse(`${day}T00:00:00Z`)
  const today = Date.parse(`${etDate(new Date())}T00:00:00Z`)
  if (!Number.isFinite(target) || !Number.isFinite(today)) return null
  return Math.round((target - today) / 86_400_000)
}

// ─── Panel chrome ─────────────────────────────────────────────────────────────

/**
 * What a panel says when it has nothing to show.
 *
 * A refusal is **not** "signed out" here, which is where the ticker tape's
 * wording would have led. The tape is mounted on `/login`, so a 401 there
 * usually is a reader with no session; `middleware.ts` gates `/news` behind a
 * Supabase session or the demo cookie, so if this page is rendering at all,
 * the reader has one. A 401 from the backend then means the token expired
 * mid-session, or the backend has no Supabase client configured (the case
 * `server.ts` warns about at boot, where every request is refused and nothing
 * on screen says so), or the demo cookie is set and the backend's `DEMO_MODE`
 * is not — the two-independent-conditions gate. Two of those three are
 * deployment faults, and telling a signed-in reader to sign in sends them
 * after the wrong one. The notice names the refusal and stops there.
 *
 * No message names an environment variable. The per-source status and the
 * variable that turns each connector on live on the settings page, and a
 * second copy here would be a second copy to keep correct — the same reason
 * the ticker tape points at Settings rather than naming `TWELVE_DATA_API_KEY`.
 */
function PanelNotice({ status, source }: { status: Panel<unknown>['status']; source: string }) {
  const text =
    status === 'loading' ? '' :
    status === 'unauthorized' ? `${source.toUpperCase()} REFUSED — the backend did not accept this session` :
    status === 'unreachable' ? `${source.toUpperCase()} UNREACHABLE — the backend did not answer` :
    `NO ${source.toUpperCase()} REPORTING — see Settings for source status`

  if (!text) return null
  return (
    <div style={{
      padding: '24px 14px', textAlign: 'center', fontSize: 11,
      color: 'var(--text-muted)', fontFamily: "'JetBrains Mono', monospace",
    }}>
      {text}
    </div>
  )
}

// ─── Sentiment Gauge ─────────────────────────────────────────────────────────

/** `score` is -100…+100. See `RedditSentiment` in `lib/types.ts`. */
function SentimentGauge({ score }: { score: number }) {
  const pct = Math.min(100, Math.max(0, ((score + 100) / 200) * 100))
  return (
    <div style={{ height: 4, background: 'var(--bg-secondary)', borderRadius: 2, overflow: 'hidden' }}>
      <div style={{
        height: '100%', width: `${pct}%`,
        background: scoreColor(score),
        borderRadius: 2, transition: 'width 0.5s ease'
      }} />
    </div>
  )
}

// ─── News Feed ────────────────────────────────────────────────────────────────

function NewsFeed({ panel }: { panel: Panel<NewsItem[]> }) {
  const items = panel.status === 'ok' ? panel.data : []

  return (
    <div className="card" style={{ height: '100%' }}>
      <div className="card-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
        <span style={{ fontWeight: 700, fontSize: 13 }}>📰 NEWS FEED</span>
        {/* The old label read "NewsAPI · FMP · Finnhub". Finnhub does not feed
            this route; it is an options/quotes connector. */}
        <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>NewsAPI · FMP</span>
      </div>
      <div style={{ maxHeight: 480, overflowY: 'auto' }}>
        {items.length === 0 && <PanelNotice status={panel.status} source="news feed" />}
        {items.map(h => (
          <a
            key={h.id}
            href={h.url}
            target="_blank"
            rel="noopener noreferrer"
            style={{ display: 'block', padding: '10px 14px', borderBottom: '1px solid rgba(255,255,255,0.04)', textDecoration: 'none', transition: 'background 0.15s' }}
            onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.03)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8, marginBottom: 4 }}>
              <p style={{ fontSize: 12, fontWeight: 600, color: '#fafafa', lineHeight: 1.4, margin: 0, flex: 1 }}>{h.title}</p>
              <span style={{
                fontSize: 9, fontWeight: 700, borderRadius: 3, padding: '2px 5px',
                background: h.sentiment === 'bullish' ? 'rgba(34,197,94,0.15)' : h.sentiment === 'bearish' ? 'rgba(239,68,68,0.15)' : 'rgba(255,255,255,0.06)',
                color: sentimentColor(h.sentiment), flexShrink: 0, fontFamily: "'JetBrains Mono', monospace"
              }}>
                {h.sentiment.toUpperCase()}
                {/* Whose classification this is. The tag looks identical
                    whether a keyword list or the news vendor produced it, and
                    they are not the same claim. */}
                {h.sentimentBasis === 'vendor' && (
                  <span style={{ color: '#c4b5fd', marginLeft: 4 }}>· VENDOR</span>
                )}
              </span>
            </div>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              {/* FMP's feed does not name the outlet, so the connector is named
                  instead of printing its own id as a byline, which is what the
                  single `source` field used to do. */}
              <span style={{ fontSize: 10, color: '#a78bfa', fontWeight: 600 }}>
                {h.publisher ?? `via ${h.provider.toUpperCase()}`}
              </span>
              <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>{timeAgo(h.publishedAt)}</span>
              {h.symbols.length > 0 && (
                <div style={{ display: 'flex', gap: 4 }}>
                  {h.symbols.slice(0, 3).map(s => (
                    <span key={s} style={{ fontSize: 9, background: 'rgba(139,92,246,0.15)', color: '#c4b5fd', borderRadius: 3, padding: '1px 4px', fontFamily: "'JetBrains Mono', monospace", fontWeight: 700 }}>{s}</span>
                  ))}
                </div>
              )}
            </div>
          </a>
        ))}
      </div>
      {items.length > 0 && (
        <div style={{ padding: '6px 14px', fontSize: 9, color: 'var(--text-muted)', borderTop: '1px solid rgba(255,255,255,0.04)' }}>
          Sentiment tags are never the publisher&apos;s. A <span style={{ color: '#c4b5fd' }}>VENDOR</span> tag is
          the news vendor&apos;s own score for the article; the rest are this service&apos;s keyword read of the headline.
        </div>
      )}
    </div>
  )
}

// ─── Reddit / WSB Sentiment ──────────────────────────────────────────────────

function RedditPanel({ panel }: { panel: Panel<RedditSentiment[]> }) {
  const rows = panel.status === 'ok' ? panel.data : []

  return (
    <div className="card">
      <div className="card-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
        <span style={{ fontWeight: 700, fontSize: 13 }}>👾 WSB / REDDIT SENTIMENT</span>
        <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>r/wallstreetbets · r/options</span>
      </div>
      <div style={{ padding: '8px 0' }}>
        {rows.length === 0 && <PanelNotice status={panel.status} source="reddit sentiment" />}
        {rows.map(r => (
          <div key={r.symbol} style={{ padding: '10px 14px', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                <span style={{ fontSize: 14, fontWeight: 700, color: '#fbbf24', fontFamily: "'JetBrains Mono', monospace" }}>{r.symbol}</span>
                <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>{r.mentions.toLocaleString()} mentions</span>
              </div>
              <span style={{ fontSize: 11, fontWeight: 700, color: scoreColor(r.sentimentScore), fontFamily: "'JetBrains Mono', monospace" }}>
                {scoreLabel(r.sentimentScore)}
              </span>
            </div>
            <SentimentGauge score={r.sentimentScore} />
            {/* Shown as the tallies they are. The connector adds a whole post's
                term hits to both counters, so these are keyword hits summed
                over posts — they can exceed `mentions`, and the share-of-posts
                percentages the fallback array implied were never derivable
                from them. `sentimentScore` above is their normalized
                difference, which is the ratio that does mean something. */}
            <div style={{ display: 'flex', gap: 12, marginTop: 6, marginBottom: r.topPosts.length > 0 ? 6 : 0, alignItems: 'baseline' }}>
              <span style={{ fontSize: 10, color: '#86efac', fontFamily: "'JetBrains Mono', monospace" }}>🟢 {r.bullishMentions.toLocaleString()}</span>
              <span style={{ fontSize: 10, color: '#fca5a5', fontFamily: "'JetBrains Mono', monospace" }}>🔴 {r.bearishMentions.toLocaleString()}</span>
              <span style={{ fontSize: 9, color: 'var(--text-muted)' }}>bullish / bearish keyword hits</span>
            </div>
            {r.topPosts.slice(0, 2).map(p => (
              <a
                key={p.url}
                href={p.url}
                target="_blank"
                rel="noopener noreferrer"
                style={{ display: 'block', fontSize: 10, color: 'var(--text-muted)', textDecoration: 'none', padding: '4px 8px', marginTop: 4, background: 'rgba(255,255,255,0.03)', borderRadius: 3, borderLeft: '2px solid rgba(139,92,246,0.4)' }}
              >
                {p.title}
              </a>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── Earnings Calendar ────────────────────────────────────────────────────────

function EarningsPanel({ panel }: { panel: Panel<EarningsEvent[]> }) {
  const rows = panel.status === 'ok' ? panel.data : []

  return (
    <div className="card">
      <div className="card-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
        <span style={{ fontWeight: 700, fontSize: 13 }}>📅 EARNINGS CALENDAR</span>
        <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>FMP</span>
      </div>
      <div style={{ padding: '4px 0' }}>
        {rows.length === 0 && <PanelNotice status={panel.status} source="earnings calendar" />}
        {/* The company name and the BMO/AMC session badge are gone with the
            fallback array that supplied them: FMP's calendar carries neither,
            and the badge chose its colour from an `undefined`. */}
        {rows.map(e => {
          const days = daysUntil(e.date)
          return (
            <div key={`${e.symbol}-${e.date}`} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 14px', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
              <div>
                <span style={{ fontSize: 13, fontWeight: 700, color: '#fbbf24', fontFamily: "'JetBrains Mono', monospace", marginRight: 8 }}>{e.symbol}</span>
                <span style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: "'JetBrains Mono', monospace" }}>{e.date.slice(0, 10)}</span>
              </div>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                {e.epsEstimated != null && (
                  <span style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: "'JetBrains Mono', monospace" }}>EPS est ${e.epsEstimated.toFixed(2)}</span>
                )}
                {e.eps != null && (
                  <span style={{ fontSize: 10, color: '#fafafa', fontFamily: "'JetBrains Mono', monospace" }}>rep ${e.eps.toFixed(2)}</span>
                )}
                {days != null && (
                  <span style={{ fontSize: 11, fontWeight: 700, fontFamily: "'JetBrains Mono', monospace",
                    color: days < 0 ? 'var(--text-muted)' : days <= 2 ? '#f97316' : days <= 5 ? '#fbbf24' : 'var(--text-muted)' }}>
                    {days < 0 ? `${-days}d ago` : days === 0 ? 'TODAY' : days === 1 ? 'TOMORROW' : `in ${days}d`}
                  </span>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function NewsPage() {
  const [news, setNews] = useState<Panel<NewsItem[]>>({ status: 'loading' })
  const [reddit, setReddit] = useState<Panel<RedditSentiment[]>>({ status: 'loading' })
  const [earnings, setEarnings] = useState<Panel<EarningsEvent[]>>({ status: 'loading' })
  const [lastUpdate, setLastUpdate] = useState<string>('')

  const load = useCallback(async () => {
    // Three independent sources with three independent credentials: one can be
    // reporting while another is refused, so each keeps its own status rather
    // than sharing a page-level one. `Promise.allSettled` used to hide that —
    // and worse, a 401 body parses as JSON, so it arrived `fulfilled` and read
    // as an empty feed.
    const [n, r, e] = await Promise.all([
      loadPanel<NewsItem[]>('/api/sentiment/news/headlines', b => listAt(b, 'headlines')),
      loadPanel<RedditSentiment[]>('/api/sentiment', b => listAt(b, 'reddit')),
      loadPanel<EarningsEvent[]>('/api/sentiment/earnings/calendar', b => listAt(b, 'earnings')),
    ])
    setNews(n)
    setReddit(r)
    setEarnings(e)
    // Stamped only once something answered. A clock ticking over three dead
    // panels reads as freshness.
    if ([n, r, e].some(p => p.status === 'ok')) {
      setLastUpdate(new Date().toLocaleTimeString('en-US', { hour12: false, timeZone: 'America/New_York' }))
    }
  }, [])

  useEffect(() => {
    load()
    const id = setInterval(load, POLL_MS)
    return () => clearInterval(id)
  }, [load])

  /**
   * The aggregate pill, and only when there is something to aggregate.
   *
   * It used to default to `0.1` with no data — a green-adjacent "🟡 NEUTRAL"
   * market read, in a bordered pill, computed from nothing. That is the
   * fallback arrays' defect in a single expression.
   */
  const scored = reddit.status === 'ok' ? reddit.data : []
  const avgScore = scored.length > 0
    ? scored.reduce((s, r) => s + r.sentimentScore, 0) / scored.length
    : null

  return (
    <div>
      <div style={{ marginBottom: 20, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16 }}>
        <div>
          <h1 style={{ fontSize: 18, fontWeight: 700, color: '#fafafa', marginBottom: 4 }}>📰 News &amp; Sentiment</h1>
          <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            NewsAPI and FMP headlines · Reddit mention sentiment · FMP earnings dates — context, not a trade trigger
          </p>
        </div>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          {avgScore != null && (
            <div style={{ background: avgScore > 20 ? 'rgba(34,197,94,0.1)' : avgScore < -20 ? 'rgba(239,68,68,0.1)' : 'rgba(251,191,36,0.1)',
              border: `1px solid ${avgScore > 20 ? 'rgba(34,197,94,0.3)' : avgScore < -20 ? 'rgba(239,68,68,0.3)' : 'rgba(251,191,36,0.3)'}`,
              borderRadius: 8, padding: '6px 12px' }}>
              <div style={{ fontSize: 9, color: 'var(--text-muted)', marginBottom: 2 }}>
                REDDIT SENTIMENT · {scored.length} SYMBOL{scored.length === 1 ? '' : 'S'}
              </div>
              <div style={{ fontSize: 13, fontWeight: 700, fontFamily: "'JetBrains Mono', monospace", color: scoreColor(avgScore) }}>
                {scoreLabel(avgScore)}
              </div>
            </div>
          )}
          {lastUpdate && (
            <div style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: "'JetBrains Mono', monospace" }}>
              Updated {lastUpdate} ET
            </div>
          )}
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
        <NewsFeed panel={news} />
        <RedditPanel panel={reddit} />
      </div>

      <EarningsPanel panel={earnings} />

      <div style={{ marginTop: 12, fontSize: 10, color: 'var(--text-muted)', textAlign: 'right' }}>
        News: NewsAPI.org and Financial Modeling Prep · Sentiment: Reddit API · Earnings: Financial Modeling Prep
      </div>
    </div>
  )
}
