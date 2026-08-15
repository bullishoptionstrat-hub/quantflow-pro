import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEFAULT_DATA_MODE,
  isSyntheticSource,
  markSynthetic,
  rejectEmission,
  resolveDataMode,
  syntheticGeneratorsAllowed,
  SYNTHETIC_SOURCES,
} from '../src/config/dataMode';

const live: NodeJS.ProcessEnv = { DATA_MODE: 'live' };
const demo: NodeJS.ProcessEnv = { DATA_MODE: 'demo' };

describe('resolveDataMode', () => {
  it('reads live and demo, case- and whitespace-insensitively', () => {
    assert.equal(resolveDataMode({ DATA_MODE: 'live' }), 'live');
    assert.equal(resolveDataMode({ DATA_MODE: '  LIVE ' }), 'live');
    assert.equal(resolveDataMode({ DATA_MODE: 'Demo' }), 'demo');
  });

  it('defaults to demo, never to live', () => {
    assert.equal(resolveDataMode({}), DEFAULT_DATA_MODE);
    assert.equal(resolveDataMode({}), 'demo');
    assert.equal(resolveDataMode({ DATA_MODE: '' }), 'demo');
    // An unrecognized value must not be read as live. `validateEnv` rejects it
    // at boot; the resolver must still fail safe if it is ever reached.
    assert.equal(resolveDataMode({ DATA_MODE: 'production' }), 'demo');
  });
});

describe('syntheticGeneratorsAllowed', () => {
  it('is false in live mode and true in demo mode', () => {
    assert.equal(syntheticGeneratorsAllowed(live), false);
    assert.equal(syntheticGeneratorsAllowed(demo), true);
  });
});

describe('markSynthetic', () => {
  it('stamps synthetic:true and preserves the payload', () => {
    const tagged = markSynthetic({ id: 'x', source: 'seed', premium: 12 });
    assert.equal(tagged.synthetic, true);
    assert.equal(tagged.id, 'x');
    assert.equal(tagged.premium, 12);
  });

  it('does not mutate its input', () => {
    const original: { source: string; synthetic?: true } = { source: 'seed' };
    markSynthetic(original);
    assert.equal(original.synthetic, undefined);
  });
});

describe('rejectEmission — no synthetic event is emittable untagged', () => {
  it('rejects an untagged payload from every synthetic source, in both modes', () => {
    for (const source of SYNTHETIC_SOURCES) {
      assert.equal(
        rejectEmission({ source }, demo),
        'untagged_synthetic_source',
        `untagged "${source}" must be rejected in demo mode`,
      );
      assert.notEqual(
        rejectEmission({ source }, live),
        null,
        `untagged "${source}" must be rejected in live mode`,
      );
    }
  });

  it('accepts a tagged synthetic payload in demo mode', () => {
    assert.equal(rejectEmission(markSynthetic({ source: 'simulation' }), demo), null);
    assert.equal(rejectEmission(markSynthetic({ source: 'seed' }), demo), null);
  });

  it('rejects a tagged synthetic payload in live mode', () => {
    assert.equal(
      rejectEmission(markSynthetic({ source: 'simulation' }), live),
      'synthetic_in_live_mode',
    );
    // Tagged synthetic from a real-looking source is still refused in live mode.
    assert.equal(
      rejectEmission(markSynthetic({ source: 'finnhub' }), live),
      'synthetic_in_live_mode',
    );
  });

  it('accepts untagged payloads from real upstream sources in both modes', () => {
    for (const source of ['tradier', 'polygon', 'yahoo', 'marketdata', 'schwab']) {
      assert.equal(rejectEmission({ source }, live), null);
      assert.equal(rejectEmission({ source }, demo), null);
    }
  });

  it('classifies synthetic sources explicitly', () => {
    assert.equal(isSyntheticSource('seed'), true);
    assert.equal(isSyntheticSource('simulation'), true);
    assert.equal(isSyntheticSource('mock'), true);
    assert.equal(isSyntheticSource('tradier'), false);
    assert.equal(isSyntheticSource(undefined), false);
  });
});
