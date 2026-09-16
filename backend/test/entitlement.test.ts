/**
 * `credentialed` is not `entitled`.
 *
 * The doctor's only `[ok]` line said a source was "permitted for PERSIST and
 * credentialed" while that source answered `403 NOT_AUTHORIZED` to every
 * request the pipeline makes. Every local fact behind that line was correct —
 * the variable was set, the registry mapped it, the mode really did permit it.
 * The false part was an assumption written down nowhere: that a vendor honours
 * the key it issued. No amount of reading source reaches that, which is why
 * fifty-odd audits of source walked past it.
 *
 * These tests are the canary for the fix. The classifier is exercised without
 * a network on purpose: a classifier that can only be driven by really being
 * refused is one that gets tested once, on the day it is written, and then
 * quietly stops meaning anything — which is the failure mode CLAUDE.md records
 * for `committedSecrets.test.ts` ("a check with nothing to check stops working
 * quietly").
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  classifyProbeStatus, probeEntitlement, hasProbe, probeBasis, UNPROBED_REASONS,
  probeableSources, type EntitlementResult,
} from '../src/ingestion/entitlement';
import { getIngestionStatus, mergeEntitlementNotes } from '../src/ingestion/index';
import { mayOperateConnector } from '../src/provenance/rights';
import {
  runChecks, probeChecks, liveChecks, probeTargets, markProbeTarget, markProbeCheck,
  type Check, type LiveState,
} from '../tools/collection/doctor';

const RECORDABLE = ['tradier', 'polygon', 'marketdata', 'schwab', 'tastytrade'];

const blocked = (cs: Check[]) => cs.filter((c) => c.status === 'blocked').map((c) => c.name);
const named = (cs: Check[], n: string) => cs.find((c) => c.name === n)!;
const result = (source: string, state: EntitlementResult['state']): EntitlementResult =>
  ({ source, state, detail: 'x' });

// ─── The classifier ─────────────────────────────────────────────────────────

test('a vendor that serves the endpoint is entitled, and nothing else is', () => {
  for (const source of ['polygon', 'tradier']) {
    assert.equal(classifyProbeStatus(source, 200), 'entitled', source);
    for (const status of [401, 403, 429, 500, 502, null]) {
      assert.notEqual(classifyProbeStatus(source, status), 'entitled',
        `${source} should not read HTTP ${status} as entitled`);
    }
  }
});

test('403 and 401 are kept apart, because the remedy is different', () => {
  // Collapsing these is how an operator spends an afternoon rotating a
  // credential that was always correct. Measured at Polygon on 2026-09-13:
  // 403 carries NOT_AUTHORIZED, 401 carries "Unknown API Key".
  assert.equal(classifyProbeStatus('polygon', 403), 'refused');
  assert.equal(classifyProbeStatus('polygon', 401), 'rejected');
  assert.equal(classifyProbeStatus('tradier', 403), 'refused');
  assert.equal(classifyProbeStatus('tradier', 401), 'rejected');
});

test('a status whose meaning is not established at that vendor is unknown', () => {
  // 429 is a rate limit. It is not an answer about the plan, and reading it as
  // one would be exactly the guess `httpError.ts` argues against.
  for (const source of ['polygon', 'tradier']) {
    assert.equal(classifyProbeStatus(source, 429), 'unknown', source);
    assert.equal(classifyProbeStatus(source, 500), 'unknown', source);
  }
});

test('no response at all is unreachable, never a verdict about the plan', () => {
  assert.equal(classifyProbeStatus('polygon', null), 'unreachable');
  assert.equal(classifyProbeStatus('tradier', null), 'unreachable');
});

test('a source with no probe is unprobed, and never inherits a pass', () => {
  for (const source of ['marketdata', 'schwab', 'tastytrade', 'not_a_source']) {
    for (const status of [200, 401, 403, null]) {
      assert.equal(classifyProbeStatus(source, status), 'unprobed',
        `${source} has no probe and must not be classified from HTTP ${status}`);
    }
  }
});

test('an absent credential is unprobed, not rejected — nothing was asked', () => {
  // Sending an empty key to find out would manufacture a 401 and then report
  // it as though the vendor had passed judgement on this deployment.
  return Promise.all([
    probeEntitlement('polygon', {} as NodeJS.ProcessEnv),
    probeEntitlement('tradier', {} as NodeJS.ProcessEnv),
  ]).then(([p, t]) => {
    assert.equal(p.state, 'unprobed');
    assert.match(p.detail, /POLYGON_API_KEY/);
    assert.equal(t.state, 'unprobed');
    assert.match(t.detail, /TRADIER_TOKEN/);
  });
});

// ─── Coverage ───────────────────────────────────────────────────────────────

test('every recordable source has a probe or a written reason it has none', () => {
  // The gap this closes: a source added to RECORDABLE_SOURCES later, with no
  // probe, would report `unprobed` — which is honest — but nobody would know
  // whether that was a decision or an oversight. Writing the reason down is
  // what tells those apart.
  for (const source of RECORDABLE) {
    const covered = hasProbe(source) || typeof UNPROBED_REASONS[source] === 'string';
    assert.ok(covered,
      `${source} is recordable but has neither an entitlement probe nor an ` +
      `entry in UNPROBED_REASONS saying why not`);
  }
});

test('every probe cites where its status mapping came from', () => {
  // Measured beats documented beats guessed, and a reader weighing a BLOCKED
  // verdict is entitled to know which one they are looking at.
  for (const source of RECORDABLE.filter(hasProbe)) {
    const basis = probeBasis(source);
    assert.ok(basis && basis.length > 40, `${source} needs a basis for its mapping`);
  }
});

test('the probe asks for the endpoint the pipeline actually uses', () => {
  // A plan can be entitled to aggregates and not to trades — which is this
  // deployment, exactly. Probing a cheaper adjacent endpoint would answer a
  // question nobody asked and answer it reassuringly.
  const entitlement = readFileSync(
    join(__dirname, '..', 'src', 'ingestion', 'entitlement.ts'), 'utf8');
  const ingestion = readFileSync(
    join(__dirname, '..', 'src', 'ingestion', 'index.ts'), 'utf8');
  assert.ok(ingestion.includes('/v3/trades/options'),
    'the polygon connector should still poll the trades endpoint');
  assert.ok(entitlement.includes('/v3/trades/options'),
    'and the polygon probe should still ask for that same endpoint');
});

test('the tradier probe does not reuse the profile endpoint', () => {
  // `probeTradierToken` uses /v1/user/profile and the comment above it records
  // that an earlier version drew an entitlement conclusion from it and pointed
  // at the wrong problem. A profile is an account fact; entitlement is a
  // market-data fact. The shape was generalised, not the target.
  const entitlement = readFileSync(
    join(__dirname, '..', 'src', 'ingestion', 'entitlement.ts'), 'utf8');
  const tradierProbe = entitlement.slice(entitlement.indexOf('tradier: {'));
  const request = tradierProbe.slice(0, tradierProbe.indexOf('classify:'));
  assert.ok(!request.includes('/v1/user/profile'),
    'the tradier entitlement probe must not ask /v1/user/profile');
  assert.ok(request.includes('/v1/markets/'),
    'it should ask a market-data endpoint instead');
});

// ─── The checks that count ──────────────────────────────────────────────────

test('a refused vendor blocks collection', () => {
  // The canary for the whole finding. Before this, a 403 from the only
  // persistable source changed nothing about the verdict.
  const cs = probeChecks([result('polygon', 'refused')]);
  assert.deepEqual(blocked(cs), ['Vendor entitlement']);
});

test('a rejected key blocks collection too, and says it is a different fix', () => {
  const cs = probeChecks([result('polygon', 'rejected')]);
  assert.deepEqual(blocked(cs), ['Vendor entitlement']);
  assert.match(named(cs, 'Vendor entitlement').fix!, /reissue/);
});

test('one entitled source is enough, even beside a refused one', () => {
  const cs = probeChecks([result('polygon', 'refused'), result('tradier', 'entitled')]);
  assert.deepEqual(blocked(cs), []);
  assert.equal(named(cs, 'Vendor entitlement').status, 'ok');
});

test('an unreachable vendor is never a blocker', () => {
  // Absence of evidence. Promoting a timeout to a blocker turns flaky wifi
  // into "this deployment cannot collect" — the same class of confidently
  // wrong answer the probe exists to remove.
  for (const state of ['unreachable', 'unknown', 'unprobed'] as const) {
    const cs = probeChecks([result('polygon', state)]);
    assert.deepEqual(blocked(cs), [], `${state} must not block`);
    assert.equal(named(cs, 'Vendor entitlement').status, 'warn', state);
  }
});

test('probing nothing is a warning, not a pass', () => {
  const cs = probeChecks([]);
  assert.equal(named(cs, 'Vendor entitlement').status, 'warn');
});

test('a live board with nothing connected blocks, whatever the config says', () => {
  // This is the contradiction the tool used to print and not count: an `[ok]`
  // config line above `recordable sources connected: none`, with the verdict
  // taken from the first.
  const live: LiveState = {
    connectedRecordable: [], storeKind: 'memory', durable: false,
    recorded: 67, syntheticRecorded: 67, graded: 0,
  };
  assert.deepEqual(blocked(liveChecks(live)).sort(), [
    'A source actually delivering', 'Something real in the record',
  ]);
});

test('a recorder writing only synthetic rows is not progress', () => {
  const live: LiveState = {
    connectedRecordable: ['tradier'], storeKind: 'supabase', durable: true,
    recorded: 400, syntheticRecorded: 400, graded: 0,
  };
  assert.deepEqual(blocked(liveChecks(live)), ['Something real in the record']);
});

test('a live board with a real source and real rows blocks nothing', () => {
  const live: LiveState = {
    connectedRecordable: ['tradier'], storeKind: 'supabase', durable: true,
    recorded: 400, syntheticRecorded: 12, graded: 91,
  };
  assert.deepEqual(blocked(liveChecks(live)), []);
});

// ─── The rights gate, which a probe is subject to ───────────────────────────

test('a probe is a request, so a refused source is never contacted', () => {
  // `startConnector` runs the gate before `start()` because the request itself
  // is the act a publisher's terms govern. A diagnostic is not exempt: nothing
  // is PERMITTED for PERSIST in PUBLIC_COMMERCIAL, so nothing may be asked.
  const env = {
    BUSINESS_MODE: 'PUBLIC_COMMERCIAL',
    POLYGON_API_KEY: 'k', TRADIER_TOKEN: 't',
  } as NodeJS.ProcessEnv;
  assert.deepEqual(probeTargets(env), []);
});

test('a mode that will not resolve contacts nobody', () => {
  const env = { BUSINESS_MODE: 'public', POLYGON_API_KEY: 'k' } as NodeJS.ProcessEnv;
  assert.deepEqual(probeTargets(env), []);
});

test('probing targets exactly what the credential check counted', () => {
  const env = {
    BUSINESS_MODE: 'PRIVATE_RESEARCH', POLYGON_API_KEY: 'k',
    SCHWAB_APP_KEY: 'a', SCHWAB_APP_SECRET: 'b', // deliberately incomplete
  } as NodeJS.ProcessEnv;
  assert.deepEqual(probeTargets(env), ['polygon']);
});

// ─── The line the finding was about ─────────────────────────────────────────

test('a config-only run never claims a vendor will serve the key', () => {
  // The regression canary for Finding A itself. If this check goes back to
  // `ok`, the tool is once again asserting entitlement it has not checked —
  // in the one program an operator opens because they are unsure what is live.
  const env = {
    BUSINESS_MODE: 'PRIVATE_RESEARCH', TRADIER_TOKEN: 'tok',
    SUPABASE_URL: 'u', SUPABASE_SERVICE_KEY: 'k', TWELVE_DATA_API_KEY: 'td',
  } as NodeJS.ProcessEnv;
  const c = named(runChecks(env), 'A source permitted to persist');
  assert.equal(c.status, 'warn');
  assert.match(c.detail, /NOT been checked against the vendor/);
  assert.match(c.fix!, /--probe/);
});

test('every check that is not ok says what to do about it', () => {
  const all: Check[] = [
    ...runChecks({} as NodeJS.ProcessEnv),
    ...probeChecks([result('polygon', 'refused')]),
    ...probeChecks([result('polygon', 'unreachable')]),
    ...probeChecks([]),
    ...liveChecks({
      connectedRecordable: [], storeKind: 'memory', durable: false,
      recorded: 5, syntheticRecorded: 5, graded: 0,
    }),
  ];
  for (const c of all) {
    if (c.status !== 'ok') {
      assert.ok(c.fix && c.fix.length > 30, `${c.name} (${c.status}) needs a fix line`);
    }
  }
});

test('the verdict is computed after the probe and the live board, not before', () => {
  // The original bug was not a wrong check — it was a right one that arrived
  // too late to count. `readLive` always fetched the live board and `main`
  // always printed it; `blocked` was taken from the config checks alone, so a
  // run could print `recordable sources connected: none` underneath a verdict
  // that had already decided otherwise.
  //
  // `probeChecks` and `liveChecks` are unit-tested above, but nothing there
  // proves `main` *uses* them, and the whole finding is about a result being
  // computed and then not used. This asserts position, the way
  // `dotenvOrder.test.ts` asserts that `import 'dotenv/config'` comes first.
  const src = readFileSync(
    join(__dirname, '..', 'tools', 'collection', 'doctor.ts'), 'utf8');
  const main = src.slice(src.indexOf('async function main('));

  const probePush = main.indexOf('checks.push(...probeChecks(');
  const livePush = main.indexOf('checks.push(...liveChecks(');
  const verdict = main.indexOf('const blocked = checks.filter(');

  assert.ok(probePush > 0, 'main should fold the entitlement probe into checks');
  assert.ok(livePush > 0, 'main should fold the live board into checks');
  assert.ok(verdict > 0, 'main should still compute a blocked list');
  assert.ok(probePush < verdict,
    'the entitlement probe must reach the verdict, not be printed beside it');
  assert.ok(livePush < verdict,
    'the live board must reach the verdict, not be printed beside it');
});

// ─── The mark source: the same defect, twenty lines away in the same file ───

test('a set mark-source variable is not a claim that the grader can price', () => {
  // Check 4 said "TWELVE_DATA_API_KEY is set — the grader **can** price an
  // underlying", derived from a string-emptiness test on process.env. That is
  // check 2's defect in the same function. Fixing one and not the other would
  // have left the ledger claiming a pattern was eliminated while a live `ok`
  // line still did it.
  const env = {
    BUSINESS_MODE: 'PRIVATE_RESEARCH', TRADIER_TOKEN: 'tok',
    SUPABASE_URL: 'u', SUPABASE_SERVICE_KEY: 'k', TWELVE_DATA_API_KEY: 'td',
  } as NodeJS.ProcessEnv;
  const c = named(runChecks(env), 'Underlying marks for grading');
  assert.equal(c.status, 'warn');
  assert.match(c.fix!, /--probe/);
});

test('twelve data speaks in an envelope, and a 200 can still be a refusal', () => {
  // The reason `classify` takes a body at all. Twelve Data answers
  // {"code":401,"status":"error"} and is documented to do so under HTTP 200 on
  // some endpoints; a probe reading the status alone would call that entitled.
  assert.equal(classifyProbeStatus('twelvedata', 200, { price: '332.23' }), 'entitled');
  assert.equal(classifyProbeStatus('twelvedata', 200, { code: 401, status: 'error' }), 'rejected');
  assert.equal(classifyProbeStatus('twelvedata', 200, { code: 403, status: 'error' }), 'refused');
  assert.equal(classifyProbeStatus('twelvedata', 401, { code: 401, status: 'error' }), 'rejected');
  // A success body that merely happens to carry a `code` is not a refusal.
  assert.equal(classifyProbeStatus('twelvedata', 200, { code: 200, price: '1' }), 'entitled');
});

test('the mark source is probed on the connector gate, not the PERSIST gate', () => {
  // Twelve Data is UNVERIFIED for PERSIST in both modes, so `probeTargets`
  // correctly never returns it — and the one source every graded outcome
  // derives from would never be asked anything. The gate that governs making
  // the request is the one `startConnector` runs.
  const env = {
    BUSINESS_MODE: 'PRIVATE_RESEARCH', TWELVE_DATA_API_KEY: 'td',
  } as NodeJS.ProcessEnv;
  assert.ok(!probeTargets(env).includes('twelvedata'),
    'the PERSIST gate must still exclude it');
  assert.equal(markProbeTarget(env), 'twelvedata',
    'and the connector gate must still reach it');
});

test('an unset mark-source key means there is nothing to ask', () => {
  const env = { BUSINESS_MODE: 'PRIVATE_RESEARCH' } as NodeJS.ProcessEnv;
  assert.equal(markProbeTarget(env), null);
  assert.equal(named(markProbeCheck(null), 'Mark source entitlement').status, 'warn');
});

test('a refused mark source blocks, because the grader has only the one', () => {
  // Not a degraded feed — every outcome returns UNGRADED while the options
  // side reports perfectly healthy.
  for (const state of ['refused', 'rejected'] as const) {
    const cs = markProbeCheck(result('twelvedata', state));
    assert.deepEqual(blocked(cs), ['Mark source entitlement'], state);
  }
  for (const state of ['unreachable', 'unknown', 'unprobed'] as const) {
    assert.deepEqual(blocked(markProbeCheck(result('twelvedata', state))), [], state);
  }
  assert.deepEqual(blocked(markProbeCheck(result('twelvedata', 'entitled'))), []);
});

test('no check claims a capability it has not exercised', () => {
  // The sweep, stated as a rule rather than as three fixes. `has()` proves a
  // variable is set; every `ok` built from it alone used to describe what the
  // system could *do* — "the grader can price an underlying", "records survive
  // a restart" — and one of those was false on this very deployment. A config
  // check may report what it read. It may not promise what will happen.
  const env = {
    BUSINESS_MODE: 'PRIVATE_RESEARCH', TRADIER_TOKEN: 'tok',
    SUPABASE_URL: 'u', SUPABASE_SERVICE_KEY: 'k', TWELVE_DATA_API_KEY: 'td',
  } as NodeJS.ProcessEnv;
  for (const c of runChecks(env)) {
    if (c.status !== 'ok') continue;
    assert.ok(!/\b(can|will|survive|survives)\b/i.test(c.detail),
      `"${c.name}" reports ok from configuration alone and still promises an ` +
      `outcome: "${c.detail}"`);
  }
});

// ─── 1.1b: the probe at startup, not only from the tool ─────────────────────

test('probing is gated on the connector gate, credentials, and a probe existing', () => {
  // The three conditions live in one place so the doctor and the running
  // server cannot drift into asking different questions.
  const full = {
    BUSINESS_MODE: 'PRIVATE_RESEARCH',
    POLYGON_API_KEY: 'p', TRADIER_TOKEN: 't', TWELVE_DATA_API_KEY: 'd',
  } as NodeJS.ProcessEnv;
  assert.deepEqual(probeableSources(full).sort(), ['polygon', 'tradier', 'twelvedata']);

  // A missing key is not a probe target: asking with an empty credential
  // manufactures a 401 and then reports it as a vendor verdict.
  const partial = { ...full };
  delete partial.TRADIER_TOKEN;
  assert.deepEqual(probeableSources(partial).sort(), ['polygon', 'twelvedata']);

  // A mode that will not resolve asks nobody. `resolveBusinessMode` throws
  // rather than guessing, and a rights decision we cannot make is not one to
  // make optimistically.
  assert.deepEqual(probeableSources({ ...full, BUSINESS_MODE: 'nonsense' } as NodeJS.ProcessEnv), []);
});

test('the probe gate is the connector gate, exactly — not a stricter copy', () => {
  // Written after getting this wrong: the first version of the test above
  // expected PUBLIC_COMMERCIAL to empty the list, reasoning that nothing may
  // be persisted there. But `mayOperateConnector` refuses `PROHIBITED` **only**
  // — deliberately, and `connectorGate.test.ts` keeps a canary against
  // widening it — and these three are `UNVERIFIED` for DISPLAY in commercial
  // mode, not prohibited. The connector would make the request, so the probe
  // may too; asking a narrower question here would mean the diagnostic
  // silently skipped sources the server really does contact.
  //
  // So the invariant is the coupling itself, asserted in both modes rather
  // than a hardcoded list that would drift the moment a rights entry changed.
  for (const mode of ['PRIVATE_RESEARCH', 'PUBLIC_COMMERCIAL']) {
    const env = {
      BUSINESS_MODE: mode,
      POLYGON_API_KEY: 'p', TRADIER_TOKEN: 't', TWELVE_DATA_API_KEY: 'd',
    } as NodeJS.ProcessEnv;
    for (const source of probeableSources(env)) {
      assert.ok(mayOperateConnector(source, mode as any).allowed,
        `${source} is probed in ${mode} but the connector gate refuses it`);
    }
  }
});

test('the mark source is probed at startup even though PERSIST is UNVERIFIED', () => {
  // The gap that made this its own gate: Twelve Data is UNVERIFIED for PERSIST
  // in both modes, so a PERSIST-filtered sweep would never ask the one source
  // every graded outcome derives from.
  const env = {
    BUSINESS_MODE: 'PRIVATE_RESEARCH', TWELVE_DATA_API_KEY: 'd',
  } as NodeJS.ProcessEnv;
  assert.deepEqual(probeableSources(env), ['twelvedata']);
});

test('a denial reaches the notes channel and never the sources field', () => {
  // Two writers on one health field is how a connector failure got overwritten
  // by `startConnector` recording what `start()` returned. The probe is a
  // second opinion, not a second author.
  const notes: Record<string, string> = { polygon: 'NBBO lookups refused' };
  mergeEntitlementNotes(notes, {
    polygon: { state: 'refused', detail: 'HTTP 403 — NOT_AUTHORIZED' },
    tradier: { state: 'entitled', detail: 'HTTP 200' },
    twelvedata: { state: 'unreachable', detail: 'timeout' },
  });
  // Appended, not replaced.
  assert.match(notes.polygon!, /NBBO lookups refused; entitlement refused: /);
  // Nothing is asserted about a source that was not refused — least of all
  // about one we merely failed to reach.
  assert.equal('tradier' in notes, false);
  assert.equal('twelvedata' in notes, false);
});

test('an unreachable vendor leaves no permanent note on the board', () => {
  // A standing "we could not check" line teaches an operator to stop reading
  // the board, which costs more than it tells them.
  for (const state of ['unreachable', 'unknown', 'unprobed', 'entitled']) {
    const notes: Record<string, string> = {};
    mergeEntitlementNotes(notes, { polygon: { state, detail: 'x' } });
    assert.deepEqual(notes, {}, state);
  }
});

test('the health projection carries the probe verdict, scrubbed', () => {
  // /api/health is unauthenticated, so every string here is public — and the
  // Polygon probe puts the key in the query string, which some vendors echo
  // back in the error body. This is the same rule healthLeak.test.ts holds the
  // signal-history block to.
  const status = getIngestionStatus() as any;
  assert.ok(status.entitlement && typeof status.entitlement === 'object',
    '/api/health should carry an entitlement block');
  const serialised = JSON.stringify(status.entitlement);
  assert.equal(/api[_-]?key=(?!\[REDACTED\])[A-Za-z0-9]/i.test(serialised), false,
    'no live key may appear in the entitlement block');
  assert.equal(/bearer\s+[A-Za-z0-9]{8,}/i.test(serialised), false,
    'and no bearer token either');
});

test('the probe timer releases the event loop', () => {
  // Every poller in src/ must, and the widened guard in missingIsNotZero
  // enforces it — this asserts the specific one added here, so a reader of
  // this file sees the obligation rather than inferring it.
  const src = readFileSync(join(__dirname, '..', 'src', 'ingestion', 'index.ts'), 'utf8');
  assert.match(src, /setInterval\(sweep, ENTITLEMENT_REPROBE_MS\)\.unref\(\)/);
});
