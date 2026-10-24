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
  findAssignments, fingerprint, formatReport, isSyntheticSequence, referencesIn, scanHistory, zipEntries,
} from '../tools/security/exposure';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  const exposure = (name: string) => [{ names: [name], kind: 'x', fingerprint: fp, seenAt: [], confidence: 'high' as const }];
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
    const [r] = await verify([{ names: [name], kind: 'x', fingerprint: fp, seenAt: [], confidence: 'high' }], new Map([[fp, v]]), echo);
    assert.ok(!JSON.stringify(r).includes(v), `${name}: the result carries the value`);
  }
});

test('every credential name in this repository\'s history has a probe or a stated reason it has none', () => {
  // A history that grows a new kind of key must not slip past verification
  // unnoticed: either it gets a probe, or the reason it cannot is written here.
  const UNPROBEABLE: Record<string, string> = {
    NEXT_PUBLIC_SUPABASE_ANON_KEY:
      'public by design — shipped to every browser — and revoked by rotating the project JWT secret, not by a request',
    NEXTAUTH_SECRET:
      'a session-signing secret the application chose, with no vendor to ask; it is retired by changing it wherever it is deployed',
  };
  const names = new Set(scanHistory(`${__dirname}/../..`).flatMap((e) => e.names));
  const unmapped = [...names].filter((n) => !PROBES[n] && !UNPROBEABLE[n]);
  assert.deepEqual(unmapped, []);
});


// ─── Low-confidence findings: short or letters-only values a person chose ────
//
// The inventory used to require 16+ characters of letters and digits, so a
// 15-character letters-only NEXTAUTH_SECRET in a public archive was never
// reported. Every value below is assembled at run time and every line is built
// through `line()`, so this file holds no assignment the scanner would report
// from this repository's own history.

const line = (name: string, value: string, sep = '=', quote = '') => `${name}${sep}${quote}${value}${quote}`;
const word = (...parts: string[]) => parts.join('');
const SHORT15 = word('qmzrh', 'vbkdl', 'wptxa');   // 15 letters, no digits
const SHORT9 = word('kfwq', 'zjtnb');              // 9 letters

test('a short or letters-only value under a SECRET or PASSWORD name is reported, at low confidence', () => {
  const found = findAssignments([
    line('NEXTAUTH_SECRET', SHORT15),
    line('ML_WEBHOOK_SECRET', SHORT9),
    line('ADMIN_PASSWORD', SHORT9, ': ', '"'),
  ].join('\n'));
  assert.deepEqual(found.map((f) => [f.name, f.confidence]), [
    ['NEXTAUTH_SECRET', 'low'], ['ML_WEBHOOK_SECRET', 'low'], ['ADMIN_PASSWORD', 'low'],
  ]);
});

test('the relaxed rule is confined to chosen secrets: a short value under KEY or TOKEN is not a finding', () => {
  // A vendor-issued key is never 9 letters; under these names a short value is config.
  assert.deepEqual(findAssignments([line('FMP_API_KEY', SHORT9), line('MARKETDATA_TOKEN', SHORT15)].join('\n')), []);
});

test('a key-shaped value keeps its high grade, and a short prefixed value does not gain one', () => {
  const v = fake('h');
  assert.equal(findAssignments(line('NEXTAUTH_SECRET', v))[0]!.confidence, 'high');
  assert.deepEqual(findAssignments(line('OPENAI_API_KEY', word('sk', '-', 'ab12'))), []);
});

test('an empty value is not an assignment — and does not borrow the next line', () => {
  // The separator used to accept a newline, so this reported the most
  // privileged name in the stack as exposed, carrying the next line's text.
  const text = [line('SUPABASE_SERVICE_ROLE_KEY', ''), word('webhook-url-for-', 'the-ml-service-ab12c')].join('\n');
  assert.deepEqual(findAssignments(text), []);
  assert.deepEqual(findAssignments(line('NEXTAUTH_SECRET', '', '=', '"')), []);
});

test('template defaults stay excluded at both lengths', () => {
  assert.deepEqual(findAssignments([
    line('ML_WEBHOOK_SECRET', word('change', '-me')),
    line('NEXTAUTH_SECRET', word('change-me-to-a-', '32-char-random-v9')),
    line('ADMIN_PASSWORD', word('your', '-password')),
  ].join('\n')), []);
});

test('code and role words are not secrets', () => {
  assert.deepEqual(findAssignments([
    `WEBHOOK_SECRET = ${word('os', '.environ', '.get')}("ML_WEBHOOK_SECRET")`,   // a dotted path reading a value
    line('SCHWAB_APP_SECRET', word('sec', 'ret'), ': ', "'"),                      // the role word as a fixture
    line('PGRST_JWT_SECRET', word('jwt', 'Secret'), ': ') + ',',                  // an unquoted reference to a variable
    line('SESSION_SECRET', word('ab', 'cde')),                                     // under the 6-character floor
  ].join('\n')), []);
});

test('one value under several names is one finding, and the report never carries a value', () => {
  const repo = mkdtempSync(join(tmpdir(), 'qf-exposure-'));
  try {
    const git = (...a: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: repo });
    git('init', '-q');
    writeFileSync(join(repo, '.env'), [line('NEXTAUTH_SECRET', SHORT15), line('AUTH_SECRET', SHORT15)].join('\n'));
    writeFileSync(join(repo, 'other.env'), line('FMP_API_KEY', fake('g')));
    git('add', '.'); git('commit', '-qm', 'fixture');

    const report = scanHistory(repo);
    const low = report.filter((e) => e.confidence === 'low');
    assert.equal(low.length, 1, 'two names, one value, one finding');
    assert.deepEqual([...low[0]!.names].sort(), ['AUTH_SECRET', 'NEXTAUTH_SECRET']);
    assert.equal(low[0]!.fingerprint, fingerprint(SHORT15));
    assert.equal(report.filter((e) => e.confidence === 'high').length, 1);

    const printed = formatReport(report).join('\n');
    for (const v of [SHORT15, fake('g')]) assert.ok(!printed.includes(v), 'the printed report carries a value');
    assert.match(printed, /Low confidence/);
    assert.ok(printed.indexOf('AUTH_SECRET') > printed.indexOf('Low confidence'), 'low findings are listed in their own section');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

