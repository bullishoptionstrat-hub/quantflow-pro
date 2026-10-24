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
  classifyAssignments, displayFingerprint, findAssignments, fingerprint, formatReport, isSyntheticSequence,
  newSkipped, referencesIn, scanHistory, zipEntries,
} from '../tools/security/exposure';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROBES, verify } from '../tools/security/verifyRevoked';

// Built at run time: no credential-shaped literal sits in this file.
/** A fabricated run, assembled so the vendor prefix and the body never sit together in source. */
const SEQ = '0123456789abcdef0123456789';
const fake = (seed: string) => `${seed}${'k7Q2pX9mR4tW8vL3'}${seed.length}Zc`;
/** A one-entry deflated zip, built by hand: local header + data. */
function zipOf(path: string, text: string): Buffer {
  const name = Buffer.from(path);
  const data = deflateRawSync(Buffer.from(text));
  const h = Buffer.alloc(30);
  h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(8, 8);
  h.writeUInt32LE(data.length, 18); h.writeUInt16LE(name.length, 26);
  return Buffer.concat([h, name, data]);
}

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
    SUPABASE_SERVICE_KEY:
      'a privileged service-role key: probing it means using write access to the database, so it is checked in the Supabase dashboard instead',
  };
  const names = new Set(scanHistory(`${__dirname}/../..`).flatMap((e) => e.names));
  const unmapped = [...names].filter((n) => !PROBES[n] && !UNPROBEABLE[n]);
  assert.deepEqual(unmapped, []);
});


// ─── Low-confidence findings: values the key-shape rule cannot see ──────────
//
// The inventory used to require 16+ characters of letters and digits, so a
// 15-character letters-only NEXTAUTH_SECRET in a public archive was never
// reported. Nothing under a credential name is now dropped for its length:
// 6–15 characters is LOW and listed; 1–5 is TRIVIAL and counted; template
// defaults and empty values are counted too. Every value below is assembled at
// run time and every line built through `line()`, so this file holds no
// assignment the scanner would report from this repository's own history.

const line = (name: string, value: string, sep = '=', quote = '') => `${name}${sep}${quote}${value}${quote}`;
const word = (...parts: string[]) => parts.join('');
const SHORT15 = word('qmzrh', 'vbkdl', 'wptxa');   // 15 letters, no digits
const SHORT9 = word('kfwq', 'zjtnb');              // 9 letters
const cats = (text: string) => classifyAssignments(text).map((a) => [a.name, a.category]);

test('a short or letters-only value under any credential name is listed, at low confidence', () => {
  assert.deepEqual(cats([
    line('NEXTAUTH_SECRET', SHORT15),
    line('ML_WEBHOOK_SECRET', SHORT9),
    line('ADMIN_PASSWORD', SHORT9, ': ', '"'),
    line('FMP_API_KEY', SHORT9),
    line('MARKETDATA_TOKEN', SHORT15),
  ].join('\n')), [
    ['NEXTAUTH_SECRET', 'low'], ['ML_WEBHOOK_SECRET', 'low'], ['ADMIN_PASSWORD', 'low'],
    ['FMP_API_KEY', 'low'], ['MARKETDATA_TOKEN', 'low'],
  ]);
});

test('nothing is dropped for its length alone: 1–5 characters is counted as trivial', () => {
  assert.deepEqual(cats([line('SESSION_SECRET', word('ab', 'cde')), line('TRADIER_TOKEN', 'x')].join('\n')),
    [['SESSION_SECRET', 'trivial'], ['TRADIER_TOKEN', 'trivial']]);
  // …and trivial values are not listed as findings.
  assert.deepEqual(findAssignments(line('SESSION_SECRET', word('ab', 'cde'))), []);
});

test('a key-shaped value keeps its high grade, and a short prefixed value does not gain one', () => {
  const v = fake('h');
  assert.equal(findAssignments(line('NEXTAUTH_SECRET', v))[0]!.confidence, 'high');
  assert.equal(classifyAssignments(line('OPENAI_API_KEY', word('sk', '-', 'ab12')))[0]!.category, 'low');
});

test('an empty value is counted as empty — and does not borrow the next line', () => {
  // The separator used to accept a newline, so this reported the most
  // privileged name in the stack as exposed, carrying the next line's text.
  const text = [line('SUPABASE_SERVICE_ROLE_KEY', ''), word('webhook-url-for-', 'the-ml-service-ab12c')].join('\n');
  assert.deepEqual(cats(text), [['SUPABASE_SERVICE_ROLE_KEY', 'empty']]);
  assert.deepEqual(findAssignments(text), []);
  assert.deepEqual(cats(line('NEXTAUTH_SECRET', '', '=', '"')), [['NEXTAUTH_SECRET', 'empty']]);
});

test('template defaults are recognised as such, distinct from both findings and empty values', () => {
  assert.deepEqual(cats([
    line('ML_WEBHOOK_SECRET', word('change', '-me')),
    line('NEXTAUTH_SECRET', word('change-me-to-a-', '32-char-random-v9')),
    line('ADMIN_PASSWORD', word('your', '-password')),
    line('SCHWAB_APP_SECRET', word('sec', 'ret'), ': ', "'"),       // a value that only names its role
  ].join('\n')), [
    ['ML_WEBHOOK_SECRET', 'template'], ['NEXTAUTH_SECRET', 'template'],
    ['ADMIN_PASSWORD', 'template'], ['SCHWAB_APP_SECRET', 'template'],
  ]);
});

test('harmless values and code are not classified as credentials at all', () => {
  assert.deepEqual(cats([
    `WEBHOOK_SECRET = ${word('os', '.environ', '.get')}("x")`,                  // dotted code
    line('TRADIER_API_KEY', word('zod_1', '.z', '.string'), ': ') + '()',        // compiled schema call
    line('SUPABASE_SERVICE_KEY', word('REQUIRED', '.SUPABASE_SERVICE_KEY')),     // dotted constant path
    line('PGRST_JWT_SECRET', word('jwt', 'Secret'), ': ') + ',',                // unquoted identifier reference
    line('MAX_TOKENS', '4096'),                                                   // digits only: a count
    line('TOKEN_TTL_SECONDS', '3600'),
    line('API_KEY', word('process', '.env', '.API_KEY')),
  ].join('\n')), []);
});

test('a JWT is not mistaken for dotted code', () => {
  const jwt = [word('eyJ', 'hbGciOiJIUzI1NiJ9'), word('eyJ', 'yb2xlIjoiYW5vbiJ9'), word('k7Q2pX9mR4', 'tW8vL3Zc11')].join('.');
  assert.equal(classifyAssignments(line('NEXT_PUBLIC_SUPABASE_ANON_KEY', jwt))[0]!.category, 'high');
});

test('one value under several names is one finding; one name with different values is several', () => {
  const repo = mkdtempSync(join(tmpdir(), 'qf-exposure-'));
  try {
    const git = (...a: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: repo });
    git('init', '-q');
    // Same value under two names, and in two "deployments".
    writeFileSync(join(repo, '.env'), [line('NEXTAUTH_SECRET', SHORT15), line('AUTH_SECRET', SHORT15)].join('\n'));
    mkdirSync(join(repo, 'deploy', 'render'), { recursive: true });
    writeFileSync(join(repo, 'deploy', 'render', 'service.env'), line('NEXTAUTH_SECRET', SHORT15));
    // …and once more inside a committed archive, the form the original exposure took.
    writeFileSync(join(repo, 'backup.zip'), zipOf('app/.env.local', line('NEXTAUTH_SECRET', SHORT15)));
    // Same name, a different value, in another file.
    writeFileSync(join(repo, 'vercel.env'), line('NEXTAUTH_SECRET', SHORT9));
    writeFileSync(join(repo, 'other.env'), line('FMP_API_KEY', fake('g')));
    git('add', '.'); git('commit', '-qm', 'fixture');

    const report = scanHistory(repo);
    const low = report.filter((e) => e.confidence === 'low');
    assert.equal(low.length, 2, 'two distinct values, two findings');
    const shared = low.find((e) => e.fingerprint === fingerprint(SHORT15))!;
    assert.deepEqual([...shared.names].sort(), ['AUTH_SECRET', 'NEXTAUTH_SECRET']);
    assert.deepEqual(shared.seenAt.map((at) => at.split(':').slice(1).join(':')).sort(),
      ['.env', 'backup.zip!app/.env.local', 'deploy/render/service.env'], 'every place the shared value sits');
    assert.ok(low.some((e) => e.fingerprint === fingerprint(SHORT9) && e.names.join() === 'NEXTAUTH_SECRET'));
    assert.equal(report.filter((e) => e.confidence === 'high').length, 1);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('the printed report carries no value, and withholds the fingerprint of a short one', () => {
  const repo = mkdtempSync(join(tmpdir(), 'qf-exposure-'));
  try {
    const git = (...a: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: repo });
    git('init', '-q');
    writeFileSync(join(repo, '.env'), [
      line('NEXTAUTH_SECRET', SHORT15), line('FMP_API_KEY', fake('j')),
      line('SESSION_SECRET', word('ab', 'cde')), line('ML_WEBHOOK_SECRET', word('change', '-me')),
      line('SUPABASE_SERVICE_ROLE_KEY', ''),
    ].join('\n'));
    git('add', '.'); git('commit', '-qm', 'fixture');

    const skipped = newSkipped();
    const report = scanHistory(repo, undefined, skipped);
    const printed = formatReport(report, skipped).join('\n');
    for (const v of [SHORT15, fake('j'), word('ab', 'cde')]) assert.ok(!printed.includes(v), 'the printed report carries a value');
    // A 10-hex prefix of a 15-letter value can be brute-forced; of a key-shaped one it cannot.
    assert.ok(!printed.includes(fingerprint(SHORT15)), 'a short value\'s fingerprint is printed');
    assert.ok(printed.includes(fingerprint(fake('j'))), 'a key-shaped value\'s fingerprint is missing');
    assert.equal(displayFingerprint(report.find((e) => e.confidence === 'low')!), 'withheld');
    assert.ok(printed.indexOf('NEXTAUTH_SECRET') > printed.indexOf('Low confidence'), 'low findings sit in their own section');
    // The three skipped kinds are counted by name, distinguishable from each other.
    assert.match(printed, /1–5 characters \(1\): SESSION_SECRET×1/);
    assert.match(printed, /template default or placeholder \(1\): ML_WEBHOOK_SECRET×1/);
    assert.match(printed, /empty or not a literal[^\n]*SUPABASE_SERVICE_ROLE_KEY×1/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('the verifier never probes a low-confidence value and never prints its fingerprint', async () => {
  const fp = fingerprint(SHORT9);
  let called = false;
  const spy = (async () => { called = true; return new Response('', { status: 200 }); }) as unknown as typeof fetch;
  const [r] = await verify([{ names: ['FMP_API_KEY'], kind: 'x', fingerprint: fp, seenAt: [], confidence: 'low' }],
    new Map([[fp, SHORT9]]), spy);
  assert.equal(called, false, 'a low-confidence value was sent to a vendor');
  assert.equal(r!.verdict, 'NOT_PROBED');
  assert.equal(r!.fingerprint, 'withheld');
});
