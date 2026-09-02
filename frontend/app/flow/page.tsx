'use client'
import { FlowFeed } from '@/components/flow/FlowFeed'
import { UnusualActivity } from '@/components/flow/UnusualActivity'
import { DemoModeBanner } from '@/components/ui/ProvenanceBadge'
import { useDataMode } from '@/hooks/useDataMode'

export default function FlowPage() {
  const { dataMode } = useDataMode()
  const isDemo = dataMode === 'demo'

  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        {/* Copy must match provenance: never call demo or delayed data "live". */}
        <h1 style={{ fontSize: 18, fontWeight: 700, color: '#fafafa', marginBottom: 4 }}>
          {isDemo ? '⚡ Options Flow (Demo Data)' : '⚡ Options Flow'}
        </h1>
        <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          {isDemo
            ? 'Generated sample flow · SWEEP/BLOCK/SPLIT classification · Heat Score analysis'
            : 'Institutional options order flow · SWEEP/BLOCK/SPLIT classification · Heat Score analysis'}
        </p>
      </div>
      <DemoModeBanner dataMode={dataMode} />
      <UnusualActivity />
      <FlowFeed />
    </div>
  )
}
