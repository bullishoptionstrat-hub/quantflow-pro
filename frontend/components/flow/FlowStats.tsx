'use client'
import { useStore } from '@/store/useStore'
import { formatPremium } from '@/lib/utils'

export function FlowStats() {
  const { flowEvents } = useStore()
  const calls = flowEvents.filter(e => e.option_type === 'C')
  const puts = flowEvents.filter(e => e.option_type === 'P')
  const sweeps = flowEvents.filter(e => e.order_type === 'SWEEP')
  const callPrem = calls.reduce((s, e) => s + e.total_premium, 0)
  const putPrem = puts.reduce((s, e) => s + e.total_premium, 0)
  const total = callPrem + putPrem
  const pcRatio = callPrem > 0 ? (putPrem / callPrem).toFixed(2) : '—'

  const stats = [
    { label: 'TOTAL PREMIUM', value: formatPremium(total), color: '#fafafa' },
    { label: 'CALL PREMIUM', value: formatPremium(callPrem), color: '#22c55e' },
    { label: 'PUT PREMIUM', value: formatPremium(putPrem), color: '#ef4444' },
    { label: 'P/C RATIO', value: pcRatio, color: Number(pcRatio) > 1 ? '#ef4444' : '#22c55e' },
    { label: 'SWEEPS', value: sweeps.length.toString(), color: '#a78bfa' },
    { label: 'TOTAL TRADES', value: flowEvents.length.toString(), color: '#fbbf24' },
  ]

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 8, marginBottom: 16 }}>
      {stats.map(s => (
        <div key={s.label} className="card" style={{ padding: '12px 14px' }}>
          <div style={{ fontSize: 9, fontWeight: 600, color: 'var(--text-muted)', letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 6, fontFamily: "'Inter', sans-serif" }}>{s.label}</div>
          <div style={{ fontSize: 18, fontWeight: 700, color: s.color, fontFamily: "'JetBrains Mono', monospace" }}>{s.value}</div>
        </div>
      ))}
    </div>
  )
}
