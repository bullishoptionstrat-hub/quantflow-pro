'use client'
import { FlowFeed } from '@/components/flow/FlowFeed'
import { UnusualActivity } from '@/components/flow/UnusualActivity'

export default function FlowPage() {
  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        <h1 style={{ fontSize: 18, fontWeight: 700, color: '#fafafa', marginBottom: 4 }}>⚡ Live Options Flow</h1>
        <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>Real-time institutional options order flow · SWEEP/BLOCK/SPLIT classification · Heat Score analysis</p>
      </div>
      <UnusualActivity />
      <FlowFeed />
    </div>
  )
}
