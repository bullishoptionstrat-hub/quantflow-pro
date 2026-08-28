import { describe, expect, it } from 'vitest'
import { badgeFor, delayLabel, isSynthetic, type Provenance } from './provenance'
import { clientDataMode, generateSeedFlow, syntheticAllowed } from './utils'

const upstream: Provenance = {
  source: 'tradier',
  raw_or_derived: 'raw',
  received_at: new Date().toISOString(),
  schema_version: 2,
}

describe('badgeFor', () => {
  it('treats missing provenance as DEMO, never LIVE', () => {
    // The critical default: an un-migrated or malformed record must degrade to
    // the lowest-trust badge, not silently render as real market data.
    expect(badgeFor(undefined)).toBe('DEMO')
    expect(badgeFor(null)).toBe('DEMO')
    expect(badgeFor({})).toBe('DEMO')
    expect(badgeFor({ source: 'tradier' })).toBe('DEMO')
  })

  it('honors the deprecated flat alias during migration', () => {
    expect(badgeFor({ synthetic: true, provenance: upstream })).toBe('DEMO')
  })

  it('DEMO wins over DELAYED and INFERRED', () => {
    expect(
      badgeFor({
        provenance: {
          ...upstream,
          is_synthetic: true, is_demo: true,
          is_delayed: true, estimated_delay_seconds: 900,
          is_inferred: true, inference_method: 'quote_rule', confidence: 0.9,
        },
      }),
    ).toBe('DEMO')
  })

  it('DELAYED wins over INFERRED', () => {
    expect(
      badgeFor({
        provenance: {
          ...upstream,
          is_delayed: true, estimated_delay_seconds: 900,
          is_inferred: true, inference_method: 'quote_rule', confidence: 0.9,
        },
      }),
    ).toBe('DELAYED')
  })

  it('LIVE only for raw, undelayed, uninferred upstream data', () => {
    expect(badgeFor({ provenance: upstream })).toBe('LIVE')
  })
})

describe('isSynthetic', () => {
  it('is true for anything that renders as DEMO', () => {
    expect(isSynthetic(undefined)).toBe(true)
    expect(isSynthetic({ provenance: { ...upstream, is_synthetic: true, is_demo: true } })).toBe(true)
    expect(isSynthetic({ provenance: upstream })).toBe(false)
  })
})

describe('delayLabel — delayed data is never called live', () => {
  it('returns null for undelayed data', () => {
    expect(delayLabel(upstream)).toBeNull()
  })

  it('states the lag in human units', () => {
    expect(delayLabel({ ...upstream, is_delayed: true, estimated_delay_seconds: 900 })).toBe('delayed ~15m')
    expect(delayLabel({ ...upstream, is_delayed: true, estimated_delay_seconds: 7200 })).toBe('delayed ~2h')
    expect(delayLabel({ ...upstream, is_delayed: true, estimated_delay_seconds: 30 })).toBe('delayed ~30s')
  })

  it('admits an unknown lag rather than implying none', () => {
    expect(delayLabel({ ...upstream, is_delayed: true })).toBe('delayed (unknown lag)')
  })
})

describe('client generator gating', () => {
  it('defaults to demo mode, never live', () => {
    // process.env.NEXT_PUBLIC_DATA_MODE is unset in this environment.
    expect(clientDataMode()).toBe('demo')
    expect(syntheticAllowed()).toBe(true)
  })

  it('EVERY generated event carries is_synthetic + is_demo', () => {
    const events = generateSeedFlow(25)
    expect(events).toHaveLength(25)
    for (const e of events) {
      expect(e.provenance?.is_synthetic).toBe(true)
      expect(e.provenance?.is_demo).toBe(true)
      expect(e.provenance?.raw_or_derived).toBe('derived')
      // and therefore can only ever render as DEMO
      expect(badgeFor(e)).toBe('DEMO')
    }
  })

  it('generated events never claim a provider or exchange timestamp', () => {
    for (const e of generateSeedFlow(10)) {
      expect(e.provenance?.provider_timestamp).toBeNull()
      expect(e.provenance?.exchange_timestamp).toBeNull()
    }
  })
})
