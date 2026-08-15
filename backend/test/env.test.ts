import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { assertEnvOrExit, hasValue, resolveNodeEnv, validateEnv } from '../src/config/env';

const goodSecrets = {
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SERVICE_KEY: 'service-key-value',
};

describe('hasValue', () => {
  it('treats undefined, empty and whitespace-only as absent', () => {
    assert.equal(hasValue(undefined), false);
    assert.equal(hasValue(''), false);
    assert.equal(hasValue('   '), false);
    assert.equal(hasValue('\t\n'), false);
    assert.equal(hasValue('x'), true);
  });
});

describe('resolveNodeEnv', () => {
  it('only "production" means production', () => {
    assert.equal(resolveNodeEnv({ NODE_ENV: 'production' }), 'production');
    assert.equal(resolveNodeEnv({ NODE_ENV: 'PRODUCTION' }), 'production');
    assert.equal(resolveNodeEnv({ NODE_ENV: 'prod' }), 'development');
    assert.equal(resolveNodeEnv({}), 'development');
  });
});

describe('validateEnv — production fails closed on missing secrets', () => {
  it('passes when all required secrets are present', () => {
    const result = validateEnv({ NODE_ENV: 'production', ...goodSecrets });
    assert.equal(result.ok, true);
  });

  it('fails when a required secret is absent', () => {
    const result = validateEnv({ NODE_ENV: 'production', SUPABASE_URL: goodSecrets.SUPABASE_URL });
    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.errors.some((e) => e.variable === 'SUPABASE_SERVICE_KEY'));
  });

  it('fails when a required secret is present but BLANK', () => {
    // The core guarantee: an empty env var must not silently disable auth.
    const result = validateEnv({ NODE_ENV: 'production', ...goodSecrets, SUPABASE_SERVICE_KEY: '' });
    assert.equal(result.ok, false);
    assert.ok(
      !result.ok &&
        result.errors.some(
          (e) => e.variable === 'SUPABASE_SERVICE_KEY' && e.code === 'blank_required_secret',
        ),
    );
  });

  it('fails on a whitespace-only secret', () => {
    const result = validateEnv({ NODE_ENV: 'production', ...goodSecrets, SUPABASE_URL: '   ' });
    assert.equal(result.ok, false);
  });

  it('warns instead of failing outside production', () => {
    const result = validateEnv({ NODE_ENV: 'development' });
    assert.equal(result.ok, true);
    assert.ok(result.ok && result.warnings.length >= 1);
  });

  it('rejects a partially configured secret group in production', () => {
    const result = validateEnv({
      NODE_ENV: 'production',
      ...goodSecrets,
      SCHWAB_APP_KEY: 'key',
      SCHWAB_APP_SECRET: 'secret',
      // SCHWAB_REFRESH_TOKEN deliberately absent
    });
    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.errors.some((e) => e.code === 'partial_secret_group'));
  });

  it('rejects an unrecognized DATA_MODE in every environment', () => {
    const result = validateEnv({ NODE_ENV: 'development', DATA_MODE: 'real' });
    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.errors.some((e) => e.code === 'invalid_data_mode'));
  });
});

describe('validateEnv — never discloses secret values', () => {
  it('reports variable names and reasons only', () => {
    const secret = 'SUPER-SECRET-VALUE-9f3a';
    const result = validateEnv({
      NODE_ENV: 'production',
      SUPABASE_URL: secret,
      // SUPABASE_SERVICE_KEY missing → forces an error path that sees the env
      DATA_MODE: 'bogus',
    });
    const serialized = JSON.stringify(result);
    assert.ok(!serialized.includes(secret), 'validation output must not contain any secret value');
  });
});

describe('assertEnvOrExit', () => {
  it('exits with code 1 in production when a secret is blank', () => {
    const exitCodes: number[] = [];
    const fakeExit = ((code: number) => {
      exitCodes.push(code);
      return undefined as never;
    }) as (code: number) => never;

    const originalError = console.error;
    console.error = () => {};
    try {
      assertEnvOrExit({ NODE_ENV: 'production', SUPABASE_URL: 'u', SUPABASE_SERVICE_KEY: '' }, fakeExit);
    } finally {
      console.error = originalError;
    }

    assert.deepEqual(exitCodes, [1]);
  });

  it('does not exit when the environment is valid', () => {
    let exited = false;
    const fakeExit = ((_code: number) => {
      exited = true;
      return undefined as never;
    }) as (code: number) => never;

    assertEnvOrExit({ NODE_ENV: 'production', ...goodSecrets }, fakeExit);
    assert.equal(exited, false);
  });
});
