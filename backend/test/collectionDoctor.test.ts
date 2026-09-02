/**
 * The collection doctor.
 *
 * `/api/track-record` reports `total: 78, synthetic: 78, real: 0` and a grader
 * that has tracked nothing. That is correct output and it says so in its own
 * notes — but it cannot say *why*, and the why is several independent
 * conditions that must all hold before one graded outcome exists. An operator
 * reading "0 real" cannot tell whether they are one API key away or four.
 *
 * The loop itself is already proven: `historyIntegration.test.ts` drives a
 * real print through to a POSITIVE M15 outcome in memory. Nothing here is
 * about the code being wrong. These tests are about the diagnosis being
 * right — a doctor that reported a green light on a deployment that cannot
 * collect would be worse than no doctor.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runChecks, type Check } from '../tools/collection/doctor';

/** An environment with every link satisfied. */
const COMPLETE: NodeJS.ProcessEnv = {
  BUSINESS_MODE: 'PRIVATE_RESEARCH',
  TRADIER_TOKEN: 'tok',
  SUPABASE_URL: 'https://x.supabase.co',
  SUPABASE_SERVICE_KEY: 'key',
  TWELVE_DATA_API_KEY: 'td',
} as NodeJS.ProcessEnv;

const blocked = (cs: Check[]) => cs.filter((c) => c.status === 'blocked').map((c) => c.name);
const named = (cs: Check[], n: string) => cs.find((c) => c.name === n)!;

test('an empty environment blocks on every link that is actually broken', () => {
  const cs = runChecks({} as NodeJS.ProcessEnv);
  assert.deepEqual(blocked(cs).sort(), [
    'A source permitted to persist',
    'Durable storage',
    'Underlying marks for grading',
  ]);
});

test('a complete environment reaches a graded outcome', () => {
  assert.deepEqual(blocked(runChecks(COMPLETE)), []);
});

test('each link blocks on its own', () => {
  // The point of reporting all of them: fixing one changes nothing observable,
  // so a doctor that stopped at the first would send an operator round a loop.
  for (const [drop, expected] of [
    ['TRADIER_TOKEN', 'A source permitted to persist'],
    ['SUPABASE_SERVICE_KEY', 'Durable storage'],
    ['TWELVE_DATA_API_KEY', 'Underlying marks for grading'],
  ] as Array<[string, string]>) {
    const env = { ...COMPLETE };
    delete env[drop];
    assert.deepEqual(blocked(runChecks(env)), [expected], `dropping ${drop}`);
  }
});

test('a half-set credential does not count as set', () => {
  // Schwab needs three variables. Two of them is not a configured connector,
  // and reporting it as one is how "why is nothing recording" starts.
  const env = { BUSINESS_MODE: 'PRIVATE_RESEARCH', SCHWAB_APP_KEY: 'a', SCHWAB_APP_SECRET: 'b',
    SUPABASE_URL: 'u', SUPABASE_SERVICE_KEY: 'k', TWELVE_DATA_API_KEY: 't' } as NodeJS.ProcessEnv;
  assert.deepEqual(blocked(runChecks(env)), ['A source permitted to persist']);

  env.SCHWAB_REFRESH_TOKEN = 'c';
  assert.deepEqual(blocked(runChecks(env)), []);
});

test('blank and whitespace values are unset', () => {
  const env = { ...COMPLETE, TWELVE_DATA_API_KEY: '   ' } as NodeJS.ProcessEnv;
  assert.deepEqual(blocked(runChecks(env)), ['Underlying marks for grading']);
});

test('a malformed business mode stops the report rather than guessing past it', () => {
  // Every check after this one is a rights decision. Continuing would print
  // conclusions computed in a mode the operator did not choose.
  const cs = runChecks({ BUSINESS_MODE: 'public' } as NodeJS.ProcessEnv);
  assert.equal(cs.length, 1);
  assert.equal(cs[0]!.status, 'blocked');
  assert.match(cs[0]!.detail, /not a valid mode/);
});

test('commercial mode blocks collection outright, and says why', () => {
  // Nothing is PERMITTED for PERSIST in PUBLIC_COMMERCIAL — redistribution
  // terms are established for no source. A deployment could otherwise sit in
  // that mode wondering why a fully credentialed feed records nothing.
  const cs = runChecks({ ...COMPLETE, BUSINESS_MODE: 'PUBLIC_COMMERCIAL' } as NodeJS.ProcessEnv);
  const c = named(cs, 'A source permitted to persist');
  assert.equal(c.status, 'blocked');
  assert.match(c.detail, /No source is PERMITTED for PERSIST in PUBLIC_COMMERCIAL/);
});

test('every blocked check says what to do about it', () => {
  for (const c of runChecks({} as NodeJS.ProcessEnv)) {
    if (c.status === 'blocked' || c.status === 'warn') {
      assert.ok(c.fix && c.fix.length > 30, `${c.name} needs an actionable fix line`);
    }
  }
});

test('the grader really does depend on the variable the doctor names', () => {
  // The check is only worth anything if TwelveData is genuinely the grader's
  // sole price source. If a fallback were ever added, this claim would go
  // stale in the least visible way — an operator setting a key they no longer
  // need, or not setting one they do.
  const ingestion = readFileSync(join(__dirname, '..', 'src', 'ingestion', 'index.ts'), 'utf8');
  assert.match(
    ingestion,
    // The span is generous on purpose: what is being pinned is that the grader's
    // mark comes from `getSpotPrice`, not how much explanation sits between the
    // two lines. A tight budget made an added comment look like a broken
    // dependency, which is a false alarm about the one claim that matters.
    /new SignalGrader\(store,\s*\(underlying\)\s*=>\s*\{[\s\S]{0,600}?getSpotPrice\(underlying\)/,
    'the grader should still take its mark from getSpotPrice',
  );
  const twelve = readFileSync(
    join(__dirname, '..', 'src', 'ingestion', 'connectors', 'twelveData.ts'), 'utf8',
  );
  assert.match(twelve, /process\.env\.TWELVE_DATA_API_KEY/,
    'and getSpotPrice should still come from the connector the doctor names');
});

test('the doctor covers every recordable source the registry permits', () => {
  // A source added to the registry as PERMITTED for PERSIST, and not here,
  // would be a way to collect that the doctor tells you does not exist.
  const doctor = readFileSync(
    join(__dirname, '..', 'tools', 'collection', 'doctor.ts'), 'utf8',
  );
  for (const s of ['tradier', 'polygon', 'marketdata', 'schwab', 'tastytrade']) {
    assert.ok(doctor.includes(`'${s}'`), `RECORDABLE_SOURCES should list ${s}`);
  }
});
