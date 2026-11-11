'use client'
import { useEffect, useState, type CSSProperties } from 'react'
import { Panel } from '@/components/hud/Panel'
import { loadPanel, type Panel as PanelState } from '@/lib/panel'
import type { GEXResponse } from '@/lib/types'
import {
  ageText, distanceText, etDateTime, gexChainFor, gexContext,
  type GexContext, type OiStrike,
} from '@/lib/gexContext'

/**
 * Reference levels from the instrument's own delayed Cboe chain, beside the
 * ticket and never inside it.
 *
 * Nothing here is coloured as a pass or a fail and nothing here reaches
 * `evaluateTicket`: a level near the entry is something to look at, not an
 * answer to a gate. The provenance line — source, the backend's published
 * delay, the chain's own as-of in ET and its age, and the rights class — is
 * always drawn with the numbers, and when the as-of is unknown it says so.
 */

const MONO = "'JetBrains Mono', monospace"
const ROW: CSSProperties = { display: 'flex', gap: 10, padding: '6px 0', borderTop: '1px solid var(--border)', fontSize: 12, flexWrap: 'wrap' }
const NAME: CSSProperties = { minWidth: 230, color: 'var(--text-secondary)' }
const VALUE: CSSProperties = { fontFamily: MONO, color: 'var(--text-primary)' }
const NOTE: CSSProperties = { fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.6 }

/** How often the chain is re-read. The backend refreshes a symbol every ~2 min. */
const POLL_MS = 60_000

function Level({ name, level, empty }: { name: string; level: OiStrike | null; empty: string }) {
  return (
    <div style={ROW} data-testid="gex-level">
      <span style={NAME}>{name}</span>
      {level ? (
        <span style={VALUE}>
          {level.strike.toLocaleString('en-US')} · OI {level.oi.toLocaleString('en-US')}
          <span style={{ color: 'var(--text-muted)' }}>
            {' · '}{level.distance ? distanceText(level.distance) : 'distance not computed: the chain carried no spot'}
          </span>
        </span>
      ) : (
        <span style={{ ...VALUE, color: 'var(--text-muted)' }}>{empty}</span>
      )}
    </div>
  )
}

function Provenance({ ctx, now }: { ctx: GexContext; now: number }) {
  return (
    <div data-testid="gex-provenance" style={{ ...NOTE, marginTop: 10 }}>
      Source {String(ctx.source ?? '—').toUpperCase()} · DELAYED{' '}
      {ctx.delayedMinutes === null ? '(delay not published)' : `${ctx.delayedMinutes} MIN (as the backend publishes)`}
      {' · '}
      {ctx.asOfMs === null
        ? 'as of unknown — the chain carried no readable time'
        : `as of ${etDateTime(ctx.asOfMs)}, ${ageText(ctx.asOfMs, now)} on this browser's clock`}
      {' · '}
      {ctx.spot === null
        ? 'spot unknown'
        : `spot ${ctx.spot.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} (the chain's own ${ctx.spotField ?? 'price'}, not a live quote)`}
      {' · '}
      {ctx.rights
        ? `rights DISPLAY ${ctx.rights.display} (${ctx.rights.datasetId}, ${ctx.rights.mode})`
        : 'rights class not published by this backend'}
    </div>
  )
}

function ChainBody({ ctx, now }: { ctx: GexContext; now: number }) {
  if (!ctx.available) {
    return (
      <div data-testid="gex-empty" style={NOTE}>
        No chain to read for {ctx.symbol}. {ctx.unavailableReason}
      </div>
    )
  }
  const z = ctx.zeroDte
  return (
    <>
      <Level name="Max call OI strike (all expiries)" level={ctx.maxCallOi} empty="no call open interest in this chain" />
      <Level name="Max put OI strike (all expiries)" level={ctx.maxPutOi} empty="no put open interest in this chain" />
      {z.status === 'PRESENT' ? (
        <>
          <Level name={`Same-day (0DTE) max call OI strike · ${z.expiry}`} level={z.maxCallOi} empty="no same-day call open interest" />
          <Level name={`Same-day (0DTE) max put OI strike · ${z.expiry}`} level={z.maxPutOi} empty="no same-day put open interest" />
        </>
      ) : (
        <div style={ROW} data-testid="gex-zero-dte">
          <span style={NAME}>Same-day (0DTE)</span>
          <span style={{ ...VALUE, color: 'var(--text-muted)' }}>
            {z.status === 'NONE' ? 'no same-day expiry in this chain' : 'not published by this backend'}
          </span>
        </div>
      )}
      <div style={ROW} data-testid="gex-sign">
        <span style={NAME}>Net GEX sign (modelled)</span>
        <span style={VALUE}>
          {ctx.netGex.sign}
          <span style={{ color: 'var(--text-muted)' }}>
            {' · '}a sign under a stated assumption, not a regime fact
          </span>
        </span>
      </div>
      <Provenance ctx={ctx} now={now} />
      <div style={{ ...NOTE, marginTop: 6 }}>
        MODELLED: {ctx.assumption ?? 'GEX assumes a dealer position that open interest does not show.'} Open
        interest here counts only contracts that carried a non-zero gamma. Equal open interest goes to the strike
        nearest spot, then the lower strike.
      </div>
    </>
  )
}

export function GexContextPanel({ symbol }: { symbol: string }) {
  const choice = gexChainFor(symbol)
  const chain = choice.kind === 'CHAIN' ? choice.chain : null
  const [panel, setPanel] = useState<PanelState<GEXResponse>>({ status: 'loading' })
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (chain === null) return
    let alive = true
    setPanel({ status: 'loading' })
    const load = async () => {
      const p = await loadPanel<GEXResponse>(`/api/gex?symbol=${chain}`, (b) => b as GEXResponse)
      if (alive) {
        setPanel(p)
        setNow(Date.now())
      }
    }
    void load()
    const id = setInterval(load, POLL_MS)
    return () => {
      alive = false
      clearInterval(id)
    }
  }, [chain])

  const ctx = chain !== null && panel.status === 'ok' ? gexContext(panel.data) : null

  return (
    <Panel
      title="GEX reference levels"
      code="CBOE · DELAYED · MODELLED"
      data-testid="gex-panel"
      asOf={ctx?.available ? (
        <span style={{ fontFamily: MONO, fontSize: 10, color: 'var(--text-muted)' }}>
          {ctx.asOfMs === null ? 'AS OF UNKNOWN' : `AS OF ${etDateTime(ctx.asOfMs)}`}
        </span>
      ) : undefined}
    >
      <div style={{ ...NOTE, marginBottom: 6 }}>
        Context only. These levels never answer, tighten or loosen a gate, and the verdict above is the same with or
        without them.
      </div>
      {choice.kind === 'NONE' && <div style={NOTE}>Choose an instrument to see levels from its own chain.</div>}
      {choice.kind === 'NOT_APPLICABLE' && <div style={NOTE}>Not applicable. {choice.reason}</div>}
      {choice.kind === 'UNMEASURABLE' && (
        <div data-testid="gex-unmeasurable" style={{ ...NOTE, color: 'var(--text-secondary)' }}>
          <strong style={{ fontFamily: MONO }}>UNMEASURABLE</strong> — {symbol} has no chain of its own here.{' '}
          {choice.reason}
        </div>
      )}
      {chain !== null && panel.status === 'loading' && <div style={NOTE}>Reading the {chain} chain…</div>}
      {chain !== null && panel.status === 'unauthorized' && (
        <div style={NOTE}>The backend refused this session for /api/gex, so no levels are shown.</div>
      )}
      {chain !== null && panel.status === 'unreachable' && (
        <div style={NOTE}>The backend did not answer for /api/gex, so no levels are shown.</div>
      )}
      {ctx && <ChainBody ctx={ctx} now={now} />}
    </Panel>
  )
}
