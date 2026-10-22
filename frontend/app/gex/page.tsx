'use client'
import { GEXChart } from '@/components/gex/GEXChart'
import { TermStructure } from '@/components/gex/TermStructure'

export default function GEXPage() {
  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        <h1 style={{ fontSize: 18, fontWeight: 700, color: '#fafafa', marginBottom: 4 }}>Γ GEX Levels</h1>
        <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>Dealer gamma exposure (modelled) · largest exposures by strike · ATM IV term structure</p>
      </div>
      <GEXChart />
      <TermStructure />
    </div>
  )
}
