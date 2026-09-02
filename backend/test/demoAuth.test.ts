/**
 * Demo-mode gate tests.
 *
 * `requireAuthOrDemo` is the only way an unauthenticated request reaches a data
 * route, so what matters here is the boundary: it opens for exactly one
 * combination and stays shut for every other, and `requireAuth` never opens at
 * all. The routes that cost money per call are pinned to `requireAuth`
 * precisely so demo traffic can never reach them.
 *
 * Run: npm test
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { requireAuth, requireAuthOrDemo, isDemoModeEnabled, DEMO_HEADER } from '../src/middleware/auth';

const realDemo = process.env.DEMO_MODE;

function fakeReq(headers: Record<string, string> = {}) {
  return { headers } as any;
}

function fakeRes() {
  const res: any = { statusCode: 0, body: undefined };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: unknown) => { res.body = b; return res; };
  return res;
}

/** Runs the middleware and reports whether it called next(). */
async function run(mw: any, req: any) {
  const res = fakeRes();
  let passed = false;
  await mw(req, res, () => { passed = true; });
  return { passed, status: res.statusCode, req };
}

beforeEach(() => { delete process.env.DEMO_MODE; });
afterEach(() => {
  if (realDemo === undefined) delete process.env.DEMO_MODE;
  else process.env.DEMO_MODE = realDemo;
});

test('demo mode is off unless DEMO_MODE is exactly "1"', () => {
  assert.equal(isDemoModeEnabled(), false);
  for (const v of ['0', 'true', 'yes', '', 'TRUE']) {
    process.env.DEMO_MODE = v;
    assert.equal(isDemoModeEnabled(), false, `"${v}" must not enable demo mode`);
  }
  process.env.DEMO_MODE = '1';
  assert.equal(isDemoModeEnabled(), true);
});

test('the demo header alone does not open the route — the deployment must opt in', async () => {
  const { passed, status } = await run(requireAuthOrDemo, fakeReq({ [DEMO_HEADER]: '1' }));
  assert.equal(passed, false);
  assert.equal(status, 401);
});

test('DEMO_MODE alone does not open the route — the client must ask', async () => {
  process.env.DEMO_MODE = '1';
  const { passed, status } = await run(requireAuthOrDemo, fakeReq());
  assert.equal(passed, false);
  assert.equal(status, 401);
});

test('both conditions together admit the request and mark it as demo', async () => {
  process.env.DEMO_MODE = '1';
  const { passed, req } = await run(requireAuthOrDemo, fakeReq({ [DEMO_HEADER]: '1' }));
  assert.equal(passed, true);
  assert.equal(req.demo, true, 'handlers must be able to tell demo from authenticated');
});

test('only "1" counts as asking for demo', async () => {
  process.env.DEMO_MODE = '1';
  for (const v of ['0', 'true', 'yes', '']) {
    const { passed } = await run(requireAuthOrDemo, fakeReq({ [DEMO_HEADER]: v }));
    assert.equal(passed, false, `header "${v}" must not admit`);
  }
});

test('requireAuth never admits a demo request, even fully enabled', async () => {
  process.env.DEMO_MODE = '1';
  const { passed, status } = await run(requireAuth, fakeReq({ [DEMO_HEADER]: '1' }));
  assert.equal(passed, false, 'paid/metered routes must stay closed to demo traffic');
  assert.equal(status, 401);
});

test('an unauthenticated request with no demo header is 401 exactly as before', async () => {
  for (const demoMode of [undefined, '1']) {
    if (demoMode) process.env.DEMO_MODE = demoMode; else delete process.env.DEMO_MODE;
    const { passed, status } = await run(requireAuthOrDemo, fakeReq());
    assert.equal(passed, false);
    assert.equal(status, 401);
  }
});

/**
 * MERGE-INTEGRATION REGRESSION — demo mode reintroduced the 401/503 conflation
 * that finding #28 fixed on `requireAuth`.
 *
 * `requireAuthOrDemo` arrived on a branch that predated the #28 fix, so it
 * ended with a bare `res.status(401)`. That means a user holding a perfectly
 * valid session, arriving while Supabase is unreachable, is told they are
 * "Unauthorized" — sent to reset a credential that works, while the dashboard
 * shows a spike in auth failures during what is actually an outage.
 *
 * Neither branch was wrong on its own. The defect only exists in the merge,
 * which is exactly the kind a "no conflict markers left" resolution misses.
 */
test('requireAuthOrDemo reports an auth outage as 503, not 401', async () => {
  delete process.env.DEMO_MODE;
  const req = fakeReq();
  // What optionalAuth sets when verification could not reach a verdict.
  req.authUnavailable = 'supabase unreachable';

  const r = await run(requireAuthOrDemo, req);
  assert.equal(r.passed, false, 'an outage must still refuse the request');
  assert.equal(r.status, 503, 'an outage is not a credential failure');
});

test('a plain unauthenticated request is still 401, not 503', async () => {
  // Proves the test above is discriminating: without authUnavailable the
  // answer must remain 401, or "503 everywhere" would pass it vacuously.
  delete process.env.DEMO_MODE;
  const r = await run(requireAuthOrDemo, fakeReq());
  assert.equal(r.passed, false);
  assert.equal(r.status, 401);
});

test('an auth outage does not take demo mode down with it', async () => {
  // Demo admission does not depend on the identity provider, so it must be
  // decided before the outage branch. If the order were reversed, enabling
  // demo mode would still 503 during a Supabase incident — the one time a
  // no-login path is most useful.
  process.env.DEMO_MODE = '1';
  const req = fakeReq({ [DEMO_HEADER]: '1' });
  req.authUnavailable = 'supabase unreachable';

  const r = await run(requireAuthOrDemo, req);
  assert.equal(r.passed, true, 'demo must survive an identity-provider outage');
  assert.equal(r.req.demo, true);
});
