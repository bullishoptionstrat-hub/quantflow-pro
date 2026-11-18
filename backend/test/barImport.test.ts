import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { importBarsCsv } from '../src/market/barImport';
import { syntheticCsv } from '../tools/fixtures/syntheticBars';

const opts = { symbol: 'SPY', timestampMarks: 'OPEN' as const, source: 'test' };
const H = 'timestamp,open,high,low,close,volume';
const ok = (r: ReturnType<typeof importBarsCsv>) => { assert.equal(r.status, 'OK'); return r as Extract<typeof r, { status: 'OK' }>; };

test('a clean file imports, volume missing is null not zero, content id is the sha256', () => {
  const r = ok(importBarsCsv(`${H}\n2026-01-05T14:30:00Z,10,11,9,10.5,100\n2026-01-05T14:31:00Z,10.5,11,10,10.8,\n`, opts));
  assert.equal(r.bars.length, 2);
  assert.equal(r.bars[1].v, null);
  assert.equal(r.bars[0].closedAt - r.bars[0].tOpen, 60_000);
  assert.equal(r.provenance, 'USER_IMPORT');
  assert.match(r.contentId, /^[0-9a-f]{64}$/);
  assert.deepEqual(r.gaps, []);
});

test('timestampMarks CLOSE shifts the bar back one minute; anything else is refused', () => {
  const r = ok(importBarsCsv(`${H}\n2026-01-05T14:31:00Z,10,11,9,10.5,100\n`, { ...opts, timestampMarks: 'CLOSE' }));
  assert.equal(r.bars[0].tOpen, Date.parse('2026-01-05T14:30:00Z'));
  assert.equal(importBarsCsv(`${H}\n`, { ...opts, timestampMarks: 'X' as never }).status, 'REFUSED');
});

test('a naive local timestamp is rejected, never assumed to be New York', () => {
  const r = ok(importBarsCsv(`${H}\n2026-01-05 09:30,10,11,9,10.5,100\n`, opts));
  assert.equal(r.bars.length, 0);
  assert.equal(r.rejected[0].line, 2);
  assert.match(r.rejected[0].reasons[0], /zone/);
});

test('bad prices, duplicates and out-of-order rows are rejected by line, not repaired', () => {
  const r = ok(importBarsCsv([H,
    '2026-01-05T14:30:00Z,10,11,9,10.5,100',
    '2026-01-05T14:31:00Z,10,9,11,10.5,100',   // high below low
    '2026-01-05T14:30:00Z,10,11,9,10.5,100',   // duplicate
    '2026-01-05T14:33:00Z,10,11,9,10.5,100',
    '2026-01-05T14:32:00Z,10,11,9,10.5,100',   // out of order
    '2026-01-05T14:34:00Z,abc,11,9,10.5,100',
  ].join('\n'), opts));
  assert.deepEqual(r.rejected.map((x) => x.line), [3, 4, 6, 7]);
  assert.equal(r.bars.length, 2);
  assert.match(r.rejected[1].reasons[0], /duplicates/);
  assert.match(r.rejected[2].reasons[0], /out of order/);
});

test('gaps are reported and never filled', () => {
  const r = ok(importBarsCsv(`${H}\n2026-01-05T14:30:00Z,10,11,9,10.5,1\n2026-01-05T14:34:00Z,10,11,9,10.5,1\n`, opts));
  assert.equal(r.bars.length, 2);
  assert.deepEqual(r.gaps.map((g) => g.missingMinutes), [3]);
});

test('an unknown or missing column refuses the file', () => {
  assert.equal(importBarsCsv('timestamp,open,high,low,close,vwap\n', opts).status, 'REFUSED');
  assert.equal(importBarsCsv('timestamp,open,high,close\n', opts).status, 'REFUSED');
  assert.equal(importBarsCsv(`${H}\n`, { ...opts, source: '' }).status, 'REFUSED');
});

test('the committed synthetic fixtures are the generator output, byte for byte, and import clean', () => {
  const dir = join(__dirname, 'fixtures', 'bars');
  const days = ['2026-01-05', '2026-01-06', '2026-01-07'];
  for (const [file, seed, base, sym] of [['SYNTHETIC_SPY_1m.csv', 1101, 590, 'SPY'], ['SYNTHETIC_QQQ_1m.csv', 2202, 520, 'QQQ']] as const) {
    const text = readFileSync(join(dir, file), 'utf8');
    assert.equal(text, syntheticCsv(seed, base, days), `${file} was edited by hand`);
    const r = ok(importBarsCsv(text, { symbol: sym, timestampMarks: 'OPEN', source: 'synthetic' }));
    assert.equal(r.bars.length, 390 * 3);
    assert.equal(r.rejected.length, 0);
    assert.ok(r.bars.some((b) => b.v === null));
  }
});
