/**
 * "Durable storage" was the third capability claim read off configuration.
 *
 * `initPersistence` set `durable: true` — with the reason *"history survives
 * restarts"* — from two non-empty strings, and the doctor's check 3 said the
 * same thing in a `warn`. Neither had asked anything of anything. Checks 2 and
 * 4 made exactly that move and were rebuilt to refuse it; this is the same
 * defect in the two places that decide whether a track record can exist at all.
 *
 * It still cannot be *probed* from here — the success path is "this key writes
 * `signal_history`", which needs a real service key in the environment to
 * measure against. What can be established offline is the set of credentials
 * that provably cannot write, and the one that matters is silent: the anon key
 * and the service key are adjacent in the Supabase dashboard, the client
 * constructs happily from either, and the four history tables
 * `force row level security` with no policies, so the wrong one is refused on
 * every insert while `/api/health` reports the history as durable.
 *
 * Basis for the key shapes, measured 2026-09-16 against a live project that
 * issues both eras side by side:
 *
 *   legacy   `eyJ…`, payload {"iss":"supabase","ref":"<20 chars>","role":"anon",
 *            "iat":…,"exp":…}
 *   modern   `sb_publishable_…`
 *
 * No live key is embedded below. The fixtures are synthetic with the measured
 * claim set, and the signature is deliberately fake: this is a shape check, not
 * an authentication, which is why a right-shaped key is still only a `warn`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyServiceKey, projectRefFromUrl } from '../src/persistence/serviceKey';

const REF = 'abcdefghijklmnopqrst';
const URL_OK = `https://${REF}.supabase.co`;

function key(role: string, ref = REF, exp = 4102444800): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return [b64({ alg: 'HS256', typ: 'JWT' }),
    b64({ iss: 'supabase', ref, role, iat: 1781238858, exp }), 'sig'].join('.');
}

// ─── The failure that looks like success ────────────────────────────────────

test('an anon key in the service slot is refused, and the reason says why writes fail', () => {
  const v = classifyServiceKey(URL_OK, key('anon'));
  assert.equal(v.shape, 'public_key');
  assert.equal(v.usable, false);
  assert.match(v.reason, /role claim is "anon"/);
  assert.match(v.reason, /row level security/,
    'an operator needs to know the writes are refused, not just that the key is odd');
});

test('any role that is not service_role is refused, not just anon', () => {
  // Written as "is it service_role?", never as "is it anon?". Supabase issues
  // more roles than two, and a check that lists the one bad value passes every
  // value nobody thought of.
  for (const role of ['authenticated', 'postgres', 'anon', '']) {
    const v = classifyServiceKey(URL_OK, key(role));
    assert.equal(v.usable, false, `role=${role} must not be usable`);
    assert.equal(v.shape, 'public_key');
  }
});

test('a publishable key in the service slot is refused', () => {
  const v = classifyServiceKey(URL_OK, 'sb_publishable_wf9_JUyS_luCs8lIh57rcg_LKn_sLW2');
  assert.equal(v.shape, 'public_key');
  assert.equal(v.usable, false);
});

test('a secret key is accepted on shape, and says it is only shape', () => {
  const v = classifyServiceKey(URL_OK, 'sb_secret_0000000000000000000000');
  assert.equal(v.shape, 'service_role');
  assert.equal(v.usable, true);
  assert.match(v.reason, /not checked here/,
    'the modern format carries no claims, and pretending otherwise is the whole defect');
  assert.match(v.basis, /not measured here/,
    'the basis must admit this branch was never measured against a live secret key');
});

// ─── Never the other direction ──────────────────────────────────────────────

test('an unrecognised key is refused rather than assumed to work', () => {
  // The old fixture was the string 'key'. The failure direction that matters is
  // a wrong key reading as correct, so anything unreadable defaults to refused.
  for (const k of ['key', 'x'.repeat(200), 'a.b.c', '{}', 'Bearer abc']) {
    const v = classifyServiceKey(URL_OK, k);
    assert.equal(v.usable, false, `${k} must not classify as usable`);
    assert.notEqual(v.shape, 'service_role');
  }
});

test('a JWT that is not a Supabase key is not read for a role claim', () => {
  // Three base64 segments is not a Supabase credential. Reading `role` off any
  // token that happens to have that shape would be inventing a verdict.
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const foreign = [b64({ alg: 'HS256' }), b64({ iss: 'auth0', role: 'service_role' }), 'sig'].join('.');
  const v = classifyServiceKey(URL_OK, foreign);
  assert.equal(v.shape, 'unrecognised');
  assert.equal(v.usable, false);
});

test('an empty or blank key is absent, not unrecognised', () => {
  // Distinct states, because the fixes differ: one is "set the variable", the
  // other is "you set the wrong one".
  for (const k of [undefined, '', '   ']) {
    assert.equal(classifyServiceKey(URL_OK, k).shape, 'absent');
  }
});

// ─── The two recoverable faults ─────────────────────────────────────────────

test('a lapsed key is refused, and named as lapsed rather than as the wrong key', () => {
  const v = classifyServiceKey(URL_OK, key('service_role', REF, 1600000000));
  assert.equal(v.shape, 'expired');
  assert.match(v.reason, /2020-09-13/);
});

test('expiry is reported before a project mismatch', () => {
  // A key that has lapsed is wrong whichever project it names, and naming the
  // recoverable fault first sends an operator to the wrong dashboard page.
  const v = classifyServiceKey(URL_OK, key('service_role', 'zyxwvutsrqponmlkjihg', 1600000000));
  assert.equal(v.shape, 'expired');
});

test('a key from another project is refused, and names both refs', () => {
  const v = classifyServiceKey(URL_OK, key('service_role', 'zyxwvutsrqponmlkjihg'));
  assert.equal(v.shape, 'project_mismatch');
  assert.match(v.reason, /zyxwvutsrqponmlkjihg/);
  assert.match(v.reason, new RegExp(REF));
});

// ─── The right key still is not a verified key ──────────────────────────────

test('a correct service_role key is usable but makes no claim of working', () => {
  const v = classifyServiceKey(URL_OK, key('service_role'));
  assert.equal(v.shape, 'service_role');
  assert.equal(v.usable, true);
  assert.match(v.reason, /not checked here/,
    'usable means "not provably broken" — a revoked key has this exact shape');
});

// ─── The URL half ───────────────────────────────────────────────────────────

test('a self-hosted or custom-domain URL skips the mismatch check rather than failing it', () => {
  // Refusing a working deployment because its hostname does not look like
  // Supabase would be this module inventing a fault.
  assert.equal(projectRefFromUrl('https://db.example.com'), null);
  const v = classifyServiceKey('https://db.example.com', key('service_role', 'zyxwvutsrqponmlkjihg'));
  assert.equal(v.shape, 'service_role');
  assert.equal(v.usable, true);
});

test('the project ref is read only from a managed Supabase hostname', () => {
  assert.equal(projectRefFromUrl(URL_OK), REF);
  assert.equal(projectRefFromUrl(`https://${REF}.supabase.in`), REF);
  assert.equal(projectRefFromUrl('not a url'), null);
  assert.equal(projectRefFromUrl(undefined), null);
  assert.equal(projectRefFromUrl('https://supabase.co'), null);
  // Anchored at both ends. A hostname that merely *contains* a project-shaped
  // label is a different host, and an unanchored match would read this one as
  // the project it is impersonating — which would then silently satisfy the
  // mismatch check for a key pointed somewhere else entirely.
  assert.equal(projectRefFromUrl(`https://${REF}.supabase.co.evil.com`), null);
  assert.equal(projectRefFromUrl(`https://evil.${REF}.supabase.co`), null);
});

// ─── The claim on /api/health ───────────────────────────────────────────────

test('the running server reports durability from the verdict, not from two set strings', async () => {
  const { initPersistence, describePersistence } = await freshPersistence();
  initPersistence({ BUSINESS_MODE: 'PRIVATE_RESEARCH',
    SUPABASE_URL: URL_OK, SUPABASE_SERVICE_KEY: key('anon') } as NodeJS.ProcessEnv);

  const d = describePersistence();
  assert.equal(d.store, 'supabase', 'the configured store is still built, not silently swapped');
  assert.equal(d.durable, false, 'an anon key writes nothing, so history does not survive');
  assert.match(d.reason, /row level security/);
  assert.equal(d.serviceKey?.shape, 'public_key');
  assert.ok(!JSON.stringify(d).includes(key('anon')), 'the credential must never be published');
});

test('a right-shaped key still reports durable', async () => {
  const { initPersistence, describePersistence } = await freshPersistence();
  initPersistence({ BUSINESS_MODE: 'PRIVATE_RESEARCH',
    SUPABASE_URL: URL_OK, SUPABASE_SERVICE_KEY: key('service_role') } as NodeJS.ProcessEnv);
  const d = describePersistence();
  assert.equal(d.durable, true);
  assert.equal(d.serviceKey?.shape, 'service_role');
});

/** `initPersistence` memoises, so each case needs its own module instance. */
async function freshPersistence() {
  const p = require.resolve('../src/persistence/index');
  delete require.cache[p];
  return require(p);
}
