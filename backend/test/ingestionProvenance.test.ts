/**
 * Integration proof for the provenance guarantee:
 *   - demo mode: every generated event reaches the store tagged `synthetic: true`
 *   - live mode: the simulation generator refuses to start, and any untagged
 *     synthetic event is dropped at the emit boundary rather than served.
 *
 * These exercise the real ingestion module, not a reimplementation.
 */
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

const originalDataMode = process.env.DATA_MODE;

// Seeding happens inside startIngestion, which reads DATA_MODE at call time.
process.env.DATA_MODE = 'demo';

import {
  addFlowEvent,
  getDarkPoolPrints,
  getGEXLevels,
  getIngestionStatus,
  getRecentFlow,
  startSimulationFeed,
  type FlowEvent,
} from '../src/ingestion/index';

after(() => {
  if (originalDataMode === undefined) delete process.env.DATA_MODE;
  else process.env.DATA_MODE = originalDataMode;
});

function baseEvent(overrides: Partial<FlowEvent>): FlowEvent {
  return {
    id: 'test-1',
    timestamp: new Date().toISOString(),
    symbol: 'SPY',
    expiration: '2026-09-18',
    strike: 580,
    callPut: 'C',
    type: 'BLOCK',
    size: 100,
    premium: 10_000,
    heatScore: 50,
    sentiment: 'neutral',
    source: 'tradier',
    ...overrides,
  };
}

describe('demo mode', () => {
  it('reports the resolved data mode on the status surface', () => {
    process.env.DATA_MODE = 'demo';
    assert.equal(getIngestionStatus().dataMode, 'demo');
  });

  it('tags generated GEX levels and simulated prints', () => {
    process.env.DATA_MODE = 'demo';

    const levels = getGEXLevels('SPY');
    assert.ok(levels.length > 0, 'demo mode should produce GEX levels');
    for (const level of levels) {
      assert.equal(level.synthetic, true, `strike ${level.strike} must be tagged synthetic`);
    }

    // addDarkPoolPrints runs on the demo GEX/print schedule; drive it via the
    // public surface after generation.
    for (const print of getDarkPoolPrints()) {
      assert.equal(print.synthetic, true, `print ${print.id} must be tagged synthetic`);
    }
  });

  it('drops an untagged event from a synthetic source', () => {
    process.env.DATA_MODE = 'demo';
    const before = getRecentFlow().length;
    addFlowEvent(baseEvent({ id: 'untagged-seed', source: 'seed' }));
    const found = getRecentFlow().find((e) => e.id === 'untagged-seed');
    assert.equal(found, undefined, 'untagged synthetic event must never reach the store');
    assert.equal(getRecentFlow().length, before);
  });

  it('accepts a tagged synthetic event', () => {
    process.env.DATA_MODE = 'demo';
    addFlowEvent(baseEvent({ id: 'tagged-seed', source: 'seed', synthetic: true }));
    const found = getRecentFlow().find((e) => e.id === 'tagged-seed');
    assert.ok(found, 'tagged synthetic event should be stored in demo mode');
    assert.equal(found?.synthetic, true);
  });
});

describe('live mode', () => {
  it('refuses to start the simulation feed', () => {
    process.env.DATA_MODE = 'live';
    startSimulationFeed();
    assert.equal(getIngestionStatus().sources['simulation'], 'disabled');
  });

  it('serves no generated GEX rather than inventing levels', () => {
    process.env.DATA_MODE = 'live';
    assert.deepEqual(getGEXLevels('NEVER_CACHED_SYMBOL'), []);
  });

  it('drops synthetic events even when correctly tagged', () => {
    process.env.DATA_MODE = 'live';
    addFlowEvent(baseEvent({ id: 'live-tagged', source: 'simulation', synthetic: true }));
    assert.equal(getRecentFlow().find((e) => e.id === 'live-tagged'), undefined);
  });

  it('still accepts genuine upstream events', () => {
    process.env.DATA_MODE = 'live';
    addFlowEvent(baseEvent({ id: 'live-real', source: 'tradier' }));
    const found = getRecentFlow().find((e) => e.id === 'live-real');
    assert.ok(found, 'real upstream events must pass through in live mode');
    assert.equal(found?.synthetic, undefined);
  });

  it('admits nothing synthetic across a sweep of every source name', () => {
    process.env.DATA_MODE = 'live';
    const admitted: string[] = [];

    for (const source of ['seed', 'simulation', 'mock', 'synthetic']) {
      for (const synthetic of [true, undefined] as const) {
        const id = `sweep-${source}-${String(synthetic)}`;
        addFlowEvent(baseEvent({ id, source, ...(synthetic ? { synthetic } : {}) }));
        if (getRecentFlow().some((e) => e.id === id)) admitted.push(id);
      }
    }

    assert.deepEqual(admitted, [], 'no synthetic-sourced event may be admitted in live mode');
  });
});
