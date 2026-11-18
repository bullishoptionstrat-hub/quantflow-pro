'use client'
import { StructureReplay } from '@/components/structure/StructureReplay'

export default function StructurePage() {
  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        <h1 style={{ fontSize: 18, fontWeight: 700, color: '#fafafa', marginBottom: 4 }}>⌗ Structure Map</h1>
        <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          Your imported 1-minute bars through the versioned structure engine · each event with the close it became knowable at · not signals
        </p>
      </div>
      <StructureReplay />
    </div>
  )
}
