'use client'
import { useState } from 'react'

const API_KEYS = [
  { id: 'tradier', label: 'Tradier API Token', placeholder: 'Bearer token from developer.tradier.com', link: 'https://developer.tradier.com' },
  { id: 'polygon', label: 'Polygon.io API Key', placeholder: 'Free tier: 5 calls/min · polygon.io/dashboard', link: 'https://polygon.io/dashboard' },
  { id: 'alpaca', label: 'Alpaca API Key:Secret', placeholder: 'KEY_ID:SECRET_KEY (colon-separated)', link: 'https://alpaca.markets/docs/api-documentation/' },
  { id: 'finnhub', label: 'Finnhub API Key', placeholder: 'Free tier available · finnhub.io', link: 'https://finnhub.io/register' },
  { id: 'alphavantage', label: 'Alpha Vantage Key', placeholder: 'Free 25 req/day · alphavantage.co', link: 'https://www.alphavantage.co/support/#api-key' },
  { id: 'marketdata', label: 'MarketData.app Token', placeholder: 'OPRA real data · marketdata.app', link: 'https://app.marketdata.app' },
  { id: 'tastytrade', label: 'TastyTrade Credentials', placeholder: 'username:password (colon-separated)', link: 'https://developer.tastytrade.com' },
  { id: 'flashalpha', label: 'FlashAlpha API Key', placeholder: '5 req/day free · GEX, DEX, VEX data', link: 'https://flashalpha.com' },
]

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

  const handleSave = () => {
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  return (
    <div>
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: 18, fontWeight: 700, color: '#fafafa', marginBottom: 4 }}>⚙ Settings & API Keys</h1>
        <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>Configure your data sources · Keys stored in Railway/Render environment variables for production</p>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
        {/* API Keys */}
        <div>
          <div className="card">
            <div className="card-header">
              <span style={{ fontWeight: 700, fontSize: 13 }}>🔑 DATA SOURCE API KEYS</span>
            </div>
            <div style={{ padding: 16 }}>
              {API_KEYS.map(k => (
                <div key={k.id} style={{ marginBottom: 16 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 5 }}>
                    <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)', letterSpacing: '0.04em' }}>{k.label}</label>
                    <a href={k.link} target="_blank" rel="noopener noreferrer" style={{ fontSize: 10, color: '#a78bfa', textDecoration: 'none' }}>↗ Get Key</a>
                  </div>
                  <input
                    type="password"
                    placeholder={k.placeholder}
                    value={keys[k.id] || ''}
                    onChange={e => setKeys(prev => ({ ...prev, [k.id]: e.target.value }))}
                    style={inputStyle}
                  />
                </div>
              ))}
              <button
                onClick={handleSave}
                style={{ width: '100%', background: saved ? 'rgba(34,197,94,0.15)' : 'rgba(139,92,246,0.15)', border: `1px solid ${saved ? 'rgba(34,197,94,0.4)' : 'rgba(139,92,246,0.4)'}`, color: saved ? '#86efac' : '#a78bfa', padding: '10px', borderRadius: 6, cursor: 'pointer', fontSize: 13, fontWeight: 700, fontFamily: "'JetBrains Mono', monospace" }}
              >
                {saved ? '✓ SAVED' : '💾 SAVE KEYS'}
              </button>
            </div>
          </div>
        </div>

        {/* Deployment guide */}
        <div>
          <div className="card" style={{ marginBottom: 16 }}>
            <div className="card-header"><span style={{ fontWeight: 700, fontSize: 13 }}>🚀 DEPLOYMENT GUIDE</span></div>
            <div style={{ padding: 16, fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.8 }}>
              <div style={{ marginBottom: 12 }}>
                <div style={{ fontWeight: 700, color: '#fafafa', marginBottom: 4 }}>1. Supabase (Database)</div>
                <a href="https://supabase.com" target="_blank" rel="noopener noreferrer" style={{ color: '#60a5fa', textDecoration: 'none' }}>supabase.com</a> → New project → SQL Editor → Run schema SQL
              </div>
              <div style={{ marginBottom: 12 }}>
                <div style={{ fontWeight: 700, color: '#fafafa', marginBottom: 4 }}>2. Upstash Redis (Sweep cache)</div>
                <a href="https://upstash.com" target="_blank" rel="noopener noreferrer" style={{ color: '#60a5fa', textDecoration: 'none' }}>upstash.com</a> → Redis → Copy REST URL + Token
              </div>
              <div style={{ marginBottom: 12 }}>
                <div style={{ fontWeight: 700, color: '#fafafa', marginBottom: 4 }}>3. Render (Backend)</div>
                Connect GitHub → New Web Service → Set env vars → Start: <code style={{ background: 'var(--bg-secondary)', padding: '1px 5px', borderRadius: 3 }}>node dist/server.js</code>
              </div>
              <div style={{ marginBottom: 12 }}>
                <div style={{ fontWeight: 700, color: '#fafafa', marginBottom: 4 }}>4. Vercel (Frontend)</div>
                <code style={{ background: 'var(--bg-secondary)', padding: '1px 5px', borderRadius: 3 }}>vercel deploy</code> from <code style={{ background: 'var(--bg-secondary)', padding: '1px 5px', borderRadius: 3 }}>frontend/</code> → Set NEXT_PUBLIC_ vars
              </div>
              <div>
                <div style={{ fontWeight: 700, color: '#fafafa', marginBottom: 4 }}>5. Keepalive (Free tier)</div>
                <a href="https://cron-job.org" target="_blank" rel="noopener noreferrer" style={{ color: '#60a5fa', textDecoration: 'none' }}>cron-job.org</a> → ping <code style={{ background: 'var(--bg-secondary)', padding: '1px 5px', borderRadius: 3 }}>/health</code> every 10min
              </div>
            </div>
          </div>

          <div className="card">
            <div className="card-header"><span style={{ fontWeight: 700, fontSize: 13 }}>🌐 ENV VARIABLES (Render/Vercel)</span></div>
            <div style={{ padding: 16 }}>
              {ENV_VARS.map(v => (
                <div key={v} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid var(--border)', fontSize: 11, fontFamily: "'JetBrains Mono', monospace" }}>
                  <span style={{ color: '#a78bfa' }}>{v}</span>
                  <span style={{ color: 'var(--text-muted)' }}>required</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
