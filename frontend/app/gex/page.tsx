'use client'
import { GEXChart } from '@/components/gex/GEXChart'

export default function GEXPage() {
  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        <h1 style={{ fontSize: 18, fontWeight: 700, color: '#fafafa', marginBottom: 4 }}>Γ GEX Levels</h1>
        {/* This promised "Dealer Gamma Exposure · Support & Resistance · Gamma
            Flip Point". The dealer book is an assumption (the backend states it
            on the payload), no level here is tested as support or resistance,
            and the backend publishes no flip today. */}
        <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>Gamma exposure by strike, modelled from a delayed options chain · calls counted positive and puts negative, an assumption about the dealer book that open interest cannot show · a flip is drawn only if the backend publishes one</p>
      </div>
      <GEXChart />
    </div>
  )
}
