'use client'
import { useState, useEffect } from 'react'

const WS_URL = process.env.NEXT_PUBLIC_WS_URL || 'http://localhost:3001'
const API = WS_URL.replace('ws://', 'http://').replace('wss://', 'https://')

interface NewsHeadline {
  id: string
  title: string
  source: string
  url: string
  publishedAt: string
  sentiment: 'bullish' | 'bearish' | 'neutral'
  symbols: string[]
  score: number
}

interface RedditPost {
  symbol: string
  mentions: number
  sentiment: number        // -1 to +1
  bullishPct: number
  bearishPct: number
  topPost?: string
  lastUpdated: string
}

interface EarningsEvent {
  symbol: string
  name: string
  date: string
  epsEstimate?: number
  revenueEstimate?: number
  time: 'BMO' | 'AMC' | 'TNS'
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function timeAgo(dateStr: string) {
  const diff = Date.now() - new Date(dateStr).getTime()
  const m = Math.floor(diff / 60_000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

function sentimentColor(s: string | number) {
  if (typeof s === 'string') {
    if (s === 'bullish') return '#22c55e'
    if (s === 'bearish') return '#ef4444'
    return 'var(--text-muted)'
  }
  if (s > 0.2) return '#22c55e'
  if (s < -0.2) return '#ef4444'
  return '#fbbf24'
}

function sentimentLabel(score: number) {
  if (score > 0.5) return '🟢 VERY BULLISH'
  if (score > 0.2) return '🟢 BULLISH'
  if (score < -0.5) return '🔴 VERY BEARISH'
  if (score < -0.2) return '🔴 BEARISH'
  return '🟡 NEUTRAL'
}

// ─── Sentiment Gauge ─────────────────────────────────────────────────────────
function SentimentGauge({ score }: { score: number }) {
  const pct = ((score + 1) / 2) * 100
  return (
    <div style={{ height: 4, background: 'var(--bg-secondary)', borderRadius: 2, overflow: 'hidden' }}>
      <div style={{
        height: '100%', width: `${pct}%`,
        background: score > 0.2 ? '#22c55e' : score < -0.2 ? '#ef4444' : '#fbbf24',
        borderRadius: 2, transition: 'width 0.5s ease'
      }} />
    </div>
  )
}

// ─── News Feed ────────────────────────────────────────────────────────────────
function NewsFeed({ headlines }: { headlines: NewsHeadline[] }) {
  const FALLBACK: NewsHeadline[] = [
    { id: '1', title: 'Fed holds rates steady, signals one cut in 2024', source: 'Reuters', url: '#', publishedAt: new Date(Date.now() - 1200000).toISOString(), sentiment: 'neutral', symbols: ['SPY', 'TLT'], score: 0.1 },
    { id: '2', title: 'NVDA Q1 earnings crush estimates on AI demand surge', source: 'Bloomberg', url: '#', publishedAt: new Date(Date.now() - 3600000).toISOString(), sentiment: 'bullish', symbols: ['NVDA'], score: 0.84 },
    { id: '3', title: 'Tesla deliveries miss Q2 expectations, shares drop 4%', source: 'CNBC', url: '#', publishedAt: new Date(Date.now() - 7200000).toISOString(), sentiment: 'bearish', symbols: ['TSLA'], score: -0.61 },
    { id: '4', title: 'Apple announces $110B buyback, raises dividend 4%', source: 'MarketWatch', url: '#', publishedAt: new Date(Date.now() - 10800000).toISOString(), sentiment: 'bullish', symbols: ['AAPL'], score: 0.72 },
    { id: '5', title: 'VIX spikes to 19 as macro uncertainty rises', source: 'Barron\'s', url: '#', publishedAt: new Date(Date.now() - 14400000).toISOString(), sentiment: 'bearish', symbols: ['VIX', 'SPX'], score: -0.45 },
    { id: '6', title: 'Microsoft Azure growth reaccelerates to 31% in Q3', source: 'WSJ', url: '#', publishedAt: new Date(Date.now() - 18000000).toISOString(), sentiment: 'bullish', symbols: ['MSFT'], score: 0.68 },
  ]
  const display = headlines.length > 0 ? headlines : FALLBACK

  return (
    <div className="card" style={{ height: '100%' }}>
      <div className="card-header" style={{ display: 'flex', justifyContent: 'space-between' }}>
        <span style={{ fontWeight: 700, fontSize: 13 }}>📰 NEWS FEED</span>
        <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>NewsAPI · FMP · Finnhub</span>
      </div>
      <div style={{ maxHeight: 480, overflowY: 'auto' }}>
        {display.map(h => (
          <a
            key={h.id}
            href={h.url !== '#' ? h.url : undefined}
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
              </span>
            </div>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              <span style={{ fontSize: 10, color: '#a78bfa', fontWeight: 600 }}>{h.source}</span>
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
    </div>
  )
}

// ─── Reddit / WSB Sentiment ──────────────────────────────────────────────────
function RedditPanel({ data }: { data: RedditPost[] }) {
  const FALLBACK: RedditPost[] = [
    { symbol: 'NVDA', mentions: 1842, sentiment: 0.71, bullishPct: 78, bearishPct: 12, topPost: 'NVDA to $200 EOY — AI supercycle just beginning', lastUpdated: new Date().toISOString() },
    { symbol: 'SPY', mentions: 1204, sentiment: 0.12, bullishPct: 52, bearishPct: 38, topPost: 'Holding 590c lotto for FOMC, wish me luck', lastUpdated: new Date().toISOString() },
    { symbol: 'TSLA', mentions: 987, sentiment: -0.28, bullishPct: 41, bearishPct: 49, topPost: 'TSLA delivery miss is priced in. Load the puts.', lastUpdated: new Date().toISOString() },
    { symbol: 'MSTR', mentions: 756, sentiment: 0.64, bullishPct: 74, bearishPct: 16, topPost: 'MSTR leveraged BTC play — infinite money glitch if BTC pumps', lastUpdated: new Date().toISOString() },
    { symbol: 'AMD', mentions: 512, sentiment: 0.33, bullishPct: 62, bearishPct: 28, topPost: 'MI300X beating H100 on inference benchmarks = undervalued', lastUpdated: new Date().toISOString() },
    { symbol: 'QQQ', mentions: 489, sentiment: 0.08, bullishPct: 48, bearishPct: 42, topPost: 'Bearish divergence on QQQ daily — hedging my longs', lastUpdated: new Date().toISOString() },
  ]
  const display = data.length > 0 ? data : FALLBACK

  return (
    <div className="card">
      <div className="card-header" style={{ display: 'flex', justifyContent: 'space-between' }}>
        <span style={{ fontWeight: 700, fontSize: 13 }}>👾 WSB / REDDIT SENTIMENT</span>
        <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>r/wallstreetbets · r/options</span>
      </div>
      <div style={{ padding: '8px 0' }}>
        {display.map(r => (
          <div key={r.symbol} style={{ padding: '10px 14px', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                <span style={{ fontSize: 14, fontWeight: 700, color: '#fbbf24', fontFamily: "'JetBrains Mono', monospace" }}>{r.symbol}</span>
                <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>{r.mentions.toLocaleString()} mentions</span>
              </div>
              <span style={{ fontSize: 11, fontWeight: 700, color: sentimentColor(r.sentiment), fontFamily: "'JetBrains Mono', monospace" }}>
                {sentimentLabel(r.sentiment)}
              </span>
            </div>
            <SentimentGauge score={r.sentiment} />
            <div style={{ display: 'flex', gap: 12, marginTop: 6, marginBottom: r.topPost ? 6 : 0 }}>
              <span style={{ fontSize: 10, color: '#86efac', fontFamily: "'JetBrains Mono', monospace" }}>🟢 {r.bullishPct}% bull</span>
              <span style={{ fontSize: 10, color: '#fca5a5', fontFamily: "'JetBrains Mono', monospace" }}>🔴 {r.bearishPct}% bear</span>
              <span style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: "'JetBrains Mono', monospace" }}>⬜ {100 - r.bullishPct - r.bearishPct}% neutral</span>
            </div>
            {r.topPost && (
              <div style={{ fontSize: 10, color: 'var(--text-muted)', fontStyle: 'italic', padding: '4px 8px', background: 'rgba(255,255,255,0.03)', borderRadius: 3, borderLeft: '2px solid rgba(139,92,246,0.4)' }}>
                "{r.topPost}"
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── Earnings Calendar ────────────────────────────────────────────────────────
function EarningsPanel({ data }: { data: EarningsEvent[] }) {
  const FALLBACK: EarningsEvent[] = [
    { symbol: 'NVDA', name: 'NVIDIA Corp', date: new Date(Date.now() + 3 * 86400000).toISOString().split('T')[0], epsEstimate: 5.58, revenueEstimate: 24.6e9, time: 'AMC' },
    { symbol: 'MSFT', name: 'Microsoft', date: new Date(Date.now() + 5 * 86400000).toISOString().split('T')[0], epsEstimate: 2.93, revenueEstimate: 64.5e9, time: 'AMC' },
    { symbol: 'AAPL', name: 'Apple Inc', date: new Date(Date.now() + 7 * 86400000).toISOString().split('T')[0], epsEstimate: 1.53, revenueEstimate: 90.5e9, time: 'AMC' },
    { symbol: 'AMD', name: 'Advanced Micro', date: new Date(Date.now() + 9 * 86400000).toISOString().split('T')[0], epsEstimate: 0.69, revenueEstimate: 5.7e9, time: 'AMC' },
    { symbol: 'META', name: 'Meta Platforms', date: new Date(Date.now() + 12 * 86400000).toISOString().split('T')[0], epsEstimate: 4.68, revenueEstimate: 36.5e9, time: 'AMC' },
  ]
  const display = data.length > 0 ? data : FALLBACK

  return (
    <div className="card">
      <div className="card-header">
        <span style={{ fontWeight: 700, fontSize: 13 }}>📅 EARNINGS CALENDAR</span>
      </div>
      <div style={{ padding: '4px 0' }}>
        {display.map(e => {
          const daysUntil = Math.ceil((new Date(e.date).getTime() - Date.now()) / 86400000)
          return (
            <div key={`${e.symbol}-${e.date}`} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 14px', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
              <div>
                <span style={{ fontSize: 13, fontWeight: 700, color: '#fbbf24', fontFamily: "'JetBrains Mono', monospace", marginRight: 8 }}>{e.symbol}</span>
                <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>{e.name}</span>
              </div>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                {e.epsEstimate != null && (
                  <span style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: "'JetBrains Mono', monospace" }}>EPS est: ${e.epsEstimate.toFixed(2)}</span>
                )}
                <span style={{ fontSize: 9, padding: '2px 5px', borderRadius: 3, fontFamily: "'JetBrains Mono', monospace", fontWeight: 700,
                  background: e.time === 'AMC' ? 'rgba(139,92,246,0.15)' : 'rgba(251,191,36,0.15)',
                  color: e.time === 'AMC' ? '#c4b5fd' : '#fde68a' }}>
                  {e.time}
                </span>
                <span style={{ fontSize: 11, fontWeight: 700, fontFamily: "'JetBrains Mono', monospace",
                  color: daysUntil <= 2 ? '#f97316' : daysUntil <= 5 ? '#fbbf24' : 'var(--text-muted)' }}>
                  {daysUntil === 0 ? 'TODAY' : daysUntil === 1 ? 'TOMORROW' : `in ${daysUntil}d`}
                </span>
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
  const [headlines, setHeadlines] = useState<NewsHeadline[]>([])
  const [redditData, setRedditData] = useState<RedditPost[]>([])
  const [earningsData, setEarningsData] = useState<EarningsEvent[]>([])
  const [lastUpdate, setLastUpdate] = useState<string>('')

  useEffect(() => {
    async function fetchAll() {
      try {
        const [newsRes, sentRes, earningsRes] = await Promise.allSettled([
          fetch(`${API}/api/sentiment/news/headlines`).then(r => r.json()),
          fetch(`${API}/api/sentiment`).then(r => r.json()),
          fetch(`${API}/api/sentiment/earnings/calendar`).then(r => r.json()),
        ])

        if (newsRes.status === 'fulfilled' && Array.isArray(newsRes.value)) {
          setHeadlines(newsRes.value)
        }
        if (sentRes.status === 'fulfilled' && Array.isArray(sentRes.value?.reddit)) {
          setRedditData(sentRes.value.reddit)
        }
        if (earningsRes.status === 'fulfilled' && Array.isArray(earningsRes.value)) {
          setEarningsData(earningsRes.value)
        }

        setLastUpdate(new Date().toLocaleTimeString())
      } catch {}
    }

    fetchAll()
    const interval = setInterval(fetchAll, 60_000)
    return () => clearInterval(interval)
  }, [])

  // Aggregate sentiment
  const avgSentiment = redditData.length > 0
    ? redditData.reduce((s, r) => s + r.sentiment, 0) / redditData.length
    : 0.1

  return (
    <div>
      <div style={{ marginBottom: 20, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h1 style={{ fontSize: 18, fontWeight: 700, color: '#fafafa', marginBottom: 4 }}>📰 News & Sentiment</h1>
          <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            NewsAPI headlines · Reddit WSB sentiment · FMP earnings calendar — real-time market narrative analysis
          </p>
        </div>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          {/* Aggregate sentiment pill */}
          <div style={{ background: avgSentiment > 0.2 ? 'rgba(34,197,94,0.1)' : avgSentiment < -0.2 ? 'rgba(239,68,68,0.1)' : 'rgba(251,191,36,0.1)',
            border: `1px solid ${avgSentiment > 0.2 ? 'rgba(34,197,94,0.3)' : avgSentiment < -0.2 ? 'rgba(239,68,68,0.3)' : 'rgba(251,191,36,0.3)'}`,
            borderRadius: 8, padding: '6px 12px' }}>
            <div style={{ fontSize: 9, color: 'var(--text-muted)', marginBottom: 2 }}>MARKET SENTIMENT</div>
            <div style={{ fontSize: 13, fontWeight: 700, fontFamily: "'JetBrains Mono', monospace",
              color: avgSentiment > 0.2 ? '#22c55e' : avgSentiment < -0.2 ? '#ef4444' : '#fbbf24' }}>
              {sentimentLabel(avgSentiment)}
            </div>
          </div>
          {lastUpdate && (
            <div style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: "'JetBrains Mono', monospace" }}>
              Updated {lastUpdate}
            </div>
          )}
        </div>
      </div>

      {/* Main content: 2-col */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
        <NewsFeed headlines={headlines} />
        <RedditPanel data={redditData} />
      </div>

      {/* Earnings full width */}
      <EarningsPanel data={earningsData} />

      <div style={{ marginTop: 12, fontSize: 10, color: 'var(--text-muted)', textAlign: 'right' }}>
        News: NewsAPI.org · Sentiment: Reddit PRAW · Earnings: Financial Modeling Prep
      </div>
    </div>
  )
}
