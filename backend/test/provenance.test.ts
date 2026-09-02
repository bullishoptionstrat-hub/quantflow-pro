import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  badgeFor,
  provenanceLogLine,
  syntheticProvenance,
  upstreamProvenance,
  validateProvenance,
  type Provenance,
} from '../src/config/provenance';

const realBase: Provenance = upstreamProvenance({ source: 'tradier' });

describe('validateProvenance — malformed envelopes are rejected', () => {
  it('requires provenance to exist at all', () => {
    assert.deepEqual(validateProvenance(undefined), ['missing_provenance']);
  });

  it('rejects is_delayed without an estimated delay', () => {
    const p: Provenance = { ...realBase, is_delayed: true };
    assert.ok(validateProvenance(p).includes('delayed_without_delay_estimate'));
  });

  it('accepts is_delayed WITH an estimate', () => {
    const p: Provenance = { ...realBase, is_delayed: true, estimated_delay_seconds: 900 };
    assert.deepEqual(validateProvenance(p), []);
  });

  it('rejects an inference with no method and no confidence', () => {
    const violations = validateProvenance({ ...realBase, is_inferred: true });
    assert.ok(violations.includes('inferred_without_method'));
    assert.ok(violations.includes('inferred_without_confidence'));
  });

  it('rejects confidence outside 0..1', () => {
    const p: Provenance = {
      ...realBase, is_inferred: true, inference_method: 'quote_rule', confidence: 1.5,
    };
    assert.ok(validateProvenance(p).includes('confidence_out_of_range'));
  });

  it('requires is_synthetic and is_demo to travel together', () => {
    assert.ok(
      validateProvenance({ ...realBase, is_synthetic: true }).includes('synthetic_without_demo_flag'),
    );
    assert.ok(
      validateProvenance({ ...realBase, is_demo: true }).includes('demo_flag_without_synthetic'),
    );
  });

  it('reports every violation at once, not just the first', () => {
    const v = validateProvenance({ ...realBase, is_delayed: true, is_inferred: true });
    assert.ok(v.length >= 3, `expected multiple violations, got ${JSON.stringify(v)}`);
  });
});

describe('syntheticProvenance — the only sanctioned generator envelope', () => {
  it('always sets BOTH is_synthetic and is_demo, and validates', () => {
    const p = syntheticProvenance('simulation');
    assert.equal(p.is_synthetic, true);
    assert.equal(p.is_demo, true);
    assert.equal(p.raw_or_derived, 'derived');
    assert.equal(p.source_type, 'generator');
    assert.deepEqual(validateProvenance(p), []);
  });

  it('never claims a provider or exchange timestamp it does not have', () => {
    const p = syntheticProvenance('seed');
    assert.equal(p.provider_timestamp, null);
    assert.equal(p.exchange_timestamp, null);
  });
});

describe('upstreamProvenance', () => {
  it('is neither synthetic nor demo', () => {
    const p = upstreamProvenance({ source: 'polygon' });
    assert.equal(p.is_synthetic, undefined);
    assert.equal(p.is_demo, undefined);
    assert.equal(p.raw_or_derived, 'raw');
    assert.deepEqual(validateProvenance(p), []);
  });

  it('carries a delay estimate when the feed is delayed', () => {
    const p = upstreamProvenance({
      source: 'polygon', is_delayed: true, estimated_delay_seconds: 900,
    });
    assert.equal(p.is_delayed, true);
    assert.equal(p.estimated_delay_seconds, 900);
    assert.deepEqual(validateProvenance(p), []);
  });
});

describe('badgeFor — most trust-reducing fact wins', () => {
  it('DEMO for synthetic, even when also delayed', () => {
    assert.equal(
      badgeFor({ ...syntheticProvenance('seed'), is_delayed: true, estimated_delay_seconds: 60 }),
      'DEMO',
    );
  });

  it('DELAYED beats INFERRED', () => {
    const p: Provenance = {
      ...realBase,
      is_delayed: true, estimated_delay_seconds: 900,
      is_inferred: true, inference_method: 'quote_rule', confidence: 0.8,
    };
    assert.equal(badgeFor(p), 'DELAYED');
  });

  it('INFERRED when only inferred', () => {
    assert.equal(
      badgeFor({ ...realBase, is_inferred: true, inference_method: 'quote_rule', confidence: 0.9 }),
      'INFERRED',
    );
  });

  it('LIVE only for raw, undelayed, uninferred upstream data', () => {
    assert.equal(badgeFor(realBase), 'LIVE');
  });

  it('missing provenance is treated as DEMO, never LIVE', () => {
    // Absence of evidence must not read as evidence of liveness.
    assert.equal(badgeFor(undefined), 'DEMO');
  });
});

describe('provenanceLogLine', () => {
  it('states the badge and the synthetic flags', () => {
    const line = provenanceLogLine(syntheticProvenance('simulation'));
    assert.match(line, /badge=DEMO/);
    assert.match(line, /is_synthetic=true/);
    assert.match(line, /is_demo=true/);
  });

  it('marks missing provenance explicitly rather than printing nothing', () => {
    assert.equal(provenanceLogLine(undefined), 'provenance=MISSING');
  });
});
