import { describe, expect, it } from 'vitest'
import { badgeFor, delayLabel, isSynthetic, type Provenance } from './provenance'
import * as utils from './utils'
import { clientDataMode, syntheticAllowed } from './utils'

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

  it('the browser exports no flow generator at all', () => {
    // This used to assert that every event `generateSeedFlow` produced carried
    // is_synthetic + is_demo, so it could only ever render as DEMO. That was
    // the weaker fix: the eight-second caller fed `handleEvent`, which speaks
    // a trade aloud above heat 80 and raises an OS notification above 85, and
    // neither reads provenance. Flagging the output would have left the
    // terminal announcing invented sweeps with a badge on them.
    //
    // The generator is deleted instead, so the assertion is now that it does
    // not exist. Reintroducing one under any of these names fails here.
    for (const name of ['generateSeedFlow', 'generateDarkPool', 'generateGEX']) {
      expect(utils as Record<string, unknown>).not.toHaveProperty(name)
    }
  })
})
