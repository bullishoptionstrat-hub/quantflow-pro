'use client'
import { SetupReplay } from '@/components/setups/SetupReplay'

export default function SetupsPage() {
  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        <h1 style={{ fontSize: 18, fontWeight: 700, color: '#fafafa', marginBottom: 4 }}>⟲ Setup Replay</h1>
        <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          Your imported 1-minute bars through the versioned setup engine · signal events only · not evidence of an edge
        </p>
      </div>
      <SetupReplay />
    </div>
  )
}
