'use client'
import { StrategyBuilder } from '@/components/calculator/StrategyBuilder'

export default function CalculatorPage() {
  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        <h1 style={{ fontSize: 18, fontWeight: 700, color: '#fafafa', marginBottom: 4 }}>🧮 Options P/L Calculator</h1>
        <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>Black-Scholes pricing · Multi-leg strategy builder · Greeks panel · P/L at expiry curve</p>
      </div>
      <StrategyBuilder />
    </div>
  )
}
