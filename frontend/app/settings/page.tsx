'use client'
import { useEffect, useState } from 'react'
import { apiFetch } from '@/lib/apiFetch'

/**
 * Settings — what the deployment is actually configured with.
 *
 * This page used to be a credential form. It rendered twenty-one password
 * inputs, and its save handler was:
 *
 *     const handleSave = () => { setSaved(true); setTimeout(() => setSaved(false), 2000) }
 *
 * No network call, no storage. You pasted a Tradier token and a Schwab secret,
 * pressed "💾 SAVE ALL KEYS", were shown "✓ KEYS SAVED", and the values were
 * discarded on the next navigation. Then the connectors kept reporting no
 * credentials and there was nothing to explain why.
 *
 * Implementing the save would not have helped, and that is the real finding.
 * The backend reads `TRADIER_TOKEN` and the rest **once at module load**, into
 * module-level `const`s, and runs **one** ingestion pipeline broadcasting one
 * global `flow_batch`. There is no per-user key path to write into. The
 * `api_keys` table exists in `schema.sql` — with RLS policies, an index and a
 * trigger — and nothing in the codebase reads or writes it; it could not work
 * as designed without making ingestion per-user, which it fundamentally is not.
 *
 * So the page shows the truth instead: keys live in the backend environment,
 * and here is what that environment currently produces. Every status below is
 * read from `/api/health` rather than hardcoded — which also retires three
 * hand-maintained lists that had to be corrected twice as sources changed
 * state, and which were wrong in between.
 */

interface Health {
  ingestion?: {
    sources?: Record<string, string>
    sourceErrors?: Record<string, string>
    rightsRefusals?: Array<{
      source: string
      datasetId?: string
      rightsClass: string
      mode: string
      reason: string
    }>
  }
  /** `state`, not `status` — see `getEnrichmentStatus` in backend/src/enrichment. */
  enrichment?: { state?: string; reason?: string; latchedOff?: boolean }
  history?: { store?: string; durable?: boolean; reason?: string }
}

/** Backend status string → how it reads to an operator. */
const STATUS: Record<string, { label: string; fg: string; bg: string; hint: string }> = {
  connected: { label: '✓ LIVE',        fg: '#86efac', bg: 'rgba(34,197,94,0.15)',  hint: 'Contributing data.' },
  disabled:  { label: 'NO CREDENTIALS', fg: '#fde68a', bg: 'rgba(251,191,36,0.12)', hint: 'Set the variable named below in the backend environment.' },
  error:     { label: '⚠ ERROR',        fg: '#fdba74', bg: 'rgba(251,146,60,0.14)', hint: 'The source answered with a failure.' },
  refused:   { label: '⛔ REFUSED',     fg: '#fca5a5', bg: 'rgba(248,113,113,0.15)', hint: 'Stopped on data rights. No key will turn this on.' },
}

const card: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 16 }
const mono = "'JetBrains Mono', monospace"

export default function SettingsPage() {
  const [health, setHealth] = useState<Health | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [checkedAt, setCheckedAt] = useState<string>('')

  useEffect(() => {
    let cancelled = false

    async function load() {
      try {
        const res = await apiFetch('/api/health')
        if (!res.ok) throw new Error(`backend returned ${res.status}`)
        const body = await res.json()
        if (cancelled) return
        setHealth(body)
        setError(null)
        setCheckedAt(new Date().toLocaleTimeString())
      } catch (e: any) {
        if (cancelled) return
        // An unreachable backend is its own answer, and a more useful one than
        // a blank panel: the previous page would have looked identical either
        // way, because it never asked the backend anything.
        setError(e?.message ?? 'could not reach the backend')
      }
    }

    load()
    const t = setInterval(load, 30_000)
    return () => { cancelled = true; clearInterval(t) }
  }, [])

  const sources = health?.ingestion?.sources ?? {}
  const sourceErrors = health?.ingestion?.sourceErrors ?? {}
  const refusals = health?.ingestion?.rightsRefusals ?? []

  // Live first, then the ones needing attention, then refusals — and
  // alphabetically inside each group so the list does not reshuffle on refresh.
  const order = ['connected', 'error', 'disabled', 'refused']
  const names = Object.keys(sources).sort((a, b) => {
    const d = order.indexOf(sources[a]) - order.indexOf(sources[b])
    return d !== 0 ? d : a.localeCompare(b)
  })

  const tally = order.map(s => ({ s, n: names.filter(n => sources[n] === s).length }))

  return (
    <div>
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: 18, fontWeight: 700, color: '#fafafa', marginBottom: 4 }}>⚙ Settings &amp; Data Sources</h1>
        <p style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.6, maxWidth: 780 }}>
          API keys are <strong>backend environment variables</strong>, not per-user settings — ingestion is a single
          process-wide pipeline, so there is nothing to save per account. This page reads{' '}
          <code style={{ color: '#c4b5fd', fontFamily: mono }}>/api/health</code> and reports what that environment
          is actually producing.
          {checkedAt && <span style={{ marginLeft: 6 }}>Checked {checkedAt}.</span>}
        </p>
      </div>

      {error && (
        <div className="card" style={{ marginBottom: 20, borderColor: 'rgba(248,113,113,0.4)' }}>
          <div style={{ padding: 16, fontSize: 12, color: '#fca5a5', lineHeight: 1.6 }}>
            Could not reach the backend — {error}. Nothing below is current.
          </div>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1.5fr 1fr', gap: 20 }}>
        {/* LEFT — live connector status */}
        <div style={card}>
          <div className="card">
            <div className="card-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontWeight: 700, fontSize: 12 }}>📡 CONNECTOR STATUS</span>
              <span style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: mono }}>
                {tally.filter(t => t.n > 0).map(t => `${t.n} ${STATUS[t.s]?.label.replace(/^[^A-Z]*/, '').toLowerCase()}`).join(' · ')}
              </span>
            </div>

            {names.length === 0 ? (
              <div style={{ padding: '28px 16px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>
                {error ? 'No data — the backend is unreachable.' : 'Waiting for the first health report…'}
              </div>
            ) : (
              <div style={{ padding: '8px 0' }}>
                {names.map(name => {
                  const st = STATUS[sources[name]] ?? {
                    label: sources[name]?.toUpperCase() ?? 'UNKNOWN',
                    fg: 'var(--text-muted)', bg: 'rgba(255,255,255,0.05)', hint: '',
                  }
                  const why = sourceErrors[name]
                  return (
                    <div key={name} style={{ padding: '10px 16px', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
                        <span style={{ fontSize: 12, fontWeight: 700, color: '#fafafa', fontFamily: mono }}>{name}</span>
                        <span style={{
                          fontSize: 9, fontWeight: 700, borderRadius: 3, padding: '2px 6px',
                          fontFamily: mono, whiteSpace: 'nowrap', background: st.bg, color: st.fg,
                        }}>{st.label}</span>
                      </div>
                      {/*
                        The backend's own words, not a guess made here. For a
                        missing key it names the exact variable; for a failure it
                        carries the vendor's response body, scrubbed of anything
                        credential-shaped by `describeHttpError`.
                      */}
                      {why && (
                        <div style={{ marginTop: 4, fontSize: 10, color: 'var(--text-muted)', lineHeight: 1.55, wordBreak: 'break-word' }}>
                          {why}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </div>

          {refusals.length > 0 && (
            <div className="card">
              <div className="card-header"><span style={{ fontWeight: 700, fontSize: 12 }}>⛔ REFUSED ON DATA RIGHTS</span></div>
              <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
                <p style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.6, margin: 0 }}>
                  These connectors are never started. Not a fault and not a missing key — the publisher&apos;s terms
                  prohibit the access method, quoted below from the terms page and the date it was read.
                </p>
                {refusals.map(r => (
                  <div key={r.source} style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 6, padding: '10px 12px' }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: '#fca5a5', fontFamily: mono, marginBottom: 4 }}>
                      {r.source} <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>· {r.rightsClass} · {r.mode}</span>
                    </div>
                    <div style={{ fontSize: 10, color: 'var(--text-secondary)', lineHeight: 1.6, wordBreak: 'break-word' }}>{r.reason}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* RIGHT — how to change any of it */}
        <div style={card}>
          <div className="card">
            <div className="card-header"><span style={{ fontWeight: 700, fontSize: 12 }}>🔑 SETTING A KEY</span></div>
            <div style={{ padding: 16, fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.8 }}>
              <p style={{ margin: '0 0 10px' }}>
                Every connector reads its credential from the backend environment at startup, so a key takes effect
                on the next restart — not on save, and not per user.
              </p>
              <div style={{ fontWeight: 700, color: '#fafafa', marginBottom: 4 }}>Production</div>
              <div>Render dashboard → the backend service → Environment. Every variable is declared in the
                root <code style={{ color: '#c4b5fd', fontFamily: mono }}>render.yaml</code>.</div>
              <div style={{ fontWeight: 700, color: '#fafafa', margin: '10px 0 4px' }}>Local</div>
              <div><code style={{ color: '#c4b5fd', fontFamily: mono }}>backend/.env</code> — copy the shape
                from <code style={{ color: '#c4b5fd', fontFamily: mono }}>.env.example</code>.</div>
              <p style={{ margin: '10px 0 0', color: 'var(--text-muted)' }}>
                The variable name for anything showing <strong>NO CREDENTIALS</strong> is in its status line on the left.
              </p>
            </div>
          </div>

          {(health?.enrichment || health?.history) && (
            <div className="card">
              <div className="card-header"><span style={{ fontWeight: 700, fontSize: 12 }}>🗄 COLLECTION</span></div>
              <div style={{ padding: 16, fontSize: 11, lineHeight: 1.7 }}>
                {health?.history && (
                  <div style={{ marginBottom: 10 }}>
                    <div style={{ fontWeight: 700, color: '#fafafa' }}>Signal history</div>
                    <div style={{ color: health.history.durable ? '#86efac' : '#fde68a', fontFamily: mono, fontSize: 10 }}>
                      {health.history.store ?? 'unknown'} · {health.history.durable ? 'durable' : 'NOT durable'}
                    </div>
                    {/* A deployment discarding every signal it classifies looks
                        entirely healthy until someone asks for a track record. */}
                    {!health.history.durable && health.history.reason && (
                      <div style={{ color: 'var(--text-muted)', fontSize: 10, marginTop: 3 }}>{health.history.reason}</div>
                    )}
                  </div>
                )}
                {health?.enrichment && (
                  <div>
                    <div style={{ fontWeight: 700, color: '#fafafa' }}>Web enrichment</div>
                    <div style={{ color: 'var(--text-muted)', fontFamily: mono, fontSize: 10 }}>
                      {health.enrichment.state ?? 'unknown'}
                      {health.enrichment.reason ? ` — ${health.enrichment.reason}` : ''}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          <div className="card">
            <div className="card-header"><span style={{ fontWeight: 700, fontSize: 12 }}>🚀 DEPLOYMENT</span></div>
            <div style={{ padding: 16, fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.9, fontFamily: mono }}>
              <div style={{ marginBottom: 10, fontWeight: 700, color: '#fafafa' }}>Frontend (Vercel)</div>
              <div>1. Import GitHub repo to Vercel</div>
              <div>2. Root dir: <code style={{ color: '#c4b5fd' }}>frontend</code></div>
              <div>3. Build: <code style={{ color: '#c4b5fd' }}>npm run build</code></div>
              <div style={{ marginTop: 10, marginBottom: 10, fontWeight: 700, color: '#fafafa' }}>Backend + ML (Render)</div>
              <div>1. New Blueprint → connect repo</div>
              <div>2. Uses the root <code style={{ color: '#c4b5fd' }}>render.yaml</code></div>
              <div>3. Set each <code style={{ color: '#c4b5fd' }}>sync: false</code> variable</div>
              <div style={{ marginTop: 12 }}>
                <a href="https://render.com" target="_blank" rel="noopener noreferrer" style={{ color: '#a78bfa', textDecoration: 'none', fontSize: 11 }}>↗ render.com dashboard</a>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
