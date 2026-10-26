/**
 * A session check that never answers must refuse the request, not hang it.
 *
 * supabase-js uses plain `fetch`, which has no timeout. Every signed-in API
 * request and socket handshake calls `getUser`, so one request the network
 * swallowed left the caller waiting forever. The client is now built with
 * `boundedFetch`, and a timed-out check is a failed check: not signed in.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

// The timeout timer is unref'd and the fake request holds no socket, so keep
// the event loop alive while the test waits. A real request holds its socket.
const keepAlive = setInterval(() => {}, 1_000);
after(() => clearInterval(keepAlive));

test('a hung session check is refused within the limit', { timeout: 20_000 }, async () => {
  const resolved = require.resolve('../src/middleware/auth');
  delete require.cache[resolved];
  const prev = {
    url: process.env.SUPABASE_URL,
    key: process.env.SUPABASE_SERVICE_KEY,
    fetch: globalThis.fetch,
  };
  process.env.SUPABASE_URL = 'https://stub.supabase.test';
  process.env.SUPABASE_SERVICE_KEY = 'service-key';
  let requests = 0;
  // Captured by `boundedFetch()` as its inner fetch when the module loads.
  globalThis.fetch = ((_input: unknown, init?: RequestInit) => {
    requests++;
    return new Promise((_resolve, reject) => {
      const s = init?.signal;
      if (s?.aborted) return reject(s.reason);
      s?.addEventListener('abort', () => reject(s.reason), { once: true });
    });
  }) as typeof fetch;
  try {
    const mod = require('../src/middleware/auth');
    const req: any = { headers: { authorization: 'Bearer some.jwt.token' } };
    const t0 = Date.now();
    await mod.optionalAuth(req, {}, () => {});
    const took = Date.now() - t0;
    assert.ok(requests >= 1, 'the check really went to the (hung) network');
    assert.equal(req.user, undefined, 'an unanswered check admits no one');
    assert.ok(took < mod.AUTH_REQUEST_TIMEOUT_MS + 3_000, `it gave up (took ${took}ms)`);

    const sock = await mod.authenticateSocket({ token: 'other.jwt.token' });
    assert.equal(sock.ok, false, 'and the socket is refused, not left waiting');
  } finally {
    globalThis.fetch = prev.fetch;
    if (prev.url === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = prev.url;
    if (prev.key === undefined) delete process.env.SUPABASE_SERVICE_KEY; else process.env.SUPABASE_SERVICE_KEY = prev.key;
    delete require.cache[resolved];
  }
});
