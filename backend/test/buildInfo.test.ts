/**
 * `/api/health` names the commit Render built, or says it cannot.
 *
 * It used to publish `version: '1.0.0'`, which no deploy changed, so nothing
 * could answer "is the merged fix running?". The rule tested here: the commit
 * comes from `RENDER_GIT_COMMIT` alone, and anything missing or malformed is
 * `unknown` with a reason, never a guess and never the raw value echoed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { buildInfo } from '../src/buildInfo';
import healthRouter from '../src/routes/health';

const SHA = 'a9fe7e78ba0d584cb37b10248e73bf099335ffec';

test('a full SHA from Render is reported, with its short form and source', () => {
  assert.deepEqual(buildInfo({ RENDER_GIT_COMMIT: SHA }), {
    state: 'reported', commit: SHA, shortCommit: 'a9fe7e7', source: 'RENDER_GIT_COMMIT',
  });
});

test('surrounding whitespace and upper case are normalised, not refused', () => {
  const b = buildInfo({ RENDER_GIT_COMMIT: `  ${SHA.toUpperCase()}\n` });
  assert.equal(b.state, 'reported');
  assert.equal(b.commit, SHA);
});

test('no variable is unknown, with a reason, and no commit is invented', () => {
  for (const env of [{}, { RENDER_GIT_COMMIT: '' }, { RENDER_GIT_COMMIT: '   ' }]) {
    const b = buildInfo(env);
    assert.equal(b.state, 'unknown');
    assert.equal(b.commit, null);
    assert.equal(b.shortCommit, null);
    assert.match((b as { reason: string }).reason, /RENDER_GIT_COMMIT is not set/);
  }
});

test('a malformed value is unknown and is not echoed onto the public route', () => {
  for (const bad of ['main', 'a9fe7e7', `${SHA}0`, 'zzzz'.repeat(10), 'sk_live_not_a_commit_at_all_0123456789abcdef']) {
    const b = buildInfo({ RENDER_GIT_COMMIT: bad });
    assert.equal(b.state, 'unknown', bad);
    assert.equal(b.commit, null);
    assert.ok(!JSON.stringify(b).includes(bad), `the value ${bad} must not appear in the payload`);
  }
});

async function readHealth(): Promise<Record<string, unknown>> {
  const app = express();
  app.use('/api/health', healthRouter);
  const server = app.listen(0);
  try {
    await new Promise<void>((r) => server.once('listening', () => r()));
    const { port } = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}/api/health`);
    assert.equal(res.status, 200);
    return (await res.json()) as Record<string, unknown>;
  } finally {
    server.close();
  }
}

test('the real route publishes the build block and no hardcoded version', async () => {
  const before = process.env.RENDER_GIT_COMMIT;
  try {
    process.env.RENDER_GIT_COMMIT = SHA;
    const body = await readHealth();
    assert.equal('version' in body, false, 'the hardcoded version is gone');
    assert.deepEqual(body.build, { state: 'reported', commit: SHA, shortCommit: 'a9fe7e7', source: 'RENDER_GIT_COMMIT' });

    delete process.env.RENDER_GIT_COMMIT;
    const unknown = await readHealth();
    assert.equal((unknown.build as { state: string }).state, 'unknown');
  } finally {
    if (before === undefined) delete process.env.RENDER_GIT_COMMIT;
    else process.env.RENDER_GIT_COMMIT = before;
  }
});
