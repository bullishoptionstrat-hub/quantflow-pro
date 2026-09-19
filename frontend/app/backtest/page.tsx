'use client'
import { Backtest } from '@/components/backtest/Backtest'

export default function BacktestPage() {
  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        <h1 style={{ fontSize: 18, fontWeight: 700, color: '#fafafa', marginBottom: 4 }}>⏮ Scanner Backtest</h1>
        <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          How the signals a filter selected actually performed · graded once, read back honestly · save a scanner to reuse it
        </p>
      </div>
      <Backtest />
    </div>
  )
}
