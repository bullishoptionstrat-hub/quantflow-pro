'use client'
import { MorningView } from '@/components/morning/MorningView'

export default function MorningPage() {
  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        <h1 style={{ fontSize: 18, fontWeight: 700, color: '#fafafa', marginBottom: 4 }}>☀ Morning</h1>
        <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          Overnight flow · today&apos;s GEX profile · the gamma flip · the track record to date
        </p>
      </div>
      <MorningView />
    </div>
  )
}
