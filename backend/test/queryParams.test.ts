/**
 * Query parameters the caller controls take the route's default when absent,
 * repeated or unreadable, and are clamped into range.
 *
 * Measured against the old parsing: `?limit=-5` returned every row but the
 * last five (past the cap) with a negative page count, and a repeated
 * `?symbol=` answered 500 because `.toUpperCase()` was called on an array.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { queryInt, queryNonNegative, queryString } from '../src/routes/queryParams';
import flowRouter from '../src/routes/flow';
import darkpoolRouter from '../src/routes/darkpool';
import gexRouter from '../src/routes/gex';

test('queryInt: absent, repeated, unreadable or fractional take the default; numbers are clamped', () => {
  assert.equal(queryInt(undefined, 50, 1, 200), 50);
  assert.equal(queryInt(['5', '6'], 50, 1, 200), 50);
  assert.equal(queryInt('abc', 50, 1, 200), 50);
  assert.equal(queryInt('2.5', 50, 1, 200), 50);
  assert.equal(queryInt('-5', 50, 1, 200), 1);
  assert.equal(queryInt('0', 50, 1, 200), 1);
  assert.equal(queryInt('9999', 50, 1, 200), 200);
  assert.equal(queryInt('20', 50, 1, 200), 20);
});

test('queryString and queryNonNegative refuse arrays and bad numbers', () => {
  assert.equal(queryString(['a', 'b']), undefined);
  assert.equal(queryString(''), undefined);
  assert.equal(queryString('spy'), 'spy');
  assert.equal(queryNonNegative('-100', 0), 0);
  assert.equal(queryNonNegative('Infinity', 0), 0);
  assert.equal(queryNonNegative('1000000', 0), 1_000_000);
});

async function withServer<T>(fn: (base: string) => Promise<T>): Promise<T> {
  const app = express();
  app.use('/api/flow', flowRouter);
  app.use('/api/darkpool', darkpoolRouter);
  app.use('/api/gex', gexRouter);
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const { port } = server.address() as AddressInfo;
  try { return await fn(`http://127.0.0.1:${port}`); }
  finally { await new Promise((r) => server.close(r)); }
}

test('the routes answer a repeated parameter instead of failing with 500', async () => {
  await withServer(async (base) => {
    for (const path of [
      '/api/flow?symbol=SPY&symbol=QQQ',
      '/api/flow/unusual?symbol=SPY&symbol=QQQ',
      '/api/darkpool?symbol=SPY&symbol=QQQ',
      '/api/gex?symbol=SPY&symbol=QQQ',
    ]) {
      const res = await fetch(base + path);
      assert.equal(res.status, 200, path);
    }
  });
});

test('a negative limit is clamped, so the pagination it reports is not negative', async () => {
  await withServer(async (base) => {
    const body = await (await fetch(`${base}/api/flow?limit=-5`)).json() as any;
    assert.equal(body.pagination.limit, 1);
    assert.ok(body.pagination.pages >= 0);
    assert.ok(body.data.length <= 1);
  });
});
