'use client'
import { FlowFeed } from '@/components/flow/FlowFeed'
import { UnusualActivity } from '@/components/flow/UnusualActivity'

export default function FlowPage() {
  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        {/* This read "Live Options Flow" over "Real-time institutional options
            order flow". The tape is whatever the backend sends — on a keyless
            deployment, simulated prints — so neither word was the page's to
            say. Each row carries its own SYN marker and the strip above says
            whether the feed is connected; the title names the subject only. */}
        <h1 style={{ fontSize: 18, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 4 }}>⚡ Options Flow</h1>
        <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>Signals as the backend&apos;s flow engine classifies them · SWEEP / BLOCK / SPLIT / MULTI-LEG · deterministic heat score · rows marked SYN were constructed, not observed</p>
      </div>
      <UnusualActivity />
      <FlowFeed />
    </div>
  )
}
