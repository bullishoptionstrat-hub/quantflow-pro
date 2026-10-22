'use client'
import { useEffect, useMemo, useState } from 'react'
import { loadPanel, type Panel } from '@/lib/panel'
import { describeSession, useMarketSession } from '@/lib/marketSession'
import { formatPremium } from '@/lib/utils'
import type {
  BacktestRow, FlowEvent, GEXResponse, OvernightFlowResponse, TrackRecordResponse,
} from '@/lib/types'

/**
 * ROADMAP 5.2 — one screen, opened once a day: the overnight flow, today's
 * GEX profile, the gamma flip, and the track record to date.
 *
 * It composes four endpoints the terminal already serves, and adds one
 * (`/api/flow/overnight`), because "overnight" is a calendar question and the
 * calendar lives in the backend. Every rule below is inherited, not re-decided:
 *
 *   - **The window is the backend's.** The browser never computes a previous
 *     close: "since yesterday at 16:00" is wrong on every Monday, after every
 *     holiday and after every half day, and the source scan in
 *     `marketSession.test.tsx` forbids a local weekday check outright. An
 *     UNKNOWN window is shown as unknown, never as an empty night.
 *   - **A partial window says so.** The server buffer holds 500 signals and
 *     starts empty at boot; a free-tier instance that slept at 02:00 saw part
 *     of the night, and labelling that part "overnight" is a smaller sample
 *     under a larger name.
 *   - **The gamma flip is the backend's refusal.** `flipStrike` is `null` with
 *     `flipUnavailable` saying why (ROADMAP 3.2). This renders the reason; it
 *     does not compute a flip of its own from the levels, which is the rule
 *     the backend removed.
 *   - **GEX is modelled.** The `assumptions` block is rendered verbatim, so the
 *     dealer-positioning assumption sits next to the number it produces.
 *   - **A suppressed rate is never a 0%.** Below `minSample` there is no
 *     `hitRate` field and the cell says SUPPRESSED with the sample size.
 *   - **`real: 0` is said in words.** An empty table beside a confident layout
 *     reads as "nothing happened", when what is true is "nothing real has been
 *     recorded".
 */

const GEX_TICKERS = ['SPY', 'SPX', 'QQQ']
const TOP_FLOW = 10
const TOP_STRIKES = 5

const mono = "'JetBrains Mono', monospace"
const muted: React.CSSProperties = { fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.6 }
const heading: React.CSSProperties = { fontWeight: 700, fontSize: 13 }

/**
 * Built from parts rather than from `toLocaleString`, whose joining
 * punctuation differs between ICU builds. `hourCycle: 'h23'` rather than
 * `hour12: false`, which renders midnight as "24" in some builds — the hour is
 * also taken modulo 24, the read `backend/src/market/civil.ts` makes.
 */
const ET_PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
})

/** An instant rendered in New York time with the weekday, e.g. "Fri Sep 25 16:00 ET". */
export function etInstant(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  const parts = ET_PARTS.formatToParts(d)
  const at = (k: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === k)?.value
  const wd = at('weekday'), mo = at('month'), day = at('day'), h = Number(at('hour')), m = at('minute')
  if (!wd || !mo || !day || !m || !Number.isInteger(h)) return '—'
  return `${wd} ${mo} ${day} ${String(h % 24).padStart(2, '0')}:${m} ET`
}

/** Why a panel has nothing — the three cases `lib/panel.ts` keeps apart. */
function PanelState({ panel, what }: { panel: Panel<unknown>; what: string }) {
  const text = panel.status === 'loading'
    ? `Loading ${what}…`
    : panel.status === 'unauthorized'
      ? `The backend refused this session for ${what} — an expired sign-in, or a demo cookie against a backend without demo mode.`
      : `The backend did not answer for ${what}.`
  return <div style={{ ...muted, padding: '20px 16px', textAlign: 'center' }}>{text}</div>
}

function Card({ title, aside, children }: { title: string; aside?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="card-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <span style={heading}>{title}</span>
        {aside && <span style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: mono }}>{aside}</span>}
      </div>
      {children}
    </div>
  )
}

// ─── Overnight flow ─────────────────────────────────────────────────────────

export function OvernightPanel({ panel }: { panel: Panel<OvernightFlowResponse> }) {
  if (panel.status !== 'ok') {
    return <Card title="OVERNIGHT FLOW"><PanelState panel={panel} what="overnight flow" /></Card>
  }
  const o = panel.data
  const w = o.window

  if (w.state === 'UNKNOWN') {
    return (
      <Card title="OVERNIGHT FLOW" aside="WINDOW UNKNOWN">
        <div style={{ padding: '16px', ...muted }}>
          <div style={{ fontWeight: 600, color: '#fde68a', marginBottom: 4 }}>
            The session calendar cannot establish when the last regular close was.
          </div>
          {/* Not an empty night: the window could not be drawn at all. */}
          <div>{w.basis}</div>
        </div>
      </Card>
    )
  }

  const top = [...o.data].sort((a, b) => b.total_premium - a.total_premium).slice(0, TOP_FLOW)
  const premium = o.data.reduce((s, e) => s + e.total_premium, 0)
  const calls = o.data.filter((e) => e.option_type === 'C').reduce((s, e) => s + e.total_premium, 0)
  const puts = premium - calls

  return (
    <Card title="OVERNIGHT FLOW" aside={`${etInstant(w.from)} → ${w.closedBySessionOpen ? etInstant(w.to) : 'now'}`}>
      <div style={{ padding: '12px 16px 0' }}>
        <div style={muted} data-testid="overnight-basis">
          Since the exchange&apos;s last published regular close{w.closedBySessionOpen ? ', to today\'s open' : ''}. {w.basis}.
        </div>
        <div data-testid="overnight-coverage" style={{
          ...muted, marginTop: 6,
          color: o.coverage.complete ? 'var(--text-muted)' : '#fde68a',
        }}>
          {o.coverage.complete
            ? `Whole window seen: ${o.coverage.basis}.`
            : `PARTIAL WINDOW — ${o.coverage.basis}. ` +
              (o.coverage.oldestBufferedAt ? `Oldest signal held: ${etInstant(o.coverage.oldestBufferedAt)}.` : 'Nothing is held.')}
        </div>
        <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', fontSize: 12, fontFamily: mono, margin: '10px 0' }}>
          <span>signals: <strong>{o.count}</strong></span>
          <span>premium: <strong>{o.count ? formatPremium(premium) : '—'}</strong></span>
          <span>calls: <strong style={{ color: '#86efac' }}>{o.count ? formatPremium(calls) : '—'}</strong></span>
          <span>puts: <strong style={{ color: '#fca5a5' }}>{o.count ? formatPremium(puts) : '—'}</strong></span>
          {o.synthetic > 0 && (
            <span style={{ color: '#fde68a' }} title="Constructed from aggregate volume or generated — not an observed print">
              {o.synthetic === o.count ? 'all' : `${o.synthetic} of ${o.count}`} not observed prints
            </span>
          )}
        </div>
      </div>

      {o.count === 0 ? (
        <div style={{ ...muted, padding: '12px 16px 20px', textAlign: 'center' }}>
          No signal arrived inside the window{o.coverage.complete ? '.' : ' that this process saw.'}
        </div>
      ) : (
        <table className="flow-table">
          <thead>
            <tr><th>TICKER</th><th>CONTRACT</th><th>TYPE</th><th>PREMIUM</th><th>HEAT</th><th>AT</th></tr>
          </thead>
          <tbody>
            {top.map((e: FlowEvent) => (
              <tr key={e.id}>
                <td style={{ fontWeight: 700, color: '#a78bfa' }}>
                  {e.underlying}
                  {e.synthetic && (
                    <span title="Constructed from aggregate volume or generated — not an observed print"
                      style={{ marginLeft: 6, fontSize: 9, color: '#fde68a' }}>SYN</span>
                  )}
                </td>
                <td style={{ fontFamily: mono }}>{e.strike}{e.option_type} {e.expiry}</td>
                <td>{e.order_type}</td>
                <td style={{ fontFamily: mono }}>{formatPremium(e.total_premium)}</td>
                <td style={{ fontFamily: mono }}>{e.heat_score}</td>
                <td style={{ fontSize: 11, fontFamily: mono, color: 'var(--text-muted)' }}>{etInstant(e.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  )
}

// ─── GEX profile and flip ───────────────────────────────────────────────────

export function GexPanel({ panel, symbol }: { panel: Panel<GEXResponse>; symbol: string }) {
  if (panel.status !== 'ok') {
    return <Card title={`GEX PROFILE — ${symbol}`}><PanelState panel={panel} what={`the ${symbol} chain`} /></Card>
  }
  const g = panel.data
  if (!g.realData || g.levels.length === 0) {
    return (
      <Card title={`GEX PROFILE — ${symbol}`} aside="NO REAL CHAIN">
        <div style={{ ...muted, padding: '16px', textAlign: 'center' }}>
          {g.unavailableReason ?? 'The backend has no real options chain for this symbol.'} Nothing is drawn rather than something guessed.
        </div>
      </Card>
    )
  }

  const byAbs = [...g.levels].sort((a, b) => Math.abs(b.gex) - Math.abs(a.gex)).slice(0, TOP_STRIKES)
  const m = (v: number | null) => (v == null ? '—' : `${v >= 0 ? '+' : ''}${(v / 1e6).toFixed(1)}M`)

  return (
    <Card title={`GEX PROFILE — ${symbol}`}
      aside={`${String(g.source).toUpperCase()} · ${g.delayedMinutes ?? '?'}MIN DELAYED · ${etInstant(g.updatedAt)}`}>
      <div style={{ padding: '12px 16px' }}>
        <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', fontSize: 12, fontFamily: mono }}>
          <span>net GEX: <strong>{m(g.keyLevels.totalGex)}</strong></span>
          <span>largest +: <strong style={{ color: '#22c55e' }}>{g.keyLevels.gex.maxStrike ?? '—'}</strong></span>
          <span>largest −: <strong style={{ color: '#ef4444' }}>{g.keyLevels.gex.minStrike ?? '—'}</strong></span>
          <span>0DTE: <strong>{g.zeroDte ? `${g.zeroDte.contractCount} contracts (${g.zeroDte.expiry})` : 'no same-day expiry'}</strong></span>
        </div>

        {/* The flip: the backend's value or the backend's refusal. Never one
            computed here from the levels — that rule was removed for returning
            a strike 76% below spot. */}
        <div data-testid="gamma-flip" style={{ marginTop: 10, fontSize: 12 }}>
          <span style={{ fontWeight: 700, color: '#fbbf24' }}>GAMMA FLIP: </span>
          {g.flipStrike != null ? (
            <strong style={{ fontFamily: mono }}>{g.flipStrike}</strong>
          ) : (
            <>
              <strong style={{ color: '#fde68a' }}>NOT PUBLISHED</strong>
              <span style={{ ...muted, display: 'block', marginTop: 2 }}>
                {g.flipUnavailable ?? 'The backend gave no flip and no reason.'}
              </span>
            </>
          )}
        </div>
      </div>

      <table className="flow-table">
        <thead><tr><th>STRIKE</th><th>NET GEX</th><th>CALL OI</th><th>PUT OI</th></tr></thead>
        <tbody>
          {byAbs.map((l) => (
            <tr key={l.strike}>
              <td style={{ fontWeight: 700, color: '#a78bfa' }}>{l.strike}</td>
              <td style={{ color: l.gex >= 0 ? '#22c55e' : '#ef4444', fontFamily: mono }}>{m(l.gex)}</td>
              <td style={{ fontFamily: mono }}>{l.callOI.toLocaleString()}</td>
              <td style={{ fontFamily: mono }}>{l.putOI.toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {g.assumptions && Object.keys(g.assumptions).length > 0 && (
        <div data-testid="gex-assumptions" style={{ padding: '10px 16px 14px' }}>
          <div style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 700, marginBottom: 6, letterSpacing: '0.04em' }}>
            MODELLED, NOT OBSERVED
          </div>
          <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {Object.entries(g.assumptions).map(([k, v]) => (
              <li key={k} style={muted}>{v}</li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  )
}

// ─── Track record ───────────────────────────────────────────────────────────

const mins = (ms: number) => Math.round(ms / 60_000)

export function TrackRecordPanel({ panel }: { panel: Panel<TrackRecordResponse> }) {
  if (panel.status !== 'ok') {
    return <Card title="TRACK RECORD TO DATE"><PanelState panel={panel} what="the track record" /></Card>
  }
  const t = panel.data
  const c = t.counts

  return (
    <Card title="TRACK RECORD TO DATE" aside={`store: ${t.storeKind} · ${etInstant(t.generatedAt)}`}>
      <div style={{ padding: '12px 16px' }}>
        <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', fontSize: 12, fontFamily: mono }}>
          <span>recorded: <strong>{c.total}</strong></span>
          <span>real: <strong style={{ color: c.real > 0 ? '#fafafa' : '#fde68a' }}>{c.real}</strong></span>
          <span>synthetic: <strong>{c.synthetic}</strong></span>
        </div>
        {c.real === 0 && (
          <div data-testid="no-real-record" style={{ ...muted, marginTop: 8, color: '#fde68a' }}>
            No real signal has been recorded. Every row this deployment holds is synthetic, and synthetic
            signals never enter a rate — so there is no track record yet, only the machinery for one.
          </div>
        )}
      </div>

      {t.rows.length > 0 && (
        <table className="flow-table">
          <thead>
            <tr><th>KIND</th><th>HORIZON</th><th>HIT RATE</th><th>GRADED</th><th>UNGRADED</th><th>MEASURED OVER</th></tr>
          </thead>
          <tbody>
            {t.rows.map((r: BacktestRow) => {
              const mi = r.measuredInterval
              return (
                <tr key={`${r.kind}|${r.horizon}`}>
                  <td style={{ fontWeight: 700, color: '#a78bfa' }}>{r.kind}</td>
                  <td style={{ fontFamily: mono }}>{r.horizon}</td>
                  <td>
                    {r.suppressionReason === 'INSUFFICIENT_SAMPLE' || r.hitRate == null ? (
                      <span style={{ color: '#fde68a', fontSize: 11, fontWeight: 700 }}>
                        SUPPRESSED (n&lt;{t.minSample}) · n={r.nGraded}
                      </span>
                    ) : (
                      <strong>{(r.hitRate * 100).toFixed(1)}%</strong>
                    )}
                  </td>
                  <td style={{ fontFamily: mono }}>{r.nGraded}</td>
                  <td style={{ fontFamily: mono }}>{r.nUngraded}</td>
                  <td style={{ fontSize: 11, fontFamily: mono, color: 'var(--text-muted)' }}>
                    {mi?.medianMs != null
                      ? `${mins(mi.medianMs)}min${mi.nominalMs != null ? ` / ${mins(mi.nominalMs)} nominal` : ''}`
                      : '—'}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}

      {/* Verbatim. These sentences keep the numbers above honest. */}
      {t.notes.length > 0 && (
        <ul style={{ margin: 0, padding: '4px 16px 8px 34px', display: 'flex', flexDirection: 'column', gap: 6 }}>
          {t.notes.map((n, i) => <li key={i} style={muted}>{n}</li>)}
        </ul>
      )}
      <div style={{ ...muted, padding: '0 16px 14px' }}>{t.disclaimer}</div>
    </Card>
  )
}

// ─── The screen ─────────────────────────────────────────────────────────────

export function MorningView() {
  const { panel: sessionPanel } = useMarketSession()
  const session = describeSession(sessionPanel.status === 'ok' ? sessionPanel.data : null)

  const [overnight, setOvernight] = useState<Panel<OvernightFlowResponse>>({ status: 'loading' })
  const [track, setTrack] = useState<Panel<TrackRecordResponse>>({ status: 'loading' })
  const [symbol, setSymbol] = useState(GEX_TICKERS[0]!)
  const [gex, setGex] = useState<Panel<GEXResponse>>({ status: 'loading' })

  // Opened once a day: fetched on mount, refreshed on demand. A poller here
  // would be a second copy of the flow page.
  const [tick, setTick] = useState(0)
  useEffect(() => {
    let live = true
    void loadPanel('/api/flow/overnight', (b) => b as OvernightFlowResponse).then((p) => { if (live) setOvernight(p) })
    void loadPanel('/api/track-record', (b) => b as TrackRecordResponse).then((p) => { if (live) setTrack(p) })
    return () => { live = false }
  }, [tick])

  useEffect(() => {
    let live = true
    setGex({ status: 'loading' })
    void loadPanel(`/api/gex?symbol=${encodeURIComponent(symbol)}`, (b) => b as GEXResponse)
      .then((p) => { if (live) setGex(p) })
    return () => { live = false }
  }, [symbol, tick])

  const sessionColour = useMemo(
    () => ({ open: '#22c55e', closed: 'var(--text-secondary)', unknown: '#fde68a' })[session.tone],
    [session.tone],
  )

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        <span data-testid="session-label" title={session.detail}
          style={{ fontSize: 11, fontWeight: 700, fontFamily: mono, color: sessionColour }}>
          {session.label}
        </span>
        <div style={{ flex: 1 }} />
        {GEX_TICKERS.map((t) => (
          <button key={t} onClick={() => setSymbol(t)} style={{
            padding: '4px 12px', borderRadius: 5, fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: mono,
            border: `1px solid ${symbol === t ? 'rgba(139,92,246,0.5)' : 'var(--border)'}`,
            background: symbol === t ? 'rgba(139,92,246,0.15)' : 'var(--bg-secondary)',
            color: symbol === t ? '#a78bfa' : 'var(--text-secondary)',
          }}>{t}</button>
        ))}
        <button onClick={() => setTick((n) => n + 1)} style={{
          padding: '4px 12px', borderRadius: 5, fontSize: 12, cursor: 'pointer', fontFamily: mono,
          border: '1px solid var(--border)', background: 'var(--bg-secondary)', color: 'var(--text-secondary)',
        }}>REFRESH</button>
      </div>

      <OvernightPanel panel={overnight} />
      <GexPanel panel={gex} symbol={symbol} />
      <TrackRecordPanel panel={track} />
    </div>
  )
}
