import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { runSetupReplay, stableStringify, configRefusals } from '../src/research/setupReplay';

const FIX = join(__dirname, 'fixtures', 'bars');
const csv = { SPY: readFileSync(join(FIX, 'SYNTHETIC_SPY_1m.csv'), 'utf8'), QQQ: readFileSync(join(FIX, 'SYNTHETIC_QQQ_1m.csv'), 'utf8') };
const config = JSON.parse(readFileSync(join(FIX, 'replay.config.json'), 'utf8'));

test('a replay is byte-identical on a second run', () => {
  const a = stableStringify(runSetupReplay({ config, csv }));
  const b = stableStringify(runSetupReplay({ config, csv }));
  assert.equal(a, b);
  assert.match(a, /"status": "OK"/);
});

test('the CLI writes the same bytes twice', () => {
  const dir = mkdtempSync(join(tmpdir(), 'replay-'));
  const run = (out: string) => execFileSync(process.execPath, ['--import', 'tsx', join(__dirname, '..', 'tools', 'research', 'setupReplay.ts'),
    '--config', join(FIX, 'replay.config.json'), '--csv', `SPY=${join(FIX, 'SYNTHETIC_SPY_1m.csv')}`,
    '--csv', `QQQ=${join(FIX, 'SYNTHETIC_QQQ_1m.csv')}`, '--out', out], { cwd: join(__dirname, '..') });
  run(join(dir, 'a.json')); run(join(dir, 'b.json'));
  assert.equal(readFileSync(join(dir, 'a.json'), 'utf8'), readFileSync(join(dir, 'b.json'), 'utf8'));
});

test('the report carries hashes, versions and counts; no P&L, and no rate below the sample floor', () => {
  const r = runSetupReplay({ config, csv });
  assert.equal(r.status, 'OK');
  if (r.status !== 'OK') return;
  const rep = r.report as Record<string, any>;
  assert.match(rep.configHash, /^[0-9a-f]{64}$/);
  assert.equal(rep.datasets.length, 2);
  for (const d of rep.datasets) { assert.match(d.contentId, /^[0-9a-f]{64}$/); assert.equal(d.provenance, 'USER_IMPORT'); }
  assert.equal(typeof rep.setupMethodVersion, 'string');
  assert.equal(typeof rep.structureMethodVersion, 'string');
  assert.match(rep.scope, /Not P&L/);
  const total = Object.values(rep.counts.byTerminalState as Record<string, number>).reduce((a, b) => a + b, 0);
  assert.equal(total, rep.counts.ideas);
  const text = JSON.stringify(rep);
  for (const banned of ['"pnl"', '"winRate"', '"profit"']) assert.ok(!text.includes(banned), banned);
  const sum = rep.outcomes.summary;
  if (sum.decided < 30) { assert.equal(sum.hitRate, null); assert.equal(sum.meanR, null); assert.match(sum.suppressed, /INSUFFICIENT_SAMPLE/); }
  assert.equal(rep.outcomes.ideas.length, rep.counts.ideas);
});

test('a missing cost, a missing timestamp convention or a missing file is refused, never defaulted', () => {
  assert.ok(configRefusals({ ...config, costs: {} }).some((x) => x.includes('roundTripPerUnit')));
  assert.ok(configRefusals({ ...config, timestampMarks: undefined }).some((x) => x.includes('timestampMarks')));
  const r = runSetupReplay({ config, csv: { SPY: csv.SPY } });
  assert.equal(r.status, 'REFUSED');
});

test('a changed config changes the config hash', () => {
  const a = runSetupReplay({ config, csv });
  const b = runSetupReplay({ config: { ...config, costs: { roundTripPerUnit: 0.03 } }, csv });
  assert.ok(a.status === 'OK' && b.status === 'OK');
  if (a.status === 'OK' && b.status === 'OK') assert.notEqual(a.report.configHash, b.report.configHash);
});
