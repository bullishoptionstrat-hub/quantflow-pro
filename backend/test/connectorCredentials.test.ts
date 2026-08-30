/**
 * The credential table in `ingestion/index.ts` duplicates knowledge that lives
 * in each connector file, so it can drift — and when it drifts the failure is
 * silent: a connector reports `connected` while fetching nothing, which is the
 * exact bug this table was added to fix.
 *
 * These tests read the connector sources and hold the table to them.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { CONNECTOR_CREDENTIALS, missingCredentials } from '../src/ingestion/index';

const CONNECTOR_DIR = join(__dirname, '..', 'src', 'ingestion', 'connectors');

/** Connector name in the table → its source file. */
const FILES: Record<string, string> = {
  flashalpha: 'flashAlpha.ts',
  marketdata: 'marketData.ts',
  schwab: 'schwab.ts',
  tastytrade: 'tastytrade.ts',
  twelvedata: 'twelveData.ts',
  fmp: 'fmp.ts',
  newsapi: 'newsApi.ts',
  fred: 'fred.ts',
  reddit: 'reddit.ts',
  coingecko: 'coinGecko.ts',
  cboe: 'cboe.ts',
  yahoo: 'yahoo.ts',
  stooq: 'stooq.ts',
};

/** Every process.env.X referenced by a file. */
function envVarsIn(file: string): Set<string> {
  const src = readFileSync(join(CONNECTOR_DIR, file), 'utf8');
  return new Set([...src.matchAll(/process\.env\.([A-Z_0-9]+)/g)].map((m) => m[1]!));
}

test('every connector in the table has a source file, and vice versa', () => {
  for (const name of Object.keys(CONNECTOR_CREDENTIALS)) {
    assert.ok(FILES[name], `${name} is in the table but has no mapped source file`);
  }
  const onDisk = readdirSync(CONNECTOR_DIR).filter((f) => f.endsWith('.ts'));
  const mapped = new Set(Object.values(FILES));
  // cboeOptions and occ are started separately, not through startConnector.
  const exempt = new Set(['cboeOptions.ts', 'occ.ts']);
  for (const f of onDisk) {
    if (exempt.has(f)) continue;
    assert.ok(mapped.has(f), `${f} exists but no table entry covers it`);
  }
});

test('every credential the table lists is actually read by that connector', () => {
  // Catches a stale entry: a variable we demand but the code no longer uses,
  // which would report a connector disabled forever.
  for (const [name, required] of Object.entries(CONNECTOR_CREDENTIALS)) {
    if (required.length === 0) continue;
    const actual = envVarsIn(FILES[name]!);
    for (const key of required) {
      assert.ok(
        actual.has(key),
        `${name}: table requires ${key} but ${FILES[name]} never reads it`,
      );
    }
  }
});

test('a connector reading a credential is not listed as keyless', () => {
  // The dangerous direction. A connector that reads an API key but has an
  // empty table entry reports `connected` with no key — the original bug.
  const NOT_CREDENTIALS = new Set(['STOOQ_ENABLED', 'YAHOO_ENABLED', 'NODE_ENV']);
  for (const [name, required] of Object.entries(CONNECTOR_CREDENTIALS)) {
    const actual = [...envVarsIn(FILES[name]!)].filter((k) => !NOT_CREDENTIALS.has(k));
    if (name === 'coingecko') continue; // optional key; public endpoint works
    if (actual.length > 0) {
      assert.ok(
        required.length > 0,
        `${name} reads ${actual.join(', ')} but the table lists it as keyless — ` +
        `it would report "connected" with no credentials`,
      );
    }
  }
});

test('missingCredentials reports exactly the unset variables', () => {
  assert.deepEqual(missingCredentials('fmp', {} as NodeJS.ProcessEnv), ['FMP_API_KEY']);
  assert.deepEqual(missingCredentials('fmp', { FMP_API_KEY: 'k' } as any), []);
  assert.deepEqual(
    missingCredentials('reddit', { REDDIT_CLIENT_ID: 'a' } as any),
    ['REDDIT_CLIENT_SECRET'],
  );
});

test('a blank or whitespace-only value counts as missing', () => {
  // Render stores an unset variable as an empty string, which is the common
  // real-world case and would otherwise read as configured.
  assert.deepEqual(missingCredentials('fmp', { FMP_API_KEY: '' } as any), ['FMP_API_KEY']);
  assert.deepEqual(missingCredentials('fmp', { FMP_API_KEY: '   ' } as any), ['FMP_API_KEY']);
});

test('genuinely keyless sources need nothing', () => {
  for (const name of ['coingecko', 'cboe', 'yahoo', 'stooq']) {
    assert.deepEqual(missingCredentials(name, {} as NodeJS.ProcessEnv), [],
      `${name} should work with no credentials`);
  }
});

test('an unknown connector name reports no requirements rather than throwing', () => {
  assert.deepEqual(missingCredentials('nope', {} as NodeJS.ProcessEnv), []);
});
