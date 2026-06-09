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
  useFlowFeed() // activate feed + simulator
  const { flowEvents, filters } = useStore()
  const [sort, setSort] = useState<[string, 'asc'|'desc']>(['time', 'desc'])
  const [chartSymbol, setChartSymbol] = useState<string | null>(null)
  const [isLoading] = useState(false)
  const parentRef = useRef<HTMLDivElement>(null)

  const filtered = flowEvents.filter(e => {
    if (filters.ticker && !e.underlying.includes(filters.ticker.toUpperCase())) return false
    if (e.total_premium < filters.minPremium) return false
    if (filters.optionType !== 'ALL' && e.option_type !== filters.optionType) return false
    if (filters.orderType !== 'ALL' && e.order_type !== filters.orderType) return false
    if (filters.sentiment !== 'ALL' && e.sentiment !== filters.sentiment) return false
    if (e.heat_score < filters.minHeat) return false
    if (filters.unusualOnly && !e.is_unusual) return false
    return true
  })

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
    const header = 'Time,Ticker,Expiry,Strike,Type,Order,Size,Premium,Heat,Sentiment\n'
    const rows = sorted.map(e =>
      [formatTime(e.created_at),e.underlying,e.expiry,e.strike,e.option_type,e.order_type,e.total_size,e.total_premium,e.heat_score,e.sentiment].join(',')
    ).join('\n')
    const blob = new Blob([header + rows], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url; a.download = 'quantflow-export.csv'; a.click()
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
              {sorted.length} trades
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
