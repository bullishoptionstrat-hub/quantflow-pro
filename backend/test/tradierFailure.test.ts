import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { classifyTradierFailure as c } from '../src/ingestion/tradierFailure';

const res = (status: number, data: unknown) => ({ response: { status, data } });

test('the measured egress-proxy refusal is a proxy refusal, never a credential failure', () => {
  // Measured 2026-10-28: axios through a refusing proxy, 403 text/plain.
  const measured = res(403, 'request blocked: no rule or allowlist entry allows host "api.tradier.com"\n');
  assert.equal(c(measured), 'proxy_refused');
  assert.equal(c(res(407, '')), 'proxy_refused');
  assert.equal(c({ code: 'ERR_BAD_RESPONSE', message: 'CONNECT tunnel failed, response 403' }), 'proxy_refused');
});

test('each vendor answer maps to its own remedy', () => {
  assert.equal(c(res(401, { fault: 'invalid token' })), 'credentials_rejected');
  assert.equal(c(res(403, { fault: 'not entitled' })), 'not_entitled');
  assert.equal(c(res(429, {})), 'rate_limited');
  assert.equal(c(res(503, 'upstream')), 'provider_error');
  assert.equal(c({ code: 'ETIMEDOUT', message: 'timeout of 10000ms exceeded' }), 'network');
  assert.equal(c(new Error('x'), false), 'missing_config');
});

test('a 403 that is neither vendor JSON nor recognisably a proxy is not guessed', () => {
  assert.equal(c(res(403, '<html>Forbidden</html>')), 'unknown');
  assert.equal(c(res(418, {})), 'unknown');
});

test('the stream connect path and the token probe use the classifier', () => {
  const src = readFileSync(join(__dirname, '../src/ingestion/index.ts'), 'utf8');
  assert.match(src, /const kind = classifyTradierFailure\(err\);/);
  assert.match(src, /lastProfileFailure = classifyTradierFailure\(err\)/);
  assert.match(src, /if \(lastProfileFailure === 'proxy_refused'\) return null;/);
});
