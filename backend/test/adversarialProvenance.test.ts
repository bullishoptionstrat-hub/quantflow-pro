/**
 * REGRESSION SUITE — Wave 1 adversarial pass, made permanent.
 *
 * Each case is an attack that a synthetic record could use to reach a LIVE feed.
 * The "unknown generator" case FOUND A REAL LEAK when first run: a source-name
 * allowlist fails open for every name not yet on it, so a newly added generator
 * was admitted untagged. The fix was to require provenance in live mode.
 * These cases exist so that never regresses.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { rejectEmission, type SyntheticTaggable } from '../src/config/dataMode';
import { badgeFor, syntheticProvenance, upstreamProvenance } from '../src/config/provenance';

const LIVE = { DATA_MODE: 'live' };

function stripped(source: string, ...remove: Array<'is_synthetic' | 'is_demo'>) {
  const p = syntheticProvenance(source);
  for (const k of remove) delete (p as unknown as Record<string, unknown>)[k];
  return p;
}

const ATTACKS: Array<{ name: string; payload: SyntheticTaggable }> = [
  {
    name: 'source spoofing — synthetic payload wearing a real source name',
    payload: { source: 'tradier', provenance: syntheticProvenance('tradier') },
  },
  {
    name: 'flag stripping — envelope present, is_synthetic deleted',
    payload: { source: 'simulation', provenance: stripped('simulation', 'is_synthetic') },
  },
  {
    name: 'both flags stripped on a synthetic source',
    payload: { source: 'seed', provenance: stripped('seed', 'is_synthetic', 'is_demo') },
  },
  {
    name: 'casing evasion on the source name',
    payload: { source: 'SIMULATION', provenance: syntheticProvenance('SIMULATION') },
  },
  {
    name: 'unknown generator name with no tags (the leak this suite was born from)',
    payload: { source: 'some-brand-new-generator' },
  },
  {
    name: 'half-tagged — is_demo without is_synthetic',
    payload: {
      source: 'x',
      provenance: { ...upstreamProvenance({ source: 'x' }), is_demo: true as const },
    },
  },
  {
    name: 'delayed with no delay estimate',
    payload: {
      source: 'polygon',
      provenance: { ...upstreamProvenance({ source: 'polygon' }), is_delayed: true as const },
    },
  },
  {
    name: 'inferred with no method or confidence',
    payload: {
      source: 'polygon',
      provenance: { ...upstreamProvenance({ source: 'polygon' }), is_inferred: true as const },
    },
  },
  {
    name: 'confidence outside 0..1',
    payload: {
      source: 'polygon',
      provenance: {
        ...upstreamProvenance({ source: 'polygon' }),
        is_inferred: true as const, inference_method: 'quote_rule', confidence: 42,
      },
    },
  },
];

describe('adversarial — nothing fabricated reaches a live feed', () => {
  for (const { name, payload } of ATTACKS) {
    it(`holds against: ${name}`, () => {
      const rejection = rejectEmission(payload, LIVE);
      assert.notEqual(rejection, null, `ADMITTED to a live feed: ${name}`);
    });
  }

  it('holds against ALL attacks simultaneously (no ordering dependence)', () => {
    const admitted = ATTACKS.filter((a) => rejectEmission(a.payload, LIVE) === null).map((a) => a.name);
    assert.deepEqual(admitted, []);
  });

  it('a stripped generator envelope still renders as DEMO, never LIVE', () => {
    // Defense in depth: even with both booleans deleted, source_type='generator'
    // disqualifies the record from ever displaying as real market data.
    assert.equal(badgeFor(stripped('seed', 'is_synthetic', 'is_demo')), 'DEMO');
  });
});
