import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { DemoModeBanner, ProvenanceBadge } from './ProvenanceBadge'
import type { Provenance } from '@/lib/provenance'

const upstream: Provenance = {
  source: 'tradier', raw_or_derived: 'raw',
  received_at: new Date().toISOString(), schema_version: 2,
}

describe('ProvenanceBadge', () => {
  it('renders DEMO for a synthetic record', () => {
    render(<ProvenanceBadge carrier={{ provenance: { ...upstream, is_synthetic: true, is_demo: true } }} />)
    expect(screen.getByTestId('provenance-badge')).toHaveAttribute('data-badge', 'DEMO')
    expect(screen.getByTestId('provenance-badge').textContent).toContain('DEMO')
  })

  it('renders DEMO when provenance is missing entirely', () => {
    render(<ProvenanceBadge carrier={undefined} />)
    expect(screen.getByTestId('provenance-badge')).toHaveAttribute('data-badge', 'DEMO')
  })

  it('renders DELAYED with the actual lag, never the word live', () => {
    render(
      <ProvenanceBadge
        carrier={{ provenance: { ...upstream, is_delayed: true, estimated_delay_seconds: 900 } }}
      />,
    )
    const el = screen.getByTestId('provenance-badge')
    expect(el).toHaveAttribute('data-badge', 'DELAYED')
    expect(el.textContent).toContain('delayed ~15m')
    expect(el.textContent?.toLowerCase()).not.toContain('live')
  })

  it('renders LIVE only for genuine realtime upstream data', () => {
    render(<ProvenanceBadge carrier={{ provenance: upstream }} />)
    expect(screen.getByTestId('provenance-badge')).toHaveAttribute('data-badge', 'LIVE')
  })

  it('carries an explanatory title so the badge is self-describing', () => {
    render(<ProvenanceBadge carrier={{ provenance: { ...upstream, is_synthetic: true, is_demo: true } }} />)
    expect(screen.getByTestId('provenance-badge').getAttribute('title')).toMatch(/not real market activity/i)
  })
})

describe('DemoModeBanner', () => {
  it('shows a loud warning in demo mode', () => {
    render(<DemoModeBanner dataMode="demo" />)
    const banner = screen.getByTestId('demo-mode-banner')
    expect(banner.textContent).toContain('DEMO MODE')
    expect(banner.textContent).toMatch(/not real market activity/i)
  })

  it('renders nothing in live mode', () => {
    const { container } = render(<DemoModeBanner dataMode="live" />)
    expect(container.firstChild).toBeNull()
  })

  it('renders nothing when the mode is unknown (no false reassurance either way)', () => {
    const { container } = render(<DemoModeBanner dataMode={undefined} />)
    expect(container.firstChild).toBeNull()
  })
})
