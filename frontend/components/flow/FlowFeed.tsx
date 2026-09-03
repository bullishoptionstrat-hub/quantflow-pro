'use client'
import { useRef, useState, useCallback } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useStore } from '@/store/useStore'
import { useFlowFeed } from '@/hooks/useFlowFeed'
import { HeatBadge, SentimentBadge, OrderBadge, PremiumBadge } from '@/components/ui/HeatBadge'
import { FlowFilters } from './FlowFilters'
import { FlowStats } from './FlowStats'
import { TableSkeleton } from '@/components/ui/Skeleton'
import { formatTime, formatExpiry } from '@/lib/utils'
import { matchesFilters } from '@/lib/flowFilter'
import type { FlowEvent } from '@/lib/types'

const COL_HEADERS = [
  { key: 'time',      label: 'TIME',      cls: 'col-time' },
  { key: 'ticker',    label: 'SYMBOL',    cls: 'col-symbol' },
  { key: 'exp',       label: 'EXP',       cls: 'col-exp' },
  { key: 'strike',    label: 'STRIKE',    cls: 'col-strike' },
  { key: 'cp',        label: 'C/P',       cls: 'col-cp' },
  { key: 'type',      label: 'TYPE',      cls: 'col-type' },
  { key: 'size',      label: 'SIZE',      cls: 'col-size' },
  { key: 'premium',   label: 'PREMIUM',   cls: 'col-premium' },
  { key: 'heat',      label: 'HEAT',      cls: 'col-heat' },
  { key: 'sentiment', label: 'SENTIMENT', cls: 'col-sent' },
]

function SortHeader({ col, sort, onSort }: { col: string; sort: [string, 'asc'|'desc']; onSort: (k: string) => void }) {
  const active = sort[0] === col
  return (
    <th className={col === 'time' ? 'col-time' : col === 'premium' ? 'col-premium' : col === 'heat' ? 'col-heat' : ''}
      onClick={() => onSort(col)}
      style={{ cursor: 'pointer', userSelect: 'none' }}>
      {COL_HEADERS.find(h => h.key === col)?.label || col}
      {active && <span style={{ marginLeft: 4 }}>{sort[1] === 'asc' ? '↑' : '↓'}</span>}
    </th>
  )
}

export function FlowFeed() {
  useFlowFeed() // subscribes to the socket; nothing is generated locally
  const { flowEvents, filters, connected } = useStore()
  const [sort, setSort] = useState<[string, 'asc'|'desc']>(['time', 'desc'])
  const [chartSymbol, setChartSymbol] = useState<string | null>(null)
  const [isLoading] = useState(false)
  const parentRef = useRef<HTMLDivElement>(null)

  // The only place the filters are applied. They used to be applied here *and*
  // at ingest, and the ingest copy dropped signals before they were stored.
  const filtered = flowEvents.filter(e => matchesFilters(e, filters))

  const sorted = [...filtered].sort((a, b) => {
    const dir = sort[1] === 'asc' ? 1 : -1
    if (sort[0] === 'time') return dir * (new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
    if (sort[0] === 'premium') return dir * (a.total_premium - b.total_premium)
    if (sort[0] === 'heat') return dir * (a.heat_score - b.heat_score)
    if (sort[0] === 'size') return dir * (a.total_size - b.total_size)
    return 0
  })

  const ROW_HEIGHT = 36
  const rowVirtualizer = useVirtualizer({
    count: sorted.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
  })

  const handleSort = useCallback((key: string) => {
    setSort(([k, d]) => k === key ? [k, d === 'asc' ? 'desc' : 'asc'] : [key, 'desc'])
  }, [])

  const csvExport = () => {
    // The export is the filtered view, and the file has to say so — a CSV that
    // is a subset and does not name the subset is a tile labelled TOTAL. The
    // `synthetic` column comes along for the same reason it is shown per row:
    // a credentialed deployment can have observed and constructed prints side
    // by side, and a spreadsheet cannot see the badge.
    const meta = [
      `# quantflow flow export — ${sorted.length} of ${flowEvents.length} signals held this session`,
      `# filters: ticker=${filters.ticker || 'any'} premium>=${filters.minPremium} type=${filters.optionType} order=${filters.orderType} sentiment=${filters.sentiment} heat>=${filters.minHeat}${filters.unusualOnly ? ' unusualOnly' : ''}`,
    ].join('\n') + '\n'
    const header = 'Time,Ticker,Expiry,Strike,Type,Order,Size,Premium,Heat,Sentiment,Synthetic\n'
    const rows = sorted.map(e =>
      [formatTime(e.created_at),e.underlying,e.expiry,e.strike,e.option_type,e.order_type,e.total_size,e.total_premium,e.heat_score,e.sentiment,e.synthetic ? 'yes' : 'no'].join(',')
    ).join('\n')
    const blob = new Blob([meta + header + rows], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `quantflow-flow-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div>
      <FlowStats />
      <div className="card" style={{ overflow: 'hidden' }}>
        <div className="card-header" style={{ padding: '10px 14px' }}>
          <span style={{ fontWeight: 700, fontSize: 13, color: '#fafafa' }}>
            ⚡ LIVE OPTIONS FLOW
            <span style={{ marginLeft: 10, fontSize: 11, color: 'var(--text-muted)', fontFamily: "'JetBrains Mono', monospace" }}>
              {/* Both numbers, because the filters no longer decide what is
                  kept — only what is shown. */}
              {sorted.length === flowEvents.length
                ? `${sorted.length} signals`
                : `${sorted.length} of ${flowEvents.length} signals`}
            </span>
          </span>
          <button onClick={csvExport} style={{
            background: 'rgba(139,92,246,0.1)', border: '1px solid rgba(139,92,246,0.3)',
            color: '#a78bfa', fontSize: 11, padding: '4px 12px', borderRadius: 5, cursor: 'pointer', fontFamily: "'JetBrains Mono', monospace"
          }}>
            ↓ CSV
          </button>
        </div>
        <div style={{ padding: '0 14px 10px' }}>
          <FlowFilters />
        </div>

        {/* Virtual scrolling table */}
        <div ref={parentRef} style={{ height: 520, overflowY: 'auto' }}>
          <table className="flow-table" style={{ tableLayout: 'fixed' }}>
            <thead>
              <tr>
                {COL_HEADERS.map(h => (
                  <th key={h.key} className={h.cls} onClick={() => ['time','premium','heat','size'].includes(h.key) ? handleSort(h.key) : null} style={{ cursor: ['time','premium','heat','size'].includes(h.key) ? 'pointer' : 'default' }}>
                    {h.label}
                    {sort[0] === h.key && <span style={{ marginLeft: 4 }}>{sort[1] === 'asc' ? '↑' : '↓'}</span>}
                  </th>
                ))}
                <th style={{ width: 36 }}></th>
              </tr>
            </thead>
            {isLoading ? (
              <TableSkeleton rows={12} />
            ) : (
              <tbody style={{ position: 'relative', height: `${rowVirtualizer.getTotalSize()}px` }}>
                {rowVirtualizer.getVirtualItems().map(vRow => {
                  const e = sorted[vRow.index]
                  if (!e) return null
                  const isSweep = e.order_type === 'SWEEP'
                  const isHot = e.heat_score >= 75
                  return (
                    <tr
                      key={e.id}
                      className={isSweep ? 'sweep-row' : isHot ? 'unusual-row' : ''}
                      style={{
                        position: 'absolute',
                        top: 0,
                        left: 0,
                        width: '100%',
                        transform: `translateY(${vRow.start}px)`,
                        display: 'table',
                        tableLayout: 'fixed',
                        background: isHot ? 'rgba(251,191,36,0.03)' : undefined,
                      }}
                    >
                      <td className="col-time" style={{ color: 'var(--text-muted)', fontSize: 11 }}>
                        {formatTime(e.created_at)}
                      </td>
                      <td className="col-symbol">
                        <span className="ticker-pill">{e.underlying}</span>
                        {/*
                          `synthetic` is an honesty contract the backend has
                          maintained all along and the terminal never showed.
                          It is set on simulated prints, on replayed history,
                          and on chain-snapshot connectors (marketData, schwab,
                          tastytrade, yahoo) that synthesize a print from
                          aggregate volume — so in a fully credentialed
                          deployment some rows are constructed and some are
                          observed tape, and until now nothing distinguished
                          them. The demo banner is all-or-nothing and cannot:
                          this is per row, which is the case that matters.
                        */}
                        {e.synthetic && (
                          <span
                            title="Constructed from aggregate volume or generated — not an observed print"
                            style={{
                              marginLeft: 5, fontSize: 8, fontWeight: 700, letterSpacing: '0.06em',
                              padding: '1px 4px', borderRadius: 3, verticalAlign: 'middle',
                              fontFamily: "'JetBrains Mono', monospace",
                              background: 'rgba(251,191,36,0.14)', color: '#fde68a',
                            }}
                          >SYN</span>
                        )}
                      </td>
                      <td className="col-exp" style={{ color: 'var(--text-secondary)', fontSize: 11 }}>
                        {formatExpiry(e.expiry)}
                      </td>
                      <td className="col-strike" style={{ fontWeight: 600 }}>
                        ${e.strike}
                      </td>
                      <td className="col-cp" style={{ color: e.option_type === 'C' ? '#22c55e' : '#ef4444', fontWeight: 700 }}>
                        {e.option_type === 'C' ? 'CALL' : 'PUT'}
                      </td>
                      <td className="col-type"><OrderBadge type={e.order_type} /></td>
                      <td className="col-size">{e.total_size.toLocaleString()}</td>
                      <td className="col-premium"><PremiumBadge value={e.total_premium} /></td>
                      <td className="col-heat"><HeatBadge score={e.heat_score} /></td>
                      <td className="col-sent"><SentimentBadge sentiment={e.sentiment} /></td>
                      <td style={{ width: 36, textAlign: 'center' }}>
                        <button
                          onClick={() => setChartSymbol(chartSymbol === e.underlying ? null : e.underlying)}
                          style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 13, padding: '2px 4px' }}
                          title="Open TradingView chart"
                        >
                          📈
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            )}
          </table>

          {/*
            An empty feed used to be impossible: the hook seeded fifty invented
            events on mount and made one more every eight seconds. Now it can
            be empty, and the three reasons are not the same thing — a refused
            socket is a configuration answer, a disconnected one is an outage,
            and a connected-but-quiet one is just a slow tape. Saying "no data"
            for all three sends the reader after the wrong problem.
          */}
          {!isLoading && sorted.length === 0 && (
            <div style={{ padding: '32px 16px', textAlign: 'center', color: 'var(--text-muted)' }}>
              <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>
                {connected
                  ? flowEvents.length === 0 ? 'No flow yet' : 'No flow matches these filters'
                  : 'Not connected to the flow feed'}
              </div>
              <div style={{ fontSize: 11, lineHeight: 1.7, maxWidth: 520, margin: '0 auto' }}>
                {connected
                  ? flowEvents.length === 0
                    ? 'The feed is connected and the tape is quiet. Signals appear here as the engine classifies them.'
                    : `${flowEvents.length} signal(s) received; none pass the current filters.`
                  : 'Either the backend is unreachable, or it refused the socket — the feed needs a signed-in session, or a deployment with DEMO_MODE=1. The browser console carries which. Nothing is shown in the meantime; this panel used to fill itself with generated prints.'}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* TradingView chart modal */}
      {chartSymbol && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.8)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={() => setChartSymbol(null)}>
          <div style={{ width: '80vw', height: '70vh', background: 'var(--bg-card)', borderRadius: 10, border: '1px solid var(--border-light)', overflow: 'hidden', position: 'relative' }} onClick={e => e.stopPropagation()}>
            <div style={{ position: 'absolute', top: 10, right: 14, zIndex: 10 }}>
              <button onClick={() => setChartSymbol(null)} style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', color: 'var(--text-primary)', padding: '4px 12px', borderRadius: 5, cursor: 'pointer', fontFamily: "'JetBrains Mono', monospace", fontSize: 12 }}>
                ✕ Close
              </button>
            </div>
            <iframe
              src={`https://www.tradingview.com/widgetembed/?frameElementId=tv_chart&symbol=${chartSymbol === 'SPX' ? 'SP:SPX' : `NASDAQ:${chartSymbol}`}&interval=5&theme=dark&style=1&locale=en&toolbar_bg=%2309090b&enable_publishing=false&hide_side_toolbar=0&allow_symbol_change=1&hidevolume=1`}
              style={{ width: '100%', height: '100%', border: 'none' }}
              title={`${chartSymbol} Chart`}
              allowFullScreen
            />
          </div>
        </div>
      )}
    </div>
  )
}
