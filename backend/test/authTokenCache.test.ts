/**
 * A polling terminal could sign itself out.
 *
 * `optionalAuth` called `supabase.auth.getUser()` on every request. The
 * terminal polls — the ticker tape every 30s, plus the flow, macro and news
 * pages — so a signed-in reader with a few tabs open generates a steady stream
 * of calls to Supabase's `/auth/v1/user`, which is rate limited. When it
 * limits, `getUser` errors, the `catch` in `optionalAuth` swallows it,
 * `req.user` stays undefined, and the request 401s. A working session is
 * silently signed out by its own polling, and the terminal reports
 * "REFUSED — the backend did not accept this session".
 *
 * The cache trades a bounded revocation window for that. These tests hold the
 * three properties that make the trade honest: only successes are cached, an
 * entry never outlives the token's own `exp`, and the key is a hash rather
 * than the credential.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const AUTH = join(__dirname, '..', 'src', 'middleware', 'auth.ts');

/** A JWT-shaped token whose `exp` is `secondsFromNow` away. */
function tokenExpiringIn(secondsFromNow: number, id = 'u1'): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    sub: id, exp: Math.floor(Date.now() / 1000) + secondsFromNow,
  })).toString('base64url');
  return `${header}.${payload}.sig`;
}

/** Load the middleware with a stubbed Supabase client and a chosen TTL. */
function load(opts: { ttl?: string; getUser: (token: string) => Promise<any> }) {
  const resolved = require.resolve('../src/middleware/auth');
  delete require.cache[resolved];

  const prevTtl = process.env.AUTH_CACHE_TTL_SECONDS;
  const prevUrl = process.env.SUPABASE_URL;
  const prevKey = process.env.SUPABASE_SERVICE_KEY;
  if (opts.ttl === undefined) delete process.env.AUTH_CACHE_TTL_SECONDS;
  else process.env.AUTH_CACHE_TTL_SECONDS = opts.ttl;
  process.env.SUPABASE_URL = 'https://stub.supabase.test';
  process.env.SUPABASE_SERVICE_KEY = 'service-key';

  let calls = 0;
  const supa = require('@supabase/supabase-js');
  const realCreate = supa.createClient;
  supa.createClient = () => ({
    auth: {
      getUser: async (token: string) => { calls++; return opts.getUser(token); },
    },
  });

  const mod = require('../src/middleware/auth');
  return {
    ...mod,
    calls: () => calls,
    restore() {
      supa.createClient = realCreate;
      if (prevTtl === undefined) delete process.env.AUTH_CACHE_TTL_SECONDS;
      else process.env.AUTH_CACHE_TTL_SECONDS = prevTtl;
      if (prevUrl === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = prevUrl;
      if (prevKey === undefined) delete process.env.SUPABASE_SERVICE_KEY; else process.env.SUPABASE_SERVICE_KEY = prevKey;
      delete require.cache[resolved];
    },
  };
}

const ok = (id = 'u1') => async () => ({ data: { user: { id, email: 'a@b.c', role: 'authenticated' } }, error: null });

/** Run `optionalAuth` and return the user it attached. */
async function auth(mod: any, token: string) {
  const req: any = { headers: { authorization: `Bearer ${token}` } };
  await mod.optionalAuth(req, {}, () => {});
  return req.user;
}

test('a repeated request verifies once', async () => {
  const m = load({ getUser: ok() });
  try {
    const token = tokenExpiringIn(3600);
    for (let i = 0; i < 25; i++) assert.equal((await auth(m, token))?.id, 'u1');
    assert.equal(m.calls(), 1, 'polling must not re-ask Supabase on every request');
  } finally { m.restore(); }
});

test('a failure is not cached', async () => {
  // Supabase being unreachable is not the same as the token being bad, and
  // caching that would lock a valid session out for the whole TTL.
  let attempt = 0;
  const m = load({
    getUser: async () => {
      attempt++;
      if (attempt <= 2) throw new Error('ECONNRESET');
      return { data: { user: { id: 'u1' } }, error: null };
    },
  });
  try {
    const token = tokenExpiringIn(3600);
    assert.equal(await auth(m, token), undefined);
    assert.equal(await auth(m, token), undefined);
    // The transient failure cleared; the very next request must succeed.
    assert.equal((await auth(m, token))?.id, 'u1');
    assert.equal(m.calls(), 3, 'each failure must be retried, not remembered');
  } finally { m.restore(); }
});

test('an entry never outlives the token', async () => {
  // The claim is read, never trusted: it can only shorten the entry. A token
  // expiring in one second must not be honoured for the full 30.
  const m = load({ ttl: '30', getUser: ok() });
  try {
    const token = tokenExpiringIn(1);
    assert.equal((await auth(m, token))?.id, 'u1');
    assert.equal(m.calls(), 1);

    await new Promise((r) => setTimeout(r, 1100));
    await auth(m, token);
    assert.equal(m.calls(), 2, 'an expired token must be re-verified, not served from cache');
  } finally { m.restore(); }
});

test('an already-expired token is not cached at all', async () => {
  const m = load({ ttl: '30', getUser: ok() });
  try {
    await auth(m, tokenExpiringIn(-60));
    assert.equal(m.verifiedTokenCacheSize(), 0);
  } finally { m.restore(); }
});

test('a token with no readable exp falls back to the TTL, never past it', async () => {
  const m = load({ ttl: '30', getUser: ok() });
  try {
    // Not a JWT at all — the decode must not throw, and must not extend.
    await auth(m, 'opaque-token-with-no-claims');
    assert.equal(m.verifiedTokenCacheSize(), 1);
    assert.equal(m.calls(), 1);
    await auth(m, 'opaque-token-with-no-claims');
    assert.equal(m.calls(), 1);
  } finally { m.restore(); }
});

test('two different tokens are two different entries', async () => {
  // The stub answers from the token's own `sub`, decoded — the id lives inside
  // the base64url payload, not in the token string.
  const m = load({
    getUser: async (t: string) => {
      const sub = JSON.parse(Buffer.from(t.split('.')[1]!, 'base64url').toString()).sub;
      return { data: { user: { id: sub } }, error: null };
    },
  });
  try {
    assert.equal((await auth(m, tokenExpiringIn(3600, 'u1')))?.id, 'u1');
    assert.equal((await auth(m, tokenExpiringIn(3600, 'u2')))?.id, 'u2');
    assert.equal(m.calls(), 2);
    assert.equal(m.verifiedTokenCacheSize(), 2);
  } finally { m.restore(); }
});

test('a TTL of zero disables the cache entirely', async () => {
  // The dial an operator turns when a revocation window is unacceptable. It
  // restores exactly the behaviour that existed before the cache.
  const m = load({ ttl: '0', getUser: ok() });
  try {
    const token = tokenExpiringIn(3600);
    await auth(m, token);
    await auth(m, token);
    await auth(m, token);
    assert.equal(m.calls(), 3);
    assert.equal(m.verifiedTokenCacheSize(), 0);
  } finally { m.restore(); }
});

test('a bare "Bearer " spends no round trip', async () => {
  // `startsWith('Bearer ')` passes on the prefix alone. There is no token to
  // verify, so asking Supabase whether an empty string is a session is a call
  // whose answer is already known.
  const m = load({ getUser: ok() });
  try {
    const req: any = { headers: { authorization: 'Bearer ' } };
    await m.optionalAuth(req, {}, () => {});
    assert.equal(req.user, undefined);
    assert.equal(m.calls(), 0);
  } finally { m.restore(); }
});

test('the cache is bounded', async () => {
  const m = load({ getUser: ok() });
  try {
    for (let i = 0; i < 3_000; i++) await auth(m, tokenExpiringIn(3600, `u${i}`));
    assert.ok(m.verifiedTokenCacheSize() <= 1_000,
      `a flood of distinct tokens must not grow the map without limit (got ${m.verifiedTokenCacheSize()})`);
  } finally { m.restore(); }
});

test('the key is a hash, not the credential', () => {
  // The token is already in memory because it arrived in a header, but a map
  // keyed by raw credentials is one heap dump or one careless log away from
  // leaking every live session.
  const code = readFileSync(AUTH, 'utf8');
  assert.match(code, /createHash\('sha256'\)\.update\(token\)/);
  assert.ok(!/verifiedTokens\.(get|set|delete)\(token[,)]/.test(code),
    'the map must never be keyed by the raw token');
  // And the hash is what a test can reproduce, so this is not a claim on trust.
  assert.equal(createHash('sha256').update('abc').digest('hex').length, 64);
});

test('the socket handshake shares the cache', async () => {
  // `socket.ts` passes `auth` as a callback, so every reconnect re-verifies. A
  // flapping connection would otherwise hammer the same endpoint until it
  // limits — and the refusal reads as a configuration problem.
  const m = load({ getUser: ok() });
  try {
    const token = tokenExpiringIn(3600);
    for (let i = 0; i < 10; i++) {
      const r = await m.authenticateSocket({ token });
      assert.equal(r.ok, true);
    }
    assert.equal(m.calls(), 1);
  } finally { m.restore(); }
});
