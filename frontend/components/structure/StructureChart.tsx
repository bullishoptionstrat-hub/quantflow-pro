'use client'
import { useMemo, useState } from 'react'
import { chartModel, type ChartEvent } from '@/lib/structureChart'

/**
 * Candles of the imported bars with the structure engine's events drawn over
 * them, at a replay cursor. Every rule about what may be drawn lives in
 * `lib/structureChart.ts`; this component only lays it out. No order, no
 * signal: the chart shows what the engine published and when it knew it.
 */

const MONO = "'JetBrains Mono', monospace"
const W = 900, H = 320, PAD = 8, AXIS = 56
const fmtEt = (ms: number) => new Date(ms).toLocaleString('en-US', { timeZone: 'America/New_York', hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })

export function StructureChart({ bars, events }: { bars: unknown; events: ChartEvent[] }) {
  const closes = useMemo(() => chartModel(bars, events, null), [bars, events])
  const [cursorIdx, setCursorIdx] = useState<number | null>(null)
  const idx = cursorIdx ?? closes.bars.length - 1
  const cursor = closes.bars[idx]?.closedAt ?? null
  const m = useMemo(() => chartModel(bars, events, cursor), [bars, events, cursor])

  if (closes.bars.length === 0) {
    return <p role="note" style={{ fontSize: 12 }}>No drawable bar in this report{closes.unreadableBars > 0 ? ` (${closes.unreadableBars} bars did not form a candle)` : ''}.</p>
  }
  const n = closes.bars.length
  const prices = m.bars.flatMap((b) => [b.h, b.l]).concat(m.overlays.flatMap((o) => (o.type === 'BOX' ? [o.top, o.bottom] : [o.price])))
  const hi = Math.max(...prices), lo = Math.min(...prices)
  const span = hi - lo || 1
  const cw = (W - AXIS - PAD) / n
  const X = (i: number) => PAD + i * cw + cw / 2
  const Y = (p: number) => PAD + ((hi - p) / span) * (H - 2 * PAD)

  return (
    <figure style={{ margin: 0 }}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Candles to ${cursor !== null ? fmtEt(cursor) : ''} ET with ${m.overlays.length} structure marks`} style={{ width: '100%', height: 'auto', background: 'var(--bg-surface, transparent)' }}>
        {m.overlays.filter((o) => o.type === 'BOX').map((o) => o.type === 'BOX' && (
          <rect key={o.id} data-overlay="BOX" x={X(o.x) - cw / 2} width={Math.max(cw, (o.xEnd - o.x + 1) * cw)} y={Y(o.top)} height={Math.max(1, Y(o.bottom) - Y(o.top))}
            fill={o.label === 'FVG+' ? 'rgba(34,197,94,0.15)' : 'rgba(239,68,68,0.15)'} stroke={o.open ? 'var(--accent, #22d3ee)' : 'none'} strokeDasharray="3 2" />
        ))}
        {m.bars.map((b, i) => {
          const up = b.c >= b.o
          const col = up ? 'var(--green, #22c55e)' : 'var(--red, #ef4444)'
          return (
            <g key={b.closedAt} data-bar={b.closedAt}>
              <line x1={X(i)} x2={X(i)} y1={Y(b.h)} y2={Y(b.l)} stroke={col} strokeWidth={1} />
              <rect x={X(i) - Math.max(0.5, cw * 0.35)} width={Math.max(1, cw * 0.7)} y={Y(Math.max(b.o, b.c))} height={Math.max(0.8, Math.abs(Y(b.o) - Y(b.c)))} fill={col} />
            </g>
          )
        })}
        {m.overlays.map((o) => {
          if (o.type === 'LEVEL') return <g key={o.id} data-overlay="LEVEL"><line x1={X(o.x)} x2={W - AXIS} y1={Y(o.price)} y2={Y(o.price)} stroke="#f59e0b" strokeDasharray="4 3" /><text x={W - AXIS + 2} y={Y(o.price) + 3} fontSize={9} fill="#f59e0b" fontFamily={MONO}>{o.label}</text></g>
          if (o.type === 'MARK') return <g key={o.id} data-overlay="MARK" data-kind={o.kind}><circle cx={X(o.x)} cy={Y(o.price)} r={2.5} fill="#a78bfa" /><text x={X(o.x) + 3} y={Y(o.price) - 3} fontSize={8} fill="#c4b5fd" fontFamily={MONO}>{o.label}</text></g>
          return null
        })}
        <text x={W - AXIS + 2} y={PAD + 8} fontSize={9} fill="var(--text-muted, #94a3b8)" fontFamily={MONO}>{hi.toFixed(2)}</text>
        <text x={W - AXIS + 2} y={H - PAD} fontSize={9} fill="var(--text-muted, #94a3b8)" fontFamily={MONO}>{lo.toFixed(2)}</text>
      </svg>
      <label style={{ display: 'block', fontSize: 12, marginTop: 6 }}>
        Replay to close{' '}
        <input type="range" aria-label="Replay cursor" min={0} max={n - 1} value={idx} onChange={(e) => setCursorIdx(Number(e.target.value))} style={{ width: '60%', verticalAlign: 'middle' }} />
        {' '}<span style={{ fontFamily: MONO }}>{cursor !== null ? `${fmtEt(cursor)} ET` : ''}</span>
      </label>
      <figcaption style={{ fontSize: 11, color: 'var(--text-muted)' }}>
        Closed bars only. Each mark appears at the bar that closed when the engine knew it (swings at their confirming bar, not their pivot). {m.bars.length} of {n} bars · {m.overlays.length} marks
        {closes.unreadableBars > 0 ? ` · ${closes.unreadableBars} bars not drawn (not a candle)` : ''}{m.unplacedEvents > 0 ? ` · ${m.unplacedEvents} events not placed (no bar closed at their knownAt)` : ''}. Swings, FVGs, BOS/CHoCH, sweeps and session levels are drawn; other kinds are in the table.
      </figcaption>
    </figure>
  )
}
