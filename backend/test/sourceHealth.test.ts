import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import {
  __resetSourceHealth,
  DEFAULT_FRESHNESS_SECONDS,
  freshnessWindowFor,
  getOverallHealth,
  getSourceHealth,
  recordDisabled,
  recordError,
  recordEvent,
  registerSource,
} from '../src/ingestion/sourceHealth';
import { syntheticProvenance, upstreamProvenance } from '../src/config/provenance';

/** Controllable clock so staleness is asserted deterministically, never by sleeping. */
function clockAt(ms: number) {
  return () => ms;
}

const T0 = 1_700_000_000_000;

beforeEach(() => __resetSourceHealth());

describe('registered-but-silent sources are visible', () => {
  it('reports never_reported with null staleness, not healthy-by-omission', () => {
    registerSource('tradier');
    const [health] = getSourceHealth(clockAt(T0));
    assert.equal(health.source, 'tradier');
    assert.equal(health.lifecycle, 'never_reported');
    assert.equal(health.lastEventAt, null);
    assert.equal(health.stalenessSeconds, null);
    assert.equal(health.eventCount, 0);
  });

  it('overall is degraded when a registered source has never reported', () => {
    registerSource('tradier');
    assert.equal(getOverallHealth(clockAt(T0)).status, 'degraded');
  });
});

describe('measured staleness', () => {
  it('is computed from real arrival time', () => {
    recordEvent('polygon', upstreamProvenance({ source: 'polygon' }), clockAt(T0));
    const [h] = getSourceHealth(clockAt(T0 + 45_000));
    assert.equal(h.stalenessSeconds, 45);
    assert.equal(h.eventCount, 1);
    assert.equal(h.lastEventAt, new Date(T0).toISOString());
  });

  it('degrades to stale on its own once past the freshness window', () => {
    // polygon window is 120s
    recordEvent('polygon', upstreamProvenance({ source: 'polygon' }), clockAt(T0));
    assert.equal(getSourceHealth(clockAt(T0 + 60_000))[0].lifecycle, 'fresh');
    assert.equal(getSourceHealth(clockAt(T0 + 121_000))[0].lifecycle, 'stale');
  });

  it('exposes the window it applied, so the threshold is not a mystery', () => {
    recordEvent('cboe', upstreamProvenance({ source: 'cboe' }), clockAt(T0));
    assert.equal(getSourceHealth(clockAt(T0))[0].freshnessWindowSeconds, 3_600);
    assert.equal(freshnessWindowFor('a-source-with-no-entry'), DEFAULT_FRESHNESS_SECONDS);
  });

  it('counts events and carries the last badge', () => {
    recordEvent('simulation', syntheticProvenance('simulation'), clockAt(T0));
    recordEvent('simulation', syntheticProvenance('simulation'), clockAt(T0 + 1000));
    const [h] = getSourceHealth(clockAt(T0 + 1000));
    assert.equal(h.eventCount, 2);
    assert.equal(h.lastBadge, 'DEMO');
  });
});

describe('lifecycle transitions cannot hide an outage', () => {
  it('re-registering a source that has delivered events does not reset it to never_reported', () => {
    recordEvent('tradier', upstreamProvenance({ source: 'tradier' }), clockAt(T0));
    registerSource('tradier'); // e.g. a reconnect path calling register again
    const [h] = getSourceHealth(clockAt(T0 + 1000));
    assert.notEqual(h.lifecycle, 'never_reported');
    assert.equal(h.eventCount, 1);
  });

  it('but an explicit disable/error still applies to an active source', () => {
    recordEvent('tradier', upstreamProvenance({ source: 'tradier' }), clockAt(T0));
    recordError('tradier', clockAt(T0 + 5_000));
    const [h] = getSourceHealth(clockAt(T0 + 6_000));
    assert.equal(h.lifecycle, 'error');
    assert.equal(h.lastErrorAt, new Date(T0 + 5_000).toISOString());
  });
});

describe('overall rollup', () => {
  it('excludes disabled sources from the health verdict', () => {
    recordEvent('tradier', upstreamProvenance({ source: 'tradier' }), clockAt(T0));
    recordDisabled('polygon');
    const overall = getOverallHealth(clockAt(T0 + 1_000));
    assert.equal(overall.status, 'ok');
    assert.equal(overall.sourceCount, 2);
    assert.equal(overall.freshCount, 1);
  });

  it('is no_data when every source is disabled', () => {
    recordDisabled('polygon');
    recordDisabled('tradier');
    assert.equal(getOverallHealth(clockAt(T0)).status, 'no_data');
  });

  it('is degraded when any live source goes stale', () => {
    recordEvent('tradier', upstreamProvenance({ source: 'tradier' }), clockAt(T0));
    recordEvent('polygon', upstreamProvenance({ source: 'polygon' }), clockAt(T0));
    assert.equal(getOverallHealth(clockAt(T0 + 61_000)).status, 'degraded'); // tradier window 60s
  });
});
