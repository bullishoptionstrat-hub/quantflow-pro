/**
 * WAVE 1 EXIT CRITERIA — executable proof.
 *
 * The prompt requires three things provable by test:
 *   1. no synthetic event can appear without its flags set
 *   2. live mode never emits simulation events
 *   3. the health endpoint returns real per-source staleness
 *
 * These assert against the REAL modules, not reimplementations.
 */
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

const originalDataMode = process.env.DATA_MODE;
process.env.DATA_MODE = 'demo';

import { markSynthetic, rejectEmission } from '../src/config/dataMode';
import { badgeFor, syntheticProvenance, validateProvenance } from '../src/config/provenance';
import {
  __resetSourceHealth,
  getSourceHealth,
  recordDisabled,
  recordEvent,
  registerSource,
} from '../src/ingestion/sourceHealth';
import { upstreamProvenance } from '../src/config/provenance';

after(() => {
  if (originalDataMode === undefined) delete process.env.DATA_MODE;
  else process.env.DATA_MODE = originalDataMode;
});

const LIVE = { DATA_MODE: 'live' };
const DEMO = { DATA_MODE: 'demo' };

describe('EXIT 1 — no synthetic event can appear without its flags set', () => {
  it('markSynthetic always produces BOTH is_synthetic and is_demo', () => {
    for (const source of ['simulation', 'seed', 'mock', 'synthetic', 'anything-new']) {
      const tagged = markSynthetic({ id: 'x', source });
      assert.equal(tagged.synthetic, true, `${source}: deprecated alias missing`);
      assert.equal(tagged.provenance.is_synthetic, true, `${source}: is_synthetic missing`);
      assert.equal(tagged.provenance.is_demo, true, `${source}: is_demo missing`);
      assert.deepEqual(validateProvenance(tagged.provenance), [], `${source}: envelope invalid`);
      assert.equal(badgeFor(tagged.provenance), 'DEMO', `${source}: must render DEMO`);
    }
  });

  it('an untagged record from a synthetic source is refused in BOTH modes', () => {
    for (const env of [DEMO, LIVE]) {
      for (const source of ['simulation', 'seed', 'mock', 'synthetic']) {
        assert.notEqual(
          rejectEmission({ source }, env),
          null,
          `untagged ${source} slipped through in ${env.DATA_MODE}`,
        );
      }
    }
  });

  it('a HALF-tagged record (flat alias only, no envelope) is still caught as synthetic', () => {
    // Guards the migration window: a producer updated for one scheme but not the
    // other must still fail closed rather than be treated as real.
    assert.equal(rejectEmission({ source: 'simulation', synthetic: true }, LIVE), 'synthetic_in_live_mode');
  });

  it('a record whose envelope says synthetic but source looks real is still caught', () => {
    // This is the finnhub case (audit #4): synthetic data wearing a real source name.
    const sneaky = { source: 'finnhub', provenance: syntheticProvenance('finnhub') };
    assert.equal(rejectEmission(sneaky, LIVE), 'synthetic_in_live_mode');
    assert.equal(badgeFor(sneaky.provenance), 'DEMO');
  });

  it('a malformed envelope is refused rather than rendered', () => {
    const delayedNoEstimate = {
      source: 'polygon',
      provenance: { ...upstreamProvenance({ source: 'polygon' }), is_delayed: true as const },
    };
    assert.equal(rejectEmission(delayedNoEstimate, DEMO), 'invalid_provenance');
  });
});

describe('EXIT 2 — live mode never emits simulation events', () => {
  it('rejects every synthetic-source record in live mode, tagged or not', () => {
    const admitted: string[] = [];
    for (const source of ['simulation', 'seed', 'mock', 'synthetic']) {
      for (const variant of [
        { source },
        { source, synthetic: true as const },
        { source, provenance: syntheticProvenance(source) },
        { source, synthetic: true as const, provenance: syntheticProvenance(source) },
      ]) {
        if (rejectEmission(variant, LIVE) === null) admitted.push(`${source}:${JSON.stringify(variant)}`);
      }
    }
    assert.deepEqual(admitted, [], 'synthetic records admitted in live mode');
  });

  it('still admits genuine upstream data in live mode', () => {
    for (const source of ['tradier', 'polygon', 'marketdata', 'schwab']) {
      assert.equal(rejectEmission({ source, provenance: upstreamProvenance({ source }) }, LIVE), null);
    }
  });

  it('admits delayed upstream data in live mode, but only WITH a delay estimate', () => {
    const withEstimate = {
      source: 'polygon',
      provenance: upstreamProvenance({ source: 'polygon', is_delayed: true, estimated_delay_seconds: 900 }),
    };
    assert.equal(rejectEmission(withEstimate, LIVE), null);
    assert.equal(badgeFor(withEstimate.provenance), 'DELAYED');
  });
});

describe('EXIT 3 — health endpoint returns real per-source staleness', () => {
  it('reports measured staleness, not a hardcoded status', () => {
    __resetSourceHealth();
    const T = 1_700_000_000_000;
    recordEvent('tradier', upstreamProvenance({ source: 'tradier' }), () => T);
    registerSource('polygon');           // registered, never delivered
    recordDisabled('finnhub');           // deliberately off

    const health = getSourceHealth(() => T + 30_000);
    const by = Object.fromEntries(health.map((h) => [h.source, h]));

    assert.equal(by.tradier.stalenessSeconds, 30);
    assert.equal(by.tradier.lastEventAt, new Date(T).toISOString());
    assert.equal(by.tradier.lifecycle, 'fresh');

    // A source that never reported is visible as such — not absent, not "ok".
    assert.equal(by.polygon.lifecycle, 'never_reported');
    assert.equal(by.polygon.lastEventAt, null);
    assert.equal(by.polygon.stalenessSeconds, null);

    assert.equal(by.finnhub.lifecycle, 'disabled');
  });

  it('a source that stops delivering becomes stale without anyone polling it', () => {
    __resetSourceHealth();
    const T = 1_700_000_000_000;
    recordEvent('tradier', upstreamProvenance({ source: 'tradier' }), () => T);
    // tradier freshness window is 60s
    assert.equal(getSourceHealth(() => T + 59_000)[0].lifecycle, 'fresh');
    assert.equal(getSourceHealth(() => T + 61_000)[0].lifecycle, 'stale');
  });
});
