'use client'
import { useEffect, useState, type CSSProperties } from 'react'
import { loadPanel, type Panel as PanelState } from '@/lib/panel'
import type { GEXResponse } from '@/lib/types'
import { ageText, distanceText, etDateTime, gexContext, type OiStrike } from '@/lib/gexContext'

/**
 * One ETF's reference levels from its own delayed Cboe chain, compact, for the
 * desk. Same definitions as the ticket's panel (`lib/gexContext.ts`): max call
 * and put OI strikes, the same-day lens, the modelled net GEX sign, distances
 * from the chain's own spot. Context only — it feeds no gate anywhere.
 */

const MONO = "'JetBrains Mono', monospace"
const ROW: CSSProperties = { display: 'flex', justifyContent: 'space-between', gap: 8, padding: '3px 0', borderTop: '1px solid var(--border)', fontSize: 11 }
const KEY: CSSProperties = { color: 'var(--text-muted)' }
const VAL: CSSProperties = { fontFamily: MONO, color: 'var(--text-primary)', textAlign: 'right' }
const NOTE: CSSProperties = { fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.5 }

const POLL_MS = 60_000

function Strike({ label, level }: { label: string; level: OiStrike | null }) {
  return (
    <div style={ROW}>
      <span style={KEY}>{label}</span>
      <span style={VAL}>
        {level ? <>{level.strike.toLocaleString('en-US')} · OI {level.oi.toLocaleString('en-US')}</> : <span style={KEY}>none</span>}
        {level?.distance && <span style={{ ...KEY, fontSize: 10, display: 'block' }}>{distanceText(level.distance)}</span>}
      </span>
    </div>
  )
}

export function GexMini({ symbol }: { symbol: 'SPY' | 'QQQ' }) {
  const [panel, setPanel] = useState<PanelState<GEXResponse>>({ status: 'loading' })
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    let alive = true
    const load = async () => {
      const p = await loadPanel<GEXResponse>(`/api/gex?symbol=${symbol}`, (b) => b as GEXResponse)
      if (alive) { setPanel(p); setNow(Date.now()) }
    }
    void load()
    const id = setInterval(load, POLL_MS)
    return () => { alive = false; clearInterval(id) }
  }, [symbol])

  const ctx = panel.status === 'ok' ? gexContext(panel.data) : null

  return (
    <div data-testid={`desk-gex-${symbol}`} style={{ minWidth: 0 }}>
      <div style={{ fontFamily: MONO, fontWeight: 700, fontSize: 12, color: 'var(--text-primary)', marginBottom: 4 }}>{symbol}</div>
      {panel.status === 'loading' && <div style={NOTE}>Reading the {symbol} chain…</div>}
      {panel.status === 'unauthorized' && <div style={NOTE}>The backend refused this session for /api/gex.</div>}
      {panel.status === 'unreachable' && <div style={NOTE}>The backend did not answer for /api/gex.</div>}
      {ctx && !ctx.available && <div style={NOTE} data-testid={`desk-gex-${symbol}-empty`}>No chain. {ctx.unavailableReason}</div>}
      {ctx?.available && (
        <>
          <Strike label="Max call OI strike" level={ctx.maxCallOi} />
          <Strike label="Max put OI strike" level={ctx.maxPutOi} />
          <div style={ROW}>
            <span style={KEY}>Same-day (0DTE)</span>
            <span style={VAL}>
              {ctx.zeroDte.status === 'PRESENT'
                ? `${ctx.zeroDte.expiry} · call ${ctx.zeroDte.maxCallOi?.strike ?? '—'} / put ${ctx.zeroDte.maxPutOi?.strike ?? '—'}`
                : ctx.zeroDte.status === 'NONE' ? 'no same-day expiry' : 'not published'}
            </span>
          </div>
          <div style={ROW}>
            <span style={KEY}>Net GEX sign (modelled)</span>
            <span style={VAL}>{ctx.netGex.sign}</span>
          </div>
          <div style={{ ...NOTE, marginTop: 4, fontSize: 10 }} data-testid={`desk-gex-${symbol}-asof`}>
            {ctx.asOfMs !== null
              ? `AS OF ${etDateTime(ctx.asOfMs)} · ${ageText(ctx.asOfMs, now)}`
              : ctx.asOfPublished ? 'AS OF UNKNOWN — the chain carried no time' : "AS OF UNKNOWN — this backend does not publish the chain's as-of"}
            {' · DELAYED '}{ctx.delayedMinutes === null ? '(delay not published)' : `${ctx.delayedMinutes} MIN`}
            {' · '}{ctx.spot === null ? 'spot unknown' : `chain spot ${ctx.spot.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
          </div>
        </>
      )}
    </div>
  )
}
