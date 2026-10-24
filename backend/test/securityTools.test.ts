/**
 * The exposure inventory and the revocation verifier, held to the one rule
 * that matters more than any verdict they produce: a credential value is
 * never printed. Both tools handle real disclosed keys in memory, so a test
 * that they find things is half the job; the other half is that nothing they
 * emit could become a second disclosure.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import {
  findAssignments, fingerprint, isSyntheticSequence, referencesIn, scanHistory, zipEntries,
} from '../tools/security/exposure';
import { PROBES, verify } from '../tools/security/verifyRevoked';

// Built at run time: no credential-shaped literal sits in this file.
/** A fabricated run, assembled so the vendor prefix and the body never sit together in source. */
const SEQ = '0123456789abcdef0123456789';
const fake = (seed: string) => `${seed}${'k7Q2pX9mR4tW8vL3'}${seed.length}Zc`;

test('all three ways a key is written are found, and documentation is not', () => {
  const v = fake('a');
  const found = findAssignments([
    `POLYGON_API_KEY=${v}`,
    `  FMP_API_KEY: "${v}",`,
    `{"FRED_API_KEY": "${v}"}`,
    'TRADIER_TOKEN=your-tradier-token-here',
    `FIRECRAWL_API_KEY=${'fc'}-${SEQ}`,
    'TWELVE_DATA_API_KEY: process.env.TWELVE_DATA_API_KEY',
    'NEWS_API_KEY=NEWS_API_KEY_FROM_DASHBOARD',
  ].join('\n'));
  assert.deepEqual(found.map((f) => f.name), ['POLYGON_API_KEY', 'FMP_API_KEY', 'FRED_API_KEY']);
});

test('a fabricated run of characters is recognised as a fixture, a real-shaped key is not', () => {
  assert.equal(isSyntheticSequence(`${'fc'}-${SEQ}`), true);
  assert.equal(isSyntheticSequence(fake('b')), false);
});

test('a zip is read entry by entry, which is where the original exposure sat', () => {
  // A one-entry deflated zip, built by hand: local header + data.
  const name = Buffer.from('app/.env');
  const data = deflateRawSync(Buffer.from(`TRADIER_API_KEY=${fake('z')}\n`));
  const h = Buffer.alloc(30);
  h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(8, 8);
  h.writeUInt32LE(data.length, 18); h.writeUInt16LE(name.length, 26);
  const entries = zipEntries(Buffer.concat([h, name, data]));
  assert.equal(entries[0]!.path, 'app/.env');
  assert.equal(findAssignments(entries[0]!.text)[0]!.name, 'TRADIER_API_KEY');
});

test('remaining references are reported by path, by fingerprint, never by value', () => {
  const v = fake('c');
  const files: Record<string, string> = { 'backend/.env': `FMP_API_KEY=${v}\n`, 'README.md': 'nothing here' };
  const hits = referencesIn(Object.keys(files), (p) => files[p] ?? null, new Set([fingerprint(v)]));
  assert.deepEqual(hits, ['backend/.env']);
  // A replaced key is not a reference to the old one.
  assert.deepEqual(referencesIn(['backend/.env'], () => `FMP_API_KEY=${fake('d')}`, new Set([fingerprint(v)])), []);
});

test('verdicts follow each vendor\'s refusal, and a non-answer is UNKNOWN rather than either claim', async () => {
  const v = fake('e');
  const fp = fingerprint(v);
  const exposure = (name: string) => [{ names: [name], kind: 'x', fingerprint: fp, seenAt: [] }];
  const values = new Map([[fp, v]]);
  const answering = (status: number, body = '') => (async () => new Response(body, { status })) as unknown as typeof fetch;

  assert.equal((await verify(exposure('POLYGON_API_KEY'), values, answering(401)))[0]!.verdict, 'REVOKED');
  // A plan refusal is a working key, not a revoked one.
  assert.equal((await verify(exposure('POLYGON_API_KEY'), values, answering(403)))[0]!.verdict, 'STILL_VALID');
  assert.equal((await verify(exposure('TWELVE_DATA_API_KEY'), values, answering(200, '{"code":401,"status":"error"}')))[0]!.verdict, 'REVOKED');
  assert.equal((await verify(exposure('EVENT_REGISTRY_API_KEY'), values, answering(200, '{"error":"Invalid API key"}')))[0]!.verdict, 'REVOKED');
  assert.equal((await verify(exposure('FINNHUB_API_KEY'), values, answering(429)))[0]!.verdict, 'UNKNOWN');
  const failing = (async () => { throw new Error('network'); }) as unknown as typeof fetch;
  assert.equal((await verify(exposure('FRED_API_KEY'), values, failing))[0]!.verdict, 'UNKNOWN');
  assert.equal((await verify(exposure('SOMETHING_ELSE_KEY'), values, answering(200)))[0]!.verdict, 'NOT_PROBED');
});

test('no result a verifier returns carries the value it tested', async () => {
  const v = fake('f');
  const fp = fingerprint(v);
  const echo = (async (url: string) => new Response(`you sent ${url}`, { status: 401 })) as unknown as typeof fetch;
  for (const name of Object.keys(PROBES)) {
    const [r] = await verify([{ names: [name], kind: 'x', fingerprint: fp, seenAt: [] }], new Map([[fp, v]]), echo);
    assert.ok(!JSON.stringify(r).includes(v), `${name}: the result carries the value`);
  }
});

test('every credential name in this repository\'s history has a probe or a stated reason it has none', () => {
  // A history that grows a new kind of key must not slip past verification
  // unnoticed: either it gets a probe, or the reason it cannot is written here.
  const UNPROBEABLE: Record<string, string> = {
    NEXT_PUBLIC_SUPABASE_ANON_KEY:
      'public by design — shipped to every browser — and revoked by rotating the project JWT secret, not by a request',
  };
  const names = new Set(scanHistory(`${__dirname}/../..`).flatMap((e) => e.names));
  const unmapped = [...names].filter((n) => !PROBES[n] && !UNPROBEABLE[n]);
  assert.deepEqual(unmapped, []);
});
