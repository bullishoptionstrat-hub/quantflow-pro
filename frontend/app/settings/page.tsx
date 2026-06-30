'use client'
import { useState } from 'react'

// ─── All 21 API key slots (original 8 + 13 new) ──────────────────────────────
const API_KEY_GROUPS = [
  {
    group: '🔑 CORE DATA SOURCES',
    keys: [
      { id: 'tradier',       label: 'Tradier API Token',         placeholder: 'Bearer token · developer.tradier.com',                link: 'https://developer.tradier.com/user/sign_up' },
      { id: 'polygon',       label: 'Polygon.io API Key',         placeholder: 'Free tier: 5 calls/min · polygon.io',                link: 'https://polygon.io/dashboard/signup' },
      { id: 'alpaca',        label: 'Alpaca Key:Secret',          placeholder: 'KEY_ID:SECRET_KEY (colon-separated)',                 link: 'https://app.alpaca.markets/signup' },
      { id: 'finnhub',       label: 'Finnhub API Key',            placeholder: 'Free tier available · finnhub.io',                   link: 'https://finnhub.io/register' },
      { id: 'alphavantage',  label: 'Alpha Vantage Key',          placeholder: 'Free 25 req/day · alphavantage.co',                  link: 'https://www.alphavantage.co/support/#api-key' },
    ],
  },
  {
    group: '⚡ NEW: OPTIONS & FLOW',
    keys: [
      { id: 'flashalpha',    label: 'FlashAlpha API Key',         placeholder: 'FLASHALPHA_API_KEY · GEX/DEX/VEX · 5 req/day',      link: 'https://flashalpha.com' },
      { id: 'marketdata',    label: 'MarketData.app Token',       placeholder: 'MARKETDATA_TOKEN · OPRA real data · 100 credits/day', link: 'https://app.marketdata.app/register' },
      { id: 'schwab',        label: 'Schwab App Key:Secret',      placeholder: 'APP_KEY:APP_SECRET · developer.schwab.com',          link: 'https://developer.schwab.com' },
      { id: 'schwab_refresh',label: 'Schwab Refresh Token',       placeholder: 'SCHWAB_REFRESH_TOKEN · from OAuth flow',             link: 'https://developer.schwab.com' },
      { id: 'tastytrade',    label: 'Tastytrade User:Pass',        placeholder: 'username:password · developer.tastytrade.com',       link: 'https://developer.tastytrade.com' },
    ],
  },
  {
    group: '📊 NEW: QUOTES & MACRO',
    keys: [
      { id: 'twelvedata',    label: 'Twelve Data API Key',        placeholder: 'TWELVE_DATA_API_KEY · 800 req/day · twelvedata.com', link: 'https://twelvedata.com/signup' },
      { id: 'fmp',           label: 'FMP API Key',                placeholder: 'FMP_API_KEY · earnings/insiders/news · 250 req/day', link: 'https://financialmodelingprep.com/developer/docs' },
      { id: 'coingecko',     label: 'CoinGecko API Key',          placeholder: 'COINGECKO_API_KEY · 10K req/month free',             link: 'https://www.coingecko.com/en/api/pricing' },
      { id: 'fred',          label: 'FRED API Key',               placeholder: 'FRED_API_KEY · unlimited · stlouisfed.org',          link: 'https://fred.stlouisfed.org/docs/api/api_key.html' },
    ],
  },
  {
    group: '🧠 NEW: SENTIMENT & NEWS',
    keys: [
      { id: 'reddit_id',     label: 'Reddit Client ID',           placeholder: 'REDDIT_CLIENT_ID · reddit.com/prefs/apps',           link: 'https://www.reddit.com/prefs/apps' },
      { id: 'reddit_secret', label: 'Reddit Client Secret',       placeholder: 'REDDIT_CLIENT_SECRET',                              link: 'https://www.reddit.com/prefs/apps' },
      { id: 'reddit_agent',  label: 'Reddit User Agent',          placeholder: 'QuantFlowPro/1.0 by YourUsername',                   link: 'https://www.reddit.com/prefs/apps' },
      { id: 'newsapi',       label: 'NewsAPI Key',                placeholder: 'NEWS_API_KEY · 100 req/day free · newsapi.org',      link: 'https://newsapi.org/register' },
    ],
  },
  {
    group: '🆓 NO KEY NEEDED',
    keys: [
      { id: 'cboe_note',     label: 'CBOE VIX / PCR Data',       placeholder: 'Auto-enabled · CBOE_ENABLED=true in backend env',    link: 'https://www.cboe.com/tradable_products/vix/' },
      { id: 'yahoo_note',    label: 'Yahoo Finance Fallback',     placeholder: 'Auto-enabled · YAHOO_ENABLED=true in backend env',   link: 'https://finance.yahoo.com' },
      { id: 'stooq_note',    label: 'Stooq Futures & Yields',     placeholder: 'Auto-enabled · STOOQ_ENABLED=true in backend env',   link: 'https://stooq.com' },
    ],
  },
]

const FREE_KEYS = ['cboe_note', 'yahoo_note', 'stooq_note']

const ENV_VARS = [
  'NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_KEY', 'NEXT_PUBLIC_WS_URL', 'UPSTASH_REDIS_REST_URL',
  'UPSTASH_REDIS_REST_TOKEN', 'FRONTEND_URL', 'PORT',
]

const inputStyle: React.CSSProperties = {
  background: '#09090b', border: '1px solid var(--border)', color: 'var(--text-primary)',
  borderRadius: 5, padding: '7px 10px', fontSize: 12, fontFamily: "'JetBrains Mono', monospace",
  outline: 'none', width: '100%',
}

export default function SettingsPage() {
  const [keys, setKeys] = useState<Record<string, string>>({})
  const [saved, setSaved] = useState(false)
  const [showTokens, setShowTokens] = useState(false)

  const handleSave = () => {
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  return (
    <div>
      <div style={{ marginBottom: 24, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h1 style={{ fontSize: 18, fontWeight: 700, color: '#fafafa', marginBottom: 4 }}>⚙ Settings & API Keys</h1>
          <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            Configure all 21 data source connections · Keys stored in Railway/Render environment variables for production
          </p>
        </div>
        <button
          onClick={() => setShowTokens(v => !v)}
          style={{ fontSize: 11, background: 'rgba(255,255,255,0.05)', border: '1px solid var(--border)', color: 'var(--text-muted)', borderRadius: 5, padding: '5px 10px', cursor: 'pointer', fontFamily: "'JetBrains Mono', monospace" }}
        >
          {showTokens ? '🙈 HIDE' : '👁 SHOW'} KEYS
        </button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1.5fr 1fr', gap: 20 }}>
        {/* LEFT — API Keys */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {API_KEY_GROUPS.map(group => (
            <div key={group.group} className="card">
              <div className="card-header">
                <span style={{ fontWeight: 700, fontSize: 12 }}>{group.group}</span>
              </div>
              <div style={{ padding: 16 }}>
                {group.keys.map(k => {
                  const isFree = FREE_KEYS.includes(k.id)
                  return (
                    <div key={k.id} style={{ marginBottom: 14 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 5 }}>
                        <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)', letterSpacing: '0.04em' }}>
                          {k.label}
                          {isFree && <span style={{ marginLeft: 6, fontSize: 9, background: 'rgba(34,197,94,0.15)', color: '#86efac', borderRadius: 3, padding: '1px 5px', fontFamily: "'JetBrains Mono', monospace" }}>AUTO</span>}
                        </label>
                        <a href={k.link} target="_blank" rel="noopener noreferrer" style={{ fontSize: 10, color: '#a78bfa', textDecoration: 'none' }}>↗ Get Key</a>
                      </div>
                      {isFree ? (
                        <div style={{ ...inputStyle, color: '#86efac', cursor: 'default', opacity: 0.7 }}>
                          {k.placeholder}
                        </div>
                      ) : (
                        <input
                          type={showTokens ? 'text' : 'password'}
                          placeholder={k.placeholder}
                          value={keys[k.id] || ''}
                          onChange={e => setKeys(prev => ({ ...prev, [k.id]: e.target.value }))}
                          style={inputStyle}
                        />
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          ))}

          <button
            onClick={handleSave}
            style={{
              width: '100%',
              background: saved ? 'rgba(34,197,94,0.15)' : 'rgba(139,92,246,0.15)',
              border: `1px solid ${saved ? 'rgba(34,197,94,0.4)' : 'rgba(139,92,246,0.4)'}`,
              color: saved ? '#86efac' : '#a78bfa',
              padding: '12px',
              borderRadius: 6,
              cursor: 'pointer',
              fontSize: 13,
              fontWeight: 700,
              fontFamily: "'JetBrains Mono', monospace",
              letterSpacing: '0.04em',
            }}
          >
            {saved ? '✓ KEYS SAVED' : '💾 SAVE ALL KEYS'}
          </button>
        </div>

        {/* RIGHT — Deploy guide + env vars */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* Data source status */}
          <div className="card">
            <div className="card-header"><span style={{ fontWeight: 700, fontSize: 12 }}>✅ DATA SOURCE STATUS</span></div>
            <div style={{ padding: 16 }}>
              {[
                { label: 'CBOE', status: 'auto', note: 'VIX, PCR — no key' },
                { label: 'Yahoo Finance', status: 'auto', note: 'Quotes, fallback flow' },
                { label: 'Stooq', status: 'auto', note: 'Futures, yields' },
                { label: 'FRED', status: 'key', note: 'CPI, FFR, M2, PCE' },
                { label: 'CoinGecko', status: 'key', note: 'Crypto prices + global' },
                { label: 'NewsAPI', status: 'key', note: 'Financial headlines' },
                { label: 'Reddit', status: 'key', note: 'WSB sentiment' },
                { label: 'TwelveData', status: 'key', note: 'Live quotes WS' },
                { label: 'FMP', status: 'key', note: 'Earnings, insiders' },
                { label: 'FlashAlpha', status: 'key', note: 'GEX/DEX/VEX' },
                { label: 'MarketData.app', status: 'key', note: 'OPRA options' },
                { label: 'Schwab', status: 'key', note: 'OAuth2 + account' },
                { label: 'Tastytrade', status: 'key', note: 'Options flow' },
              ].map(item => (
                <div key={item.label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <div>
                    <span style={{ fontSize: 11, fontWeight: 600, color: '#fafafa', fontFamily: "'JetBrains Mono', monospace" }}>{item.label}</span>
                    <span style={{ fontSize: 10, color: 'var(--text-muted)', marginLeft: 6 }}>{item.note}</span>
                  </div>
                  <span style={{
                    fontSize: 9, fontWeight: 700, borderRadius: 3, padding: '2px 6px', fontFamily: "'JetBrains Mono', monospace",
                    background: item.status === 'auto' ? 'rgba(34,197,94,0.15)' : 'rgba(251,191,36,0.12)',
                    color: item.status === 'auto' ? '#86efac' : '#fde68a',
                  }}>
                    {item.status === 'auto' ? '✓ AUTO' : 'NEEDS KEY'}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* Deployment guide */}
          <div className="card">
            <div className="card-header"><span style={{ fontWeight: 700, fontSize: 12 }}>🚀 DEPLOYMENT GUIDE</span></div>
            <div style={{ padding: 16, fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.9, fontFamily: "'JetBrains Mono', monospace" }}>
              <div style={{ marginBottom: 10, fontWeight: 700, color: '#fafafa' }}>Frontend (Vercel)</div>
              <div>1. Import GitHub repo to Vercel</div>
              <div>2. Root dir: <code style={{ color: '#c4b5fd' }}>frontend</code></div>
              <div>3. Build: <code style={{ color: '#c4b5fd' }}>npm run build</code></div>
              <div style={{ marginTop: 10, marginBottom: 10, fontWeight: 700, color: '#fafafa' }}>Backend (Render)</div>
              <div>1. New Web Service → connect repo</div>
              <div>2. Root dir: <code style={{ color: '#c4b5fd' }}>backend</code></div>
              <div>3. Build: <code style={{ color: '#c4b5fd' }}>npm install && npm run build</code></div>
              <div>4. Start: <code style={{ color: '#c4b5fd' }}>node dist/server.js</code></div>
              <div style={{ marginTop: 12 }}>
                <a href="https://render.com" target="_blank" rel="noopener noreferrer" style={{ color: '#a78bfa', textDecoration: 'none', fontSize: 11 }}>↗ render.com dashboard</a>
              </div>
            </div>
          </div>

          {/* Env vars quick ref */}
          <div className="card">
            <div className="card-header"><span style={{ fontWeight: 700, fontSize: 12 }}>📋 REQUIRED ENV VARS</span></div>
            <div style={{ padding: '8px 12px' }}>
              {[
                'TRADIER_TOKEN', 'POLYGON_API_KEY', 'FINNHUB_API_KEY',
                'FLASHALPHA_API_KEY', 'MARKETDATA_TOKEN',
                'SCHWAB_APP_KEY', 'SCHWAB_APP_SECRET', 'SCHWAB_REFRESH_TOKEN',
                'TASTYTRADE_USER', 'TASTYTRADE_PASS',
                'TWELVE_DATA_API_KEY', 'FMP_API_KEY', 'COINGECKO_API_KEY',
                'FRED_API_KEY', 'REDDIT_CLIENT_ID', 'REDDIT_CLIENT_SECRET',
                'REDDIT_USER_AGENT', 'NEWS_API_KEY',
                'CBOE_ENABLED=true', 'YAHOO_ENABLED=true', 'STOOQ_ENABLED=true',
              ].map(v => (
                <div key={v} style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, color: v.includes('=true') ? '#86efac' : '#c4b5fd', padding: '2px 0' }}>{v}</div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
