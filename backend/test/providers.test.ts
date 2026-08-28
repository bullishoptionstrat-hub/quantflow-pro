import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import {
  configuredProviders,
  getProvider,
  missingEnvFor,
  PROVIDERS,
  providersWithCapability,
} from '../src/providers/registry';
import {
  provenanceFromDescriptor,
  qualityScoreFor,
  validateDescriptor,
} from '../src/providers/types';
import {
  __resetQuota,
  CIRCUIT_ERROR_THRESHOLD,
  effectiveBudget,
  quotaSnapshot,
  reportFailure,
  reportSuccess,
  requestQuota,
  UNVERIFIED_SAFETY_FACTOR,
} from '../src/providers/quota';
import { validateProvenance } from '../src/config/provenance';

const T0 = 1_700_000_000_000;
const at = (ms: number) => () => ms;

beforeEach(() => __resetQuota());

describe('every declared provider is structurally valid', () => {
  for (const p of PROVIDERS) {
    it(`${p.id} declares a coherent contract`, () => {
      assert.deepEqual(
        validateDescriptor(p),
        [],
        `${p.id} has contradictory capability declarations`,
      );
    });
  }

  it('no provider claims realtime while also declaring a delay', () => {
    for (const p of PROVIDERS) {
      if (p.latency === 'realtime') {
        assert.equal(p.estimatedDelaySeconds, undefined, `${p.id} claims realtime AND a delay`);
      }
    }
  });

  it('every non-realtime provider states how delayed it is', () => {
    for (const p of PROVIDERS) {
      if (p.latency !== 'realtime') {
        assert.equal(typeof p.estimatedDelaySeconds, 'number', `${p.id} is delayed but says nothing`);
      }
    }
  });

  it('FINRA is declared BLOCKED with a reason, not quietly usable', () => {
    const finra = getProvider('finra');
    assert.ok(finra);
    assert.equal(finra?.blockedOnFreeTier, true);
    assert.match(String(finra?.blockedReason), /weekly/i);
    // and it must never be offered as a capability provider
    assert.ok(!providersWithCapability('equity_trades').some((p) => p.id === 'finra'));
  });

  it('Polygon is declared delayed, matching its verified free-tier terms', () => {
    const p = getProvider('polygon');
    assert.equal(p?.latency, 'delayed');
    assert.equal(p?.estimatedDelaySeconds, 900);
    assert.equal(p?.rateLimit.requests, 5);
    assert.equal(p?.rateLimit.verification.state, 'verified');
  });
});

describe('provenance derives from the provider contract', () => {
  it('a delayed provider always produces is_delayed + an estimate', () => {
    const p = getProvider('polygon')!;
    const prov = provenanceFromDescriptor(p, {}, () => new Date(T0));
    assert.equal(prov.is_delayed, true);
    assert.equal(prov.estimated_delay_seconds, 900);
    assert.deepEqual(validateProvenance(prov), []);
  });

  it('a realtime provider produces no delay flags', () => {
    const prov = provenanceFromDescriptor(getProvider('tradier')!, {}, () => new Date(T0));
    assert.equal(prov.is_delayed, undefined);
    assert.deepEqual(validateProvenance(prov), []);
  });

  it('FAILOVER IS NEVER SILENT — a degraded event records what it replaced', () => {
    const prov = provenanceFromDescriptor(
      getProvider('polygon')!,
      { degradedFrom: 'tradier' },
      () => new Date(T0),
    );
    assert.equal(prov.is_inferred, true);
    assert.equal(prov.inference_method, 'failover_from:tradier');
    assert.equal(typeof prov.confidence, 'number');
    assert.deepEqual(validateProvenance(prov), []);
  });

  it('quality score drops for delay, unverified limits and degradation', () => {
    const tradier = getProvider('tradier')!;   // realtime, unverified limit
    const polygon = getProvider('polygon')!;   // delayed, verified limit
    assert.ok(qualityScoreFor(polygon) < 1);
    assert.ok(qualityScoreFor(polygon, true) < qualityScoreFor(polygon));
    assert.ok(qualityScoreFor(tradier) < 1, 'unverified limit should cost quality');
  });
});

describe('quota enforcement', () => {
  const env = { POLYGON_API_KEY: 'k', TRADIER_TOKEN: 't' };

  it('allows up to the verified budget then stops', () => {
    // polygon: verified 5 req / 60 s, priority 0 ⇒ no reserve
    for (let i = 0; i < 5; i++) {
      const d = requestQuota('polygon', { env, now: at(T0) });
      assert.equal(d.action, 'allow', `call ${i + 1} should be allowed`);
    }
    const sixth = requestQuota('polygon', { env, now: at(T0) });
    assert.notEqual(sixth.action, 'allow', '6th call in the window must not be allowed');
  });

  it('enforces UNVERIFIED limits pessimistically', () => {
    const flash = getProvider('flashalpha')!;
    // 5/day declared but unverified ⇒ effective ceiling is halved
    assert.equal(flash.rateLimit.perDay, 5);
    assert.equal(flash.rateLimit.verification.state, 'unverified');
    assert.equal(effectiveBudget(flash), null); // no per-window request cap declared
    assert.equal(UNVERIFIED_SAFETY_FACTOR, 0.5);
  });

  it('the window rolls, restoring budget', () => {
    for (let i = 0; i < 5; i++) requestQuota('polygon', { env, now: at(T0) });
    assert.notEqual(requestQuota('polygon', { env, now: at(T0) }).action, 'allow');
    // 61s later the 60s window has rolled
    assert.equal(requestQuota('polygon', { env, now: at(T0 + 61_000) }).action, 'allow');
  });

  it('low-priority work cannot consume the last of a budget', () => {
    // 4 calls used, P5 caller reserves 50% ⇒ must be refused before P0 would be
    for (let i = 0; i < 3; i++) requestQuota('polygon', { env, now: at(T0) });
    const background = requestQuota('polygon', { priority: 5, env, now: at(T0) });
    assert.notEqual(background.action, 'allow', 'P5 must not spend reserved headroom');
  });

  it('DEGRADES to a declared fallback rather than crashing', () => {
    // tradier has no per-window cap, so force the circuit open instead
    for (let i = 0; i < CIRCUIT_ERROR_THRESHOLD; i++) reportFailure('tradier', at(T0));
    const d = requestQuota('tradier', { env, now: at(T0 + 1_000) });
    assert.equal(d.action, 'degrade');
    if (d.action === 'degrade') {
      assert.equal(d.providerId, 'polygon', 'should hand off to the declared fallback');
      assert.equal(d.degradedFrom, 'tradier');
      assert.equal(d.reason, 'circuit_open');
    }
  });

  it('DEFERS with a retry hint when there is no fallback', () => {
    for (let i = 0; i < CIRCUIT_ERROR_THRESHOLD; i++) reportFailure('polygon', at(T0));
    const d = requestQuota('polygon', { env, now: at(T0 + 1_000) });
    assert.equal(d.action, 'defer');
    if (d.action === 'defer') assert.ok(d.retryAfterSeconds > 0);
  });

  it('a success closes the circuit', () => {
    for (let i = 0; i < CIRCUIT_ERROR_THRESHOLD; i++) reportFailure('polygon', at(T0));
    reportSuccess('polygon', at(T0));
    assert.equal(requestQuota('polygon', { env, now: at(T0 + 1) }).action, 'allow');
  });

  it('never throws — exhaustion returns a typed decision', () => {
    for (let i = 0; i < 50; i++) {
      const d = requestQuota('polygon', { env, now: at(T0) });
      assert.ok(['allow', 'defer', 'degrade', 'deny'].includes(d.action));
    }
  });

  it('denies an unconfigured provider by name, not by crash', () => {
    const d = requestQuota('schwab', { env: {}, now: at(T0) });
    assert.equal(d.action, 'deny');
    if (d.action === 'deny') assert.match(d.reason, /missing_env/);
  });

  it('denies a provider that is blocked on the free tier', () => {
    const d = requestQuota('finra', { env, now: at(T0) });
    assert.equal(d.action, 'deny');
    if (d.action === 'deny') assert.match(d.reason, /blocked_on_free_tier/);
  });

  it('denies an unknown provider', () => {
    assert.equal(requestQuota('not-a-provider', { env, now: at(T0) }).action, 'deny');
  });

  it('snapshot reports usage and whether the limit was ever verified', () => {
    requestQuota('polygon', { env, now: at(T0) });
    const snap = quotaSnapshot(at(T0)).find((s) => s.providerId === 'polygon');
    assert.equal(snap?.windowUsed, 1);
    assert.equal(snap?.windowBudget, 5);
    assert.equal(snap?.limitVerified, true);
  });
});

describe('configuration reporting', () => {
  it('reports exactly which env vars a provider is missing', () => {
    assert.deepEqual(missingEnvFor(getProvider('schwab')!, {}), [
      'SCHWAB_APP_KEY', 'SCHWAB_APP_SECRET', 'SCHWAB_REFRESH_TOKEN',
    ]);
  });

  it('treats a blank env var as missing, not configured', () => {
    assert.deepEqual(missingEnvFor(getProvider('polygon')!, { POLYGON_API_KEY: '   ' }), [
      'POLYGON_API_KEY',
    ]);
  });

  it('keyless providers count as configured', () => {
    const ids = configuredProviders({}).map((p) => p.id);
    assert.ok(ids.includes('cboe'));
    assert.ok(ids.includes('stooq'));
    assert.ok(!ids.includes('polygon'));
  });
});
