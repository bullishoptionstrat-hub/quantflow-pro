/**
 * POST /api/setups/replay, driven over HTTP against the real router.
 *
 * The route must be the CLI's replay and nothing else: the same bytes for the
 * fixture, the same refusals by name, no defaults, a body cap, no store writes,
 * and the plain `requireAuth` tier (it parses user uploads and runs the engines,
 * so the demo tier must never reach it).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import express from 'express';
import type { AddressInfo } from 'node:net';
import setupsRouter, { SETUP_REPLAY_MAX_BYTES } from '../src/routes/setups';
import { runSetupReplay, stableStringify } from '../src/research/setupReplay';

const FIX = join(__dirname, 'fixtures', 'bars');
const csv = { SPY: readFileSync(join(FIX, 'SYNTHETIC_SPY_1m.csv'), 'utf8'), QQQ: readFileSync(join(FIX, 'SYNTHETIC_QQQ_1m.csv'), 'utf8') };
const config = JSON.parse(readFileSync(join(FIX, 'replay.config.json'), 'utf8'));

async function post(body: string): Promise<{ status: number; json: any }> {
  const app = express();
  app.use('/api/setups', setupsRouter);
  const server = app.listen(0);
  try {
    const { port } = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}/api/setups/replay`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    return { status: res.status, json: await res.json() };
  } finally { server.close(); }
}

test('the route returns exactly what the CLI replay returns for the fixture', async () => {
  const r = await post(JSON.stringify({ config, csv }));
  assert.equal(r.status, 200);
  assert.equal(r.json.status, 'OK');
  assert.equal(stableStringify(r.json), stableStringify(runSetupReplay({ config, csv })));
});

test('missing costs are refused by name, never defaulted', async () => {
  const { costs: _c, ...noCosts } = config;
  const r = await post(JSON.stringify({ config: noCosts, csv }));
  assert.equal(r.status, 400);
  assert.equal(r.json.status, 'REFUSED');
  assert.ok(r.json.reasons.some((x: string) => x.startsWith('config.costs.roundTripPerUnit')));
});

test('a missing timestamp convention is refused by name', async () => {
  const { timestampMarks: _t, ...noMarks } = config;
  const r = await post(JSON.stringify({ config: noMarks, csv }));
  assert.equal(r.status, 400);
  assert.ok(r.json.reasons.some((x: string) => x.startsWith('config.timestampMarks')));
});

test('a missing CSV, a non-string CSV and an unknown field are each named', async () => {
  const r1 = await post(JSON.stringify({ config, csv: { SPY: csv.SPY } }));
  assert.equal(r1.status, 400);
  assert.ok(r1.json.reasons.includes('csv: no file supplied for QQQ'));
  const r2 = await post(JSON.stringify({ config, csv: { SPY: csv.SPY, QQQ: 7 }, extra: 1 }));
  assert.equal(r2.status, 400);
  assert.ok(r2.json.reasons.includes('body.csv.QQQ: must be CSV text'));
  assert.ok(r2.json.reasons.includes('body.extra: unknown field'));
  const r3 = await post('{not json');
  assert.equal(r3.status, 400);
  assert.deepEqual(r3.json.reasons, ['body: not valid JSON']);
});

test('a body over the cap is refused with 413 and a named reason', async () => {
  const big = 'x'.repeat(SETUP_REPLAY_MAX_BYTES + 1);
  const r = await post(JSON.stringify({ config, csv: { SPY: big, QQQ: csv.QQQ } }));
  assert.equal(r.status, 413);
  assert.match(r.json.reasons[0], /larger than/);
});

test('the route and the replay write nothing: no store, file or persistence import', () => {
  for (const f of ['src/routes/setups.ts', 'src/research/setupReplay.ts']) {
    const src = readFileSync(join(__dirname, '..', f), 'utf8');
    assert.doesNotMatch(src, /persistence|getStore|supabase|writeFile|appendFile|localStorage/i, f);
  }
});

test('the route is mounted on requireAuth, ahead of the global JSON parser, never the demo tier', () => {
  const server = readFileSync(join(__dirname, '..', 'src', 'server.ts'), 'utf8');
  const mount = server.match(/app\.use\('\/api\/setups'[^\n]*/);
  assert.ok(mount, 'the setups router is mounted');
  assert.match(mount[0], /requireAuth,/);
  assert.doesNotMatch(mount[0], /requireAuthOrDemo|limitDemoTraffic/);
  assert.ok(server.indexOf(mount[0]) < server.indexOf("app.use(express.json("), 'mounted before the global parser');
});
