/**
 * Where the grader's price comes from, and whether a row can say so.
 *
 * The grader took its mark from `getSpotPrice` — Twelve Data's cache, hard
 * wired — so two things were true that nobody had written down. An unrelated
 * missing key blocked every grade, which the doctor at least reported. And no
 * graded outcome recorded *where its price came from*, which nothing reported
 * at all, because with one possible source the answer was recoverable by
 * knowing the deployment. With more than one it would not be.
 *
 * These tests hold the mechanism honest in both directions: the ranking is
 * derived from rights rather than hardcoded, and a mark cannot reach a row
 * without its source.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  markSourceStandings, resolveMark, registeredMarkSources, markSourceCredentials,
} from '../src/ingestion/markSources';
import { CONNECTOR_CREDENTIALS } from '../src/ingestion/index';
import { classifySource } from '../src/provenance/rights';

const CREDENTIALLED = {
  BUSINESS_MODE: 'PRIVATE_RESEARCH', TWELVE_DATA_API_KEY: 'td',
} as NodeJS.ProcessEnv;

test('the registry is short, and the guard says so out loud', () => {
  // Not a style assertion — a claim about the world. Finnhub is PROHIBITED for
  // PERSIST by its own quoted clause, Yahoo is PROHIBITED for DISPLAY before
  // the question arises, Polygon's plan here serves end-of-day aggregates that
  // cannot mark an M15 checkpoint, and Tradier has no token and no REST quote
  // helper. A vendor path that has never returned a price is not a fallback.
  //
  // If this list grows, that is good news and this test should be updated with
  // the reason. What it must never do is grow silently: "ranked list" implying
  // plurality when the registry holds one is the kind of quiet overclaim the
  // rest of this suite exists to prevent.
  assert.deepEqual(registeredMarkSources(), ['twelvedata']);
});

test('a mark carries its source and its rights standing', () => {
  // Provenance is part of the value, so it is structurally impossible to
  // record a price without knowing where it came from.
  const m = resolveMark('SPY');
  if (m !== undefined) {
    assert.equal(typeof m.price, 'number');
    assert.ok(m.price > 0);
    assert.ok(registeredMarkSources().includes(m.source));
    assert.notEqual(m.rightsClass, 'PROHIBITED');
  }
  // Undefined is the normal answer with no connector running, and it is the
  // honest one: no source had a price, so there is no mark and no source to
  // attribute. A zero here would be a -100% return against a live entry.
});

test('a mark carries its stamp, and one that cannot be dated is refused', () => {
  const m = resolveMark('SPY');
  if (m !== undefined) {
    assert.equal(typeof m.asOf, 'number');
    assert.ok(Number.isFinite(m.asOf) && m.asOf > 0);
  }

  // The behavioural half of this rule lives where a cache can be populated —
  // `spotQuoteHonesty.test.ts` drives the only registered source and asserts
  // its stamp is the vendor's. What is asserted here is that the registry
  // *screens* the stamp on the way through, because that is the branch a
  // second source would arrive on: `resolveMark` returns undefined rather
  // than dating a mark itself. Defaulting the clock is the `?? 0` move with a
  // timestamp instead of a price, and it would hand the grader's staleness
  // refusals a number they cannot doubt.
  const src = readFileSync(
    join(__dirname, '..', 'src', 'ingestion', 'markSources.ts'), 'utf8');
  assert.match(src, /Number\.isFinite\(hit\.asOf\)/,
    'resolveMark must screen the stamp it was handed');
  assert.ok(!/asOf:\s*Date\.now\(\)/.test(src),
    'the registry must never stamp a mark with its own clock');
});

test('ranking is derived from rights, not written down', () => {
  // PERMITTED before UNVERIFIED, PROHIBITED never. Asserted against the rights
  // registry itself so the order cannot drift from the classification that
  // produced it.
  const order = markSourceStandings(CREDENTIALLED).map((m) => m.rightsClass);
  const rank = (c: string) => (c === 'PERMITTED' ? 0 : c === 'UNVERIFIED' ? 1 : 2);
  for (let i = 1; i < order.length; i++) {
    assert.ok(rank(order[i - 1]!) <= rank(order[i]!),
      `standings are out of rights order: ${order.join(' → ')}`);
  }
  for (const m of markSourceStandings(CREDENTIALLED)) {
    assert.notEqual(m.rightsClass, 'PROHIBITED',
      `${m.source} is PROHIBITED for PERSIST and must never be registered`);
  }
});

test('UNVERIFIED is used and recorded, not refused', () => {
  // The tempting filter is `classifySource(...).allowed`, which is false for
  // anything short of affirmatively PERMITTED — and would drop Twelve Data,
  // leaving the grader with no mark source and silently turning the only
  // working path off. The established decision is the doctor's check 4b:
  // report the uncertainty, do not refuse it, mirroring the connector gate
  // which refuses PROHIBITED only.
  const td = markSourceStandings(CREDENTIALLED).find((m) => m.source === 'twelvedata')!;
  assert.equal(td.rightsClass, 'UNVERIFIED');
  assert.equal(classifySource('twelvedata', 'PERSIST', 'PRIVATE_RESEARCH').allowed, false,
    'the PERSIST gate really does refuse it — which is why .allowed is the wrong filter');
  assert.equal(td.rightsOk, true, 'and it is still usable, ranked last');
});

test('rights and credentials are reported apart, so the real obstacle is named', () => {
  // "No mark source" sends an operator looking for a setting that may not be
  // the one missing. A source refused on rights will not start when a key is
  // supplied, and that is the distinction worth reading first.
  const noKey = markSourceStandings({ BUSINESS_MODE: 'PRIVATE_RESEARCH' } as NodeJS.ProcessEnv);
  const td = noKey.find((m) => m.source === 'twelvedata')!;
  assert.equal(td.rightsOk, true);
  assert.equal(td.credentialed, false);
  assert.equal(td.usable, false);
  assert.match(td.reason, /TWELVE_DATA_API_KEY unset/);
  assert.deepEqual([...td.needs], ['TWELVE_DATA_API_KEY']);

  const withKey = markSourceStandings(CREDENTIALLED).find((m) => m.source === 'twelvedata')!;
  assert.equal(withKey.usable, true);
});

test('the registry needs the same variables the credentials table does', () => {
  // `markSources.ts` declares its own `needs` rather than importing
  // CONNECTOR_CREDENTIALS, because ingestion/index imports it and the reverse
  // would be a cycle. A duplication with a guard beats a cycle; a duplication
  // without one is drift waiting to happen — an operator setting a key the
  // registry no longer wants, or not setting one it does.
  for (const [source, needs] of Object.entries(markSourceCredentials())) {
    assert.deepEqual([...needs], [...(CONNECTOR_CREDENTIALS[source] ?? [])],
      `${source}: mark registry and CONNECTOR_CREDENTIALS disagree`);
  }
});

test('an unresolvable business mode prices nothing', () => {
  const env = { BUSINESS_MODE: 'nonsense', TWELVE_DATA_API_KEY: 'td' } as NodeJS.ProcessEnv;
  assert.deepEqual(markSourceStandings(env).filter((m) => m.usable), []);
});
