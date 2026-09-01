/**
 * The live feed's handshake gate.
 *
 * `io.on('connection')` used to admit anyone who connected, with
 * `cors.origin: '*'` and `credentials: true` — so any page on any origin could
 * open a socket to the backend and receive `flow_batch`, the classified signal
 * feed, in real time. Meanwhile `/api/flow` served the very same signals behind
 * `requireAuthOrDemo`. The careful two-tier split on the HTTP side was being
 * routed around by the transport carrying the same data.
 *
 * The gate mirrors `requireAuthOrDemo`, so these tests mirror
 * `demoAuth.test.ts`: what matters is the boundary — it opens for exactly one
 * unauthenticated combination and stays shut for every other. In particular
 * the two conditions must be independent, which is the claim CLAUDE.md makes
 * for the HTTP tier and which has to hold here too.
 *
 * Run: npm test
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { authenticateSocket, socketAuthConfigured } from '../src/middleware/auth';

const realDemo = process.env.DEMO_MODE;

beforeEach(() => { delete process.env.DEMO_MODE; });
afterEach(() => {
  if (realDemo === undefined) delete process.env.DEMO_MODE;
  else process.env.DEMO_MODE = realDemo;
});

// ─── The boundary ───────────────────────────────────────────────────────────

test('a handshake with nothing at all is refused', async () => {
  const r = await authenticateSocket({});
  assert.equal(r.ok, false);
});

test('a handshake with no auth object at all is refused', async () => {
  // `socket.handshake.auth` is `{}` by default, but a client can send anything.
  const r = await authenticateSocket(undefined as any);
  assert.equal(r.ok, false);
});

test('asking for demo does not open the feed when the deployment has not opted in', async () => {
  // Condition one, alone. This is the independence claim: a client flag is a
  // request, never a bypass.
  const r = await authenticateSocket({ demo: true });
  assert.equal(r.ok, false, 'DEMO_MODE is unset, so a demo flag must not admit');
});

test('opting in does not open the feed to a client that did not ask', async () => {
  // Condition two, alone. A deployment running demo mode must not hand the
  // feed to every socket that happens to connect.
  process.env.DEMO_MODE = '1';
  const r = await authenticateSocket({});
  assert.equal(r.ok, false);
});

test('both conditions together admit a demo socket', async () => {
  process.env.DEMO_MODE = '1';
  const r = await authenticateSocket({ demo: true });
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.identity.demo, true);
  assert.equal(r.ok && r.identity.user, undefined);
});

test('DEMO_MODE must be exactly "1"', async () => {
  for (const v of ['true', 'yes', '0', 'TRUE', ' 1', '']) {
    process.env.DEMO_MODE = v;
    const r = await authenticateSocket({ demo: true });
    assert.equal(r.ok, false, `DEMO_MODE=${JSON.stringify(v)} must not enable demo`);
  }
});

test('a truthy-but-wrong demo value is not consent', async () => {
  process.env.DEMO_MODE = '1';
  // `"false"` is a truthy string. A naive `if (auth.demo)` would admit it.
  for (const v of ['false', 'no', 'yes', {}, [], 'demo']) {
    const r = await authenticateSocket({ demo: v as any });
    assert.equal(r.ok, false, `demo=${JSON.stringify(v)} must not be read as consent`);
  }
  // The forms that are consent.
  for (const v of [true, '1', 1]) {
    const r = await authenticateSocket({ demo: v as any });
    assert.equal(r.ok, true, `demo=${JSON.stringify(v)} should be accepted`);
  }
});

test('an unverifiable token falls through to refusal, not to admission', async () => {
  // No Supabase client is configured in tests, so no token can be verified.
  // A token that cannot be checked must never be treated as a good one.
  const r = await authenticateSocket({ token: 'eyJhbGciOiJIUzI1NiJ9.made.up' });
  assert.equal(r.ok, false);
});

test('a token does not smuggle in the demo tier', async () => {
  // With DEMO_MODE off, presenting a token that cannot be verified is still
  // just an unauthenticated connection.
  const r = await authenticateSocket({ token: 'nonsense', demo: true });
  assert.equal(r.ok, false);
});

test('a non-string token is ignored rather than coerced', async () => {
  for (const v of [1, true, {}, [], null]) {
    const r = await authenticateSocket({ token: v as any });
    assert.equal(r.ok, false);
  }
});

test('the refusal reason says nothing about which condition failed', async () => {
  // It crosses to an unauthenticated caller as a `connect_error` message.
  process.env.DEMO_MODE = '1';
  const a = await authenticateSocket({});
  delete process.env.DEMO_MODE;
  const b = await authenticateSocket({ demo: true });

  assert.equal(a.ok, false);
  assert.equal(b.ok, false);
  assert.equal(a.ok === false && a.reason, 'Unauthorized');
  assert.equal(
    a.ok === false && b.ok === false && a.reason, b.ok === false ? b.reason : '',
    'both refusals must be indistinguishable',
  );
});

// ─── Configuration reporting ────────────────────────────────────────────────

test('socketAuthConfigured is false when nothing can ever admit', async () => {
  // No Supabase client and no demo mode means every socket is refused. The
  // frontend substitutes simulated prints for a refused feed, so the terminal
  // keeps rendering — which is why this warns at boot instead of staying quiet.
  assert.equal(socketAuthConfigured(), false);
  process.env.DEMO_MODE = '1';
  assert.equal(socketAuthConfigured(), true);
});

// ─── Wiring ─────────────────────────────────────────────────────────────────

const SERVER_SRC = readFileSync(join(__dirname, '..', 'src', 'server.ts'), 'utf8');

/**
 * Source with comments removed, line comments first.
 *
 * Order matters and the obvious order is wrong: a `//` comment mentioning a
 * path like `/api/*` contains `/*`, so stripping block comments first opens a
 * phantom comment that runs to the next `*​/` and eats real code. That fails
 * open for any check asking "is this string absent" — which is most of them.
 */
function stripComments(src: string): string {
  return src
    .replace(/^[ \t]*\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
}

test('the gate is installed as handshake middleware, before connection', () => {
  // `io.use` runs during the handshake. Checking inside `io.on('connection')`
  // would mean the socket is already established when it is refused.
  const useAt = SERVER_SRC.indexOf('io.use(');
  const onAt = SERVER_SRC.indexOf("io.on('connection'");
  assert.ok(useAt > 0, 'the socket needs handshake middleware');
  assert.ok(onAt > 0);
  assert.ok(useAt < onAt, 'the gate must run before the connection handler');
  assert.match(SERVER_SRC, /io\.use\([\s\S]{0,300}?authenticateSocket/);
});

test('the socket no longer accepts every origin', () => {
  // Line comments first: a `//` comment containing `/api/*` would otherwise
  // open a phantom block comment and swallow the code after it.
  const code = stripComments(SERVER_SRC);
  assert.ok(
    !/origin:\s*'\*'/.test(code),
    "cors origin '*' with credentials let any page open the feed",
  );
  assert.match(code, /cors:\s*\{\s*origin:\s*CORS_ORIGINS/);
});
