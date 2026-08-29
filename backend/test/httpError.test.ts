/**
 * `describeHttpError` feeds `sourceErrors`, which `/api/health` serves without
 * authentication. These tests pin the two things that matter there: the vendor's
 * actual reason survives, and nothing credential-shaped does.
 *
 * Run: npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeHttpError, redactSecrets, MAX_DETAIL_CHARS } from '../src/ingestion/httpError';

const httpErr = (status: number, data?: unknown) => ({ response: { status, data } });

test('carries the vendor reason, not just the status code', () => {
  const detail = describeHttpError(
    httpErr(403, { status: 'NOT_AUTHORIZED', message: 'You are not entitled to this data.' }),
  );
  assert.match(detail, /HTTP 403/);
  assert.match(detail, /NOT_AUTHORIZED/);
  assert.match(detail, /not entitled/);
});

test('falls back to a bare status when the body is empty', () => {
  assert.equal(describeHttpError(httpErr(500, '')), 'HTTP 500');
  assert.equal(describeHttpError(httpErr(502)), 'HTTP 502');
});

test('string bodies are collapsed to a single line', () => {
  const detail = describeHttpError(httpErr(400, '  bad\n\n  request  \t here '));
  assert.equal(detail, 'HTTP 400 — bad request here');
});

test('an echoed apiKey query param never reaches the output', () => {
  const detail = describeHttpError(
    httpErr(403, 'unknown key for https://api.polygon.io/v3/trades/options?apiKey=sk_live_SECRET123&limit=25'),
  );
  assert.ok(!detail.includes('sk_live_SECRET123'), detail);
  assert.match(detail, /apiKey=\[REDACTED\]/);
  // The non-secret part of the URL is still useful, so it stays.
  assert.match(detail, /limit=25/);
});

test('redacts every documented credential param spelling', () => {
  for (const param of ['apiKey', 'api_key', 'api-key', 'token', 'access_token', 'auth', 'secret']) {
    const out = redactSecrets(`https://x.test/?${param}=TOPSECRETVALUE`);
    assert.ok(!out.includes('TOPSECRETVALUE'), `${param} leaked: ${out}`);
  }
});

test('redacts an echoed bearer token', () => {
  const out = redactSecrets('rejected header Bearer abcdef0123456789xyz');
  assert.ok(!out.includes('abcdef0123456789xyz'), out);
  assert.match(out, /Bearer \[REDACTED\]/);
});

test('scrubs the message on transport failures too, where there is no response', () => {
  const detail = describeHttpError({
    message: 'connect ETIMEDOUT https://api.polygon.io/v3/trades/options?apiKey=sk_live_SECRET123',
  });
  assert.ok(!detail.includes('sk_live_SECRET123'), detail);
  assert.match(detail, /ETIMEDOUT/);
});

test('long bodies are clipped so one connector cannot bloat the health payload', () => {
  const detail = describeHttpError(httpErr(500, 'x'.repeat(5_000)));
  assert.ok(detail.length < MAX_DETAIL_CHARS + 40, `too long: ${detail.length}`);
  assert.ok(detail.endsWith('…'));
});

test('an unserializable body degrades to the bare status instead of throwing', () => {
  const circular: any = { a: 1 };
  circular.self = circular;
  assert.equal(describeHttpError(httpErr(500, circular)), 'HTTP 500');
});

test('a completely unknown failure still produces a string', () => {
  assert.equal(describeHttpError(undefined), 'unknown error');
  assert.equal(describeHttpError({}), 'unknown error');
});
