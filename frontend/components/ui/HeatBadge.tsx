'use client'
import { heatColor, heatBg } from '@/lib/utils'

export function HeatBadge({ score }: { score: number }) {
  return (
    <span
      className="heat-badge"
      style={{ color: heatColor(score), background: heatBg(score), border: `1px solid ${heatColor(score)}40` }}
    >
      {Math.round(score)}
    </span>
  )
}

export function SentimentBadge({ sentiment }: { sentiment: string }) {
  const colors: Record<string, { color: string; bg: string; border: string }> = {
    BULLISH: { color: '#22c55e', bg: 'rgba(34,197,94,0.12)', border: 'rgba(34,197,94,0.3)' },
    BEARISH: { color: '#ef4444', bg: 'rgba(239,68,68,0.12)', border: 'rgba(239,68,68,0.3)' },
    NEUTRAL: { color: '#a1a1aa', bg: 'rgba(161,161,170,0.12)', border: 'rgba(161,161,170,0.2)' },
  }
  const c = colors[sentiment] || colors.NEUTRAL
  return (
    <span style={{
      color: c.color, background: c.bg, border: `1px solid ${c.border}`,
      padding: '2px 8px', borderRadius: 4, fontSize: 11, fontWeight: 600,
      fontFamily: "'Inter', sans-serif", letterSpacing: '0.04em',
    }}>
      {sentiment === 'BULLISH' ? '▲ BULL' : sentiment === 'BEARISH' ? '▼ BEAR' : '— NEUT'}
    </span>
  )
}

export function OrderBadge({ type }: { type: string }) {
  const colors: Record<string, { color: string; bg: string }> = {
    SWEEP: { color: '#a78bfa', bg: 'rgba(139,92,246,0.15)' },
    BLOCK: { color: '#60a5fa', bg: 'rgba(96,165,250,0.15)' },
    SPLIT: { color: '#fbbf24', bg: 'rgba(251,191,36,0.15)' },
  }
  const c = colors[type] || colors.BLOCK
  return (
    <span style={{
      color: c.color, background: c.bg, padding: '2px 7px', borderRadius: 4,
      fontSize: 11, fontWeight: 600, fontFamily: "'JetBrains Mono', monospace",
    }}>
      {type}
    </span>
  )
}

export function PremiumBadge({ value }: { value: number }) {
  const isWhale = value >= 1_000_000
  return (
    <span style={{
      color: isWhale ? '#fbbf24' : '#fafafa',
      fontWeight: isWhale ? 700 : 500,
      fontFamily: "'JetBrains Mono', monospace",
    }}>
      {isWhale ? '🐋 ' : ''}{value >= 1_000_000 ? `$${(value / 1_000_000).toFixed(1)}M` : `$${Math.round(value / 1000)}K`}
    </span>
  )
}
