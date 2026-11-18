/**
 * The read-only structure replay (/structure): the CLI and the route are one
 * function, nothing has a default, nothing is invented, and a prefix of the
 * file never learns something the whole file had not yet made knowable.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import express from 'express';
import type { AddressInfo } from 'node:net';
import setupsRouter from '../src/routes/setups';
import { runStructureReplay } from '../src/research/structureReplay';
import { stableStringify } from '../src/research/setupReplay';
import { structureFixtureInput, structureFixtureText } from '../tools/fixtures/structureFixture';

const FIX = join(__dirname, 'fixtures');
const input = structureFixtureInput();
const config = input.config as Record<string, unknown>;

async function post(body: unknown): Promise<{ status: number; json: any }> {
  const app = express();
  app.use('/api/setups', setupsRouter);
  const server = app.listen(0);
  try {
    const { port } = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}/api/setups/structure`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, json: await res.json() };
  } finally { server.close(); }
}

test('the committed fixture is what the engine produces today', () => {
  assert.equal(readFileSync(join(FIX, 'structureReplay.json'), 'utf8'), structureFixtureText());
});

test('the route returns exactly what the CLI function returns', async () => {
  const r = await post(input);
  assert.equal(r.status, 200);
  assert.equal(stableStringify(r.json), stableStringify(runStructureReplay(input)));
});

test('the same input gives byte-identical output', () => {
  assert.equal(stableStringify(runStructureReplay(input)), stableStringify(runStructureReplay(input)));
});

test('the timestamp convention has no default', async () => {
  const { timestampMarks: _t, ...noMarks } = config;
  const r = await post({ config: noMarks, csv: input.csv });
  assert.equal(r.status, 400);
  assert.ok(r.json.reasons.some((x: string) => x.startsWith('config.timestampMarks')));
});

test('a missing file, an unnamed file, a pair equal to the symbol and an unknown field are each refused by name', () => {
  const a = runStructureReplay({ config, csv: { SPY: input.csv.SPY! } });
  assert.deepEqual(a.status === 'REFUSED' && a.reasons, ['csv: no file supplied for QQQ']);
  const b = runStructureReplay({ config: { symbol: 'SPY', timestampMarks: 'OPEN' }, csv: input.csv });
  assert.ok(b.status === 'REFUSED' && b.reasons.includes('csv.QQQ: not named in config'));
  const c = runStructureReplay({ config: { symbol: 'SPY', pairSymbol: 'SPY', timestampMarks: 'OPEN' }, csv: { SPY: input.csv.SPY! } });
  assert.ok(c.status === 'REFUSED' && c.reasons.includes('config.pairSymbol: must differ from config.symbol'));
  const d = runStructureReplay({ config: { ...config, costs: 1 }, csv: input.csv });
  assert.ok(d.status === 'REFUSED' && d.reasons.includes('config.costs: unknown field'));
  const e = runStructureReplay({ config: { ...config, params: { swingStrength: 0 } }, csv: input.csv });
  assert.equal(e.status, 'REFUSED');
});

test('without a pair there is no SMT event, and the report says SMT was not computed', () => {
  const r = runStructureReplay({ config: { symbol: 'SPY', timestampMarks: 'OPEN' }, csv: { SPY: input.csv.SPY! } });
  assert.equal(r.status, 'OK');
  const rep = (r as any).report;
  assert.equal(rep.pairSymbol, null);
  assert.ok(!rep.events.some((e: any) => e.kind.startsWith('SMT')));
  assert.ok(rep.notComputed.some((n: any) => n.name === 'SMT' && n.status === 'UNMEASURABLE'));
  const withPair = (runStructureReplay(input) as any).report;
  assert.ok(withPair.events.some((e: any) => e.kind === 'SMT_DIVERGENCE'));
  assert.ok(!withPair.notComputed.some((n: any) => n.name === 'SMT'));
});

test('every event is knowable from its own citations, and counts match the events', () => {
  const rep = (runStructureReplay(input) as any).report;
  assert.ok(rep.events.length > 0);
  for (const e of rep.events) {
    assert.ok(e.knownAt <= rep.asOf);
    for (const b of e.evidence) assert.ok(e.knownAt >= b.closedAt, `${e.id} cites a bar closing after it`);
  }
  const byKind: Record<string, number> = {};
  for (const e of rep.events) byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;
  assert.deepEqual(rep.counts.byKind, byKind);
  assert.equal(rep.counts.events, rep.events.length);
  assert.match(rep.scope, /untuned, versioned hypothesis/);
});

test('a prefix of the files reports exactly the whole run cut at the prefix close', () => {
  const full = (runStructureReplay(input) as any).report;
  const cut = (t: string, n: number) => t.split('\n').slice(0, n + 1).join('\n') + '\n';
  for (const n of [60, 200]) {
    const pre = (runStructureReplay({ config, csv: { SPY: cut(input.csv.SPY!, n), QQQ: cut(input.csv.QQQ!, n) } }) as any).report;
    const expect = full.events.filter((e: any) => e.knownAt <= pre.asOf);
    assert.deepEqual(pre.events.map((e: any) => e.id).sort(), expect.map((e: any) => e.id).sort(), `prefix ${n}`);
  }
});
