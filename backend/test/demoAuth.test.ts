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
