/**
 * F-24: the Polygon options poll could never produce a print, so it is not
 * started, and it says so.
 *
 * It polled `/v3/trades/options` and read `details` / `underlying_asset` off
 * each trade. Massive (formerly Polygon) serves options trades per contract —
 * `/v3/trades/{optionsTicker}` — and a trade record carries no contract
 * details, so every result failed the expiry guard. On an entitled plan the
 * source would have reported `connected` and emitted nothing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const INDEX = readFileSync(join(__dirname, '../src/ingestion/index.ts'), 'utf8');
const code = INDEX.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');

test('the Polygon connector makes no request and reports the reason as an error, not a missing key', () => {
  const body = code.slice(code.indexOf('function startPolygonIngestion'));
  const fn = body.slice(0, body.indexOf('\n}\n'));
  assert.ok(!/axios\.|setInterval|ingestPrint|emitSignals/.test(fn), 'it starts nothing');
  assert.match(fn, /markNoCredentials\('polygon'/, 'no key is still reported as no key');
  assert.match(fn, /sources\['polygon'\] = 'error'/);
  assert.match(fn, /sourceErrors\['polygon'\] = POLYGON_NOT_STARTED/);
});

test('the reason names the endpoint, the fault and the decision it waits on', async () => {
  const { POLYGON_NOT_STARTED } = await import('../src/ingestion/index');
  assert.match(POLYGON_NOT_STARTED, /\/v3\/trades\/options/);
  assert.match(POLYGON_NOT_STARTED, /\/v3\/trades\/\{optionsTicker\}/);
  assert.match(POLYGON_NOT_STARTED, /plan choice/);
});

test('no pipeline code polls the market-wide path', () => {
  // The constant names it; nothing may request it. The entitlement probe is
  // the one place it is asked, and that asks a plan question, not for prints.
  const requests = code.match(/axios\.get\(\s*['`]https:\/\/api\.polygon\.io\/v3\/trades\/options/g) ?? [];
  assert.equal(requests.length, 0);
});
