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

import { upstreamProvenance } from '../src/config/provenance';
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

/**
 * MERGE NOTE: `FlowEvent` is now main's snake_case `WireFlowEvent` (the shape
 * `frontend/lib/types.ts` actually consumes). This fixture was the old
 * camelCase shape and is ported rather than deleted — what it asserts (that the
 * emit boundary drops untagged synthetic data) is independent of field naming.
 */
function baseEvent(overrides: Partial<FlowEvent>): FlowEvent {
  return {
    id: 'test-1',
    created_at: new Date().toISOString(),
    underlying: 'SPY',
    expiry: '2026-09-18',
    strike: 580,
    option_type: 'C',
    order_type: 'BLOCK',
    total_size: 100,
    total_premium: 10_000,
    heat_score: 50,
    sentiment: 'NEUTRAL',
    source: 'tradier',
    is_unusual: false,
    exchange_count: 1,
    avg_price: 1,
    iv: 0,
    delta: 0,
    open_interest: 0,
    days_to_expiry: 30,
    moneyness: 'ATM',
    spot_price: 580,
    side: 'AMBIGUOUS',
    classification_grade: 'UNKNOWN',
    score_breakdown: {},
    print_ids: ['test-1'],
    synthetic: false,
    provenance: upstreamProvenance({ source: 'tradier', source_type: 'broker' }),
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

  it('accepts genuine upstream events that declare provenance', () => {
    process.env.DATA_MODE = 'live';
    addFlowEvent(baseEvent({
      id: 'live-real',
      source: 'tradier',
      provenance: upstreamProvenance({ source: 'tradier', source_type: 'broker' }),
    }));
    const found = getRecentFlow().find((e) => e.id === 'live-real');
    assert.ok(found, 'real upstream events must pass through in live mode');
    // `synthetic` is a required boolean on the wire shape, so the assertion is
    // "does not claim to be synthetic" rather than "is absent".
    assert.notEqual(found?.synthetic, true);
    assert.equal(found?.provenance?.is_synthetic, undefined);
  });

  it('refuses an upstream event with NO provenance in live mode', () => {
    // Fail-closed rule from the Wave 1 adversarial pass.
    process.env.DATA_MODE = 'live';
    const ev = baseEvent({ id: 'live-no-prov', source: 'tradier' });
    // Simulate a producer that simply forgot the field. The cast is the point:
    // the type system says this cannot happen, and this test proves the runtime
    // guard still catches it when something bypasses the types (a JSON payload,
    // an `any`, a future refactor).
    delete (ev as Partial<FlowEvent>).provenance;
    addFlowEvent(ev);
    assert.equal(getRecentFlow().find((e) => e.id === 'live-no-prov'), undefined);
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
