/**
 * Bar-import preflight (NEXT_UPGRADES #2): what a CSV holds, read by the
 * replay's own parser, before any replay runs over it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { preflightBars, rejectCode, rthMinutesBetween, REJECT_CODES } from '../src/market/barPreflight';
import { importBarsCsv } from '../src/market/barImport';
import setupsRouter from '../src/routes/setups';

const FIX = join(__dirname, 'fixtures', 'bars');
const SPY = readFileSync(join(FIX, 'SYNTHETIC_SPY_1m.csv'), 'utf8');
const HEADER = 'timestamp,open,high,low,close,volume';

/** One-minute bars from an ET-offset ISO start, `n` of them. */
function bars(startIso: string, n: number, skip: (i: number) => boolean = () => false): string[] {
  const t0 = Date.parse(startIso);
  const out: string[] = [];
  for (let i = 0; i < n; i++) if (!skip(i)) out.push(`${new Date(t0 + i * 60_000).toISOString()},10,11,9,10.5,100`);
  return out;
}
const csvOf = (rows: string[]) => [HEADER, ...rows].join('\n') + '\n';

test('the synthetic fixture: three full regular sessions, nothing rejected, no RTH minute missing', () => {
  const p = preflightBars('SPY', SPY, 'OPEN');
  assert.equal(p.status, 'OK');
  assert.equal(p.keptBars, 1170);
  assert.deepEqual(p.days.map((d) => [d.date, d.session, d.rthBars, d.rthMinutes, d.rthCoverage, d.outsideRthBars]), [
    ['2026-01-05', 'REGULAR', 390, 390, 1, 0],
    ['2026-01-06', 'REGULAR', 390, 390, 1, 0],
    ['2026-01-07', 'REGULAR', 390, 390, 1, 0],
  ]);
  assert.equal(p.gaps.count, 2);
  assert.equal(p.gaps.missingMinutes, 2100);
  assert.equal(p.gaps.insideRthMinutes, 0, 'the overnight gaps are outside the regular session');
  assert.deepEqual(p.warnings, []);
});

test('it is the replay\'s parser: kept bars, rejected rows and gaps agree with importBarsCsv', () => {
  const text = csvOf([...bars('2026-01-05T14:30:00Z', 20, (i) => i === 7), 'garbage,1,2', bars('2026-01-05T14:31:00Z', 1)[0]]);
  const imp = importBarsCsv(text, { symbol: 'SPY', timestampMarks: 'OPEN', source: 'x' });
  const p = preflightBars('SPY', text, 'OPEN');
  assert.ok(imp.status === 'OK');
  assert.equal(p.keptBars, imp.bars.length);
  assert.equal(p.rejectedRows, imp.rejected.length);
  assert.equal(p.gaps.count, imp.gaps.length);
  const src = readFileSync(join(__dirname, '..', 'src', 'market', 'barPreflight.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  assert.match(src, /importBarsCsv\(/);
  assert.doesNotMatch(src, /Date\.parse|split\(','\)|parseZonedTimestamp/, 'no second parser');
});

test('rejected rows are grouped by reason, a row counted once per kind', () => {
  const ok = bars('2026-01-05T14:30:00Z', 6);
  const text = csvOf([
    ok[0], ok[1],
    ok[1],                                         // duplicate
    ok[0],                                         // out of order
    '2026-01-05T14:33:00Z,10,11',                  // cell count
    '2026-01-05 14:33,10,11,9,10.5,1',             // timestamp, no zone
    '2026-01-05T14:33:00Z,ten,11,9,10.5,1',        // not decimal
    '2026-01-05T14:33:30Z,10,11,9,10.5,1',         // off minute
    '2026-01-05T14:34:00Z,10,9,9,10.5,1',          // bar shape: h below max(o,c)
    '2026-01-05T14:35:00Z,x,y,9,10.5,1',           // two NOT_DECIMAL reasons, one row
    ok[5],
  ]);
  const p = preflightBars('SPY', text, 'OPEN');
  const by = Object.fromEntries(p.rejectedByCode.map((g) => [g.code, g.rows]));
  assert.deepEqual(by, { CELL_COUNT: 1, TIMESTAMP: 1, NOT_DECIMAL: 2, OFF_MINUTE: 1, BAR_SHAPE: 1, DUPLICATE: 1, OUT_OF_ORDER: 1 });
  assert.equal(p.duplicates, 1);
  assert.equal(p.outOfOrder, 1);
  assert.equal(p.rejectedRows, 8);
  assert.ok(p.rejectedByCode.every((g) => g.firstLines.length > 0 && g.example.length > 0));
  assert.match(p.warnings.join(' '), /8 rows were rejected/);
});

test('every reason the parser can write has a code other than OTHER', () => {
  const reasons = [
    'has 3 cells, header has 6', 'timestamp "x" is neither epoch ms nor ISO-8601 with a zone',
    'timestamp "2026-02-30T00:00Z" is not a real calendar instant', 'timestamp "x" has an impossible offset',
    'timestamp is not on a minute boundary', 'open "x" is not a decimal number', 'volume "x" is not a decimal number',
    'duplicates the minute 2026-01-05T14:30:00.000Z', 'is out of order: a is before b',
    'o is not a positive price', 'h 9 is below max(o, c) 10.5', 'l 11 is above min(o, c) 10', 'c is not a finite number',
    'v must be null or a finite, non-negative number',
  ];
  for (const r of reasons) assert.notEqual(rejectCode(r), 'OTHER', r);
  assert.equal(rejectCode('timestamp is not on a minute boundary'), 'OFF_MINUTE');
  assert.equal(rejectCode('something new'), 'OTHER');
  assert.equal(REJECT_CODES[REJECT_CODES.length - 1], 'OTHER');
});

test('missing regular-session minutes are counted, and a thin day is named', () => {
  // 2026-01-05 09:30 ET = 14:30Z; drop 30 minutes in the morning.
  const p = preflightBars('SPY', csvOf(bars('2026-01-05T14:30:00Z', 390, (i) => i >= 60 && i < 90)), 'OPEN');
  assert.equal(p.gaps.insideRthMinutes, 30);
  assert.equal(p.days[0].rthBars, 360);
  assert.equal(p.days[0].rthCoverage, 360 / 390);
  assert.match(p.warnings.join(' '), /30 minutes of the published regular session are missing/);
  assert.match(p.warnings.join(' '), /Under 95% of the regular session on 2026-01-05/);
});

test('bars on a holiday or weekend are named, not dropped', () => {
  const p = preflightBars('SPY', csvOf([...bars('2026-01-10T15:00:00Z', 3), ...bars('2026-01-19T15:00:00Z', 2)]), 'OPEN');
  assert.deepEqual(p.days.map((d) => [d.date, d.session, d.bars, d.rthBars, d.outsideRthBars]), [
    ['2026-01-10', 'WEEKEND', 3, 0, 3],
    ['2026-01-19', 'HOLIDAY', 2, 0, 2],
  ]);
  assert.equal(p.keptBars, 5);
  assert.match(p.warnings.join(' '), /2026-01-10 \(WEEKEND\), 2026-01-19 \(HOLIDAY\)/);
});

test('a half day is measured against its published 13:00 close', () => {
  const p = preflightBars('SPY', csvOf(bars('2026-11-27T14:30:00Z', 240)), 'OPEN');
  assert.equal(p.days[0].session, 'EARLY_CLOSE');
  assert.equal(p.days[0].rthMinutes, 210);
  assert.equal(p.days[0].rthBars, 210);
  assert.equal(p.days[0].outsideRthBars, 30);
});

test('past the calendar\'s coverage nothing is assumed', () => {
  const p = preflightBars('SPY', csvOf([...bars('2028-03-01T14:30:00Z', 2), ...bars('2028-03-02T14:30:00Z', 2)]), 'OPEN');
  assert.equal(p.days[0].session, 'UNKNOWN');
  assert.equal(p.days[0].rthBars, null);
  assert.equal(p.days[0].rthCoverage, null);
  assert.equal(p.gaps.insideRthMinutes, null);
  assert.match(p.warnings.join(' '), /cannot answer for 2028-03-01, 2028-03-02/);
});

test('the timestamp convention is applied: CLOSE marks shift every bar back a minute', () => {
  const p = preflightBars('SPY', csvOf(bars('2026-01-05T14:31:00Z', 390)), 'CLOSE');
  assert.equal(p.days[0].rthBars, 390);
  assert.equal(p.coverage!.firstTOpen, Date.parse('2026-01-05T14:30:00Z'));
});

test('rthMinutesBetween walks dates, so a long gap is cheap and exact', () => {
  const t0 = Date.now();
  // 2026-01-05 16:00 ET to 2026-01-07 09:30 ET: one full session (390) between.
  assert.equal(rthMinutesBetween(Date.parse('2026-01-05T21:00:00Z'), Date.parse('2026-01-07T14:30:00Z')), 390);
  assert.equal(rthMinutesBetween(Date.parse('2026-01-02T00:00:00Z'), Date.parse('2026-12-31T00:00:00Z'))! > 90_000, true);
  assert.equal(rthMinutesBetween(Date.parse('2026-12-01T00:00:00Z'), Date.parse('2028-01-02T00:00:00Z')), null);
  assert.ok(Date.now() - t0 < 2000);
});

test('a refused file says why and keeps nothing', () => {
  const p = preflightBars('SPY', 'when,open\n1,2\n', 'OPEN');
  assert.equal(p.status, 'REFUSED');
  assert.ok(p.refused.some((r) => /missing column timestamp/.test(r)));
  assert.equal(p.keptBars, 0);
});

async function post(path: string, body: unknown): Promise<{ status: number; json: any }> {
  const app = express();
  app.use('/api/setups', setupsRouter);
  const server = app.listen(0);
  try {
    const { port } = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}/api/setups${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, json: await res.json() };
  } finally { server.close(); }
}

test('POST /preflight: one report per symbol, the convention has no default, a non-symbol key is refused', async () => {
  const ok = await post('/preflight', { config: { timestampMarks: 'OPEN', costs: { roundTripPerUnit: 0 } }, csv: { SPY } });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.kind, 'BAR_PREFLIGHT');
  assert.deepEqual(ok.json.symbols.map((s: any) => [s.symbol, s.keptBars]), [['SPY', 1170]]);
  assert.deepEqual(JSON.parse(JSON.stringify(preflightBars('SPY', SPY, 'OPEN'))), ok.json.symbols[0]);
  const noMarks = await post('/preflight', { config: {}, csv: { SPY } });
  assert.equal(noMarks.status, 400);
  assert.match(noMarks.json.reasons.join(' '), /timestampMarks/);
  const bad = await post('/preflight', { config: { timestampMarks: 'OPEN' }, csv: { 'spy qqq': SPY } });
  assert.equal(bad.status, 400);
  assert.match(bad.json.reasons.join(' '), /not a symbol/);
  const none = await post('/preflight', { config: { timestampMarks: 'OPEN' }, csv: {} });
  assert.equal(none.status, 400);
});
