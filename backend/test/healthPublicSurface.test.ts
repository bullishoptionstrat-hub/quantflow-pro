/**
 * `/api/health` is unauthenticated, so the WHOLE payload is public — and until
 * now only one block of it was checked.
 *
 * `healthLeak.test.ts` drives `getSignalHistoryStatus()` and asserts the
 * recorder's raw error never reaches the wire. That is one field. The route also
 * publishes `ingestion` (sources, errors, notes, entitlement, rights refusals,
 * mark sources, OCC volume, coverage), `enrichment`, `history`, `session`,
 * `uptime` and `memory` — and nothing looked at the payload as a whole.
 *
 * **Found from the outside.** A PR-audit bot flagged `src/market/session.ts` as
 * a "security-sensitive path", which is a match on the word *session* — that
 * file reads a calendar and a clock, touches no credential, no request input and
 * no network. The premise was wrong and the adjacent question was not: a field
 * had just been added to an unauthenticated payload and no guard covered the
 * payload. This is the guard-scope failure this repository has now found six
 * times, so the fix is the whole surface rather than one more named block.
 *
 * It drives the **real router** rather than re-composing the four status
 * functions, because a test that rebuilds the route is a second copy of it and
 * would go on passing after the route started publishing something else.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import healthRouter from '../src/routes/health';

/** Every string value in the payload, with the path that produced it. */
function strings(v: unknown, path = '$'): Array<[string, string]> {
  if (typeof v === 'string') return [[path, v]];
  if (Array.isArray(v)) return v.flatMap((x, i) => strings(x, `${path}[${i}]`));
  if (v && typeof v === 'object') {
    return Object.entries(v).flatMap(([k, x]) => strings(x, `${path}.${k}`));
  }
  return [];
}

async function readHealth(): Promise<unknown> {
  const app = express();
  app.use('/api/health', healthRouter);
  const server = app.listen(0);
  try {
    await new Promise<void>((r) => server.once('listening', () => r()));
    const { port } = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}/api/health`);
    assert.equal(res.status, 200, 'the route answers unauthenticated');
    return await res.json();
  } finally {
    server.close();
  }
}

/**
 * Shapes that must never appear anywhere in the payload.
 *
 * Patterns rather than a field list, for the reason `defaultedReadings.test.ts`
 * argues: a list of fields fails silent, because a field nobody added to it
 * passes. A pattern that is too narrow fails loud — an unmatched secret is a
 * finding somebody answers — and the dangerous error is a pattern too broad,
 * which is why each is anchored to a real credential prefix rather than to the
 * word "key".
 */
const SECRET_SHAPES: Array<[RegExp, string]> = [
  [/\bsk-[A-Za-z0-9]{16,}/, 'an OpenAI-style secret'],
  [/\bfc-[A-Za-z0-9]{20,}/, 'a Firecrawl key'],
  [/\bsb_secret_[A-Za-z0-9_-]{10,}/, 'a Supabase secret key'],
  [/\bsb_publishable_[A-Za-z0-9_-]{10,}/, 'a Supabase publishable key'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./, 'a JWT'],
  [/\bBearer\s+\S{8,}/i, 'an Authorization header value'],
  [/\bapikey=|\bapi_key=|\btoken=|\bapikey%3D/i, 'a credential in a query string'],
  [/postgres(ql)?:\/\/[^\s"]*:[^\s"]*@/i, 'a Postgres URL with a password'],
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/, 'an email address'],
];

test('nothing credential-shaped appears anywhere in the public payload', async () => {
  const body = await readHealth();
  const offenders: string[] = [];
  for (const [path, s] of strings(body)) {
    for (const [re, what] of SECRET_SHAPES) {
      if (re.test(s)) offenders.push(`${path}: ${what}`);
    }
  }
  assert.deepEqual(offenders, [],
    'every string on /api/health is public — `describeHttpError` exists because ' +
    'this was learned once already, with `sourceErrors`');
});

test('the detector is exercised on the shapes it exists to catch', async () => {
  // With the route clean it has nothing live left to find, and a check with
  // nothing to check stops working quietly — the `committedSecrets.test.ts`
  // lesson. So it is run against a payload of the real shapes.
  // Every planted value is ASSEMBLED at runtime, never written as one literal.
  // `committedSecrets.test.ts` scans source for these same shapes, and a
  // fixture that spells a credential out in full is — to that guard, correctly
  // — a committed credential. This file shipped that way once: it passed the
  // pre-commit verify (the file was untracked, so invisible) and failed the
  // first run against the pushed head. Concatenation keeps the runtime value
  // the detector must catch while the source text carries no whole secret.
  const j = (...parts: string[]) => parts.join('');
  const planted = {
    ingestion: {
      sourceErrors: { a: j('HTTP 401 — {"apikey":"', 'sk', '-', 'abcdefghijklmnopqrst', '"}') },
      sourceNotes: { b: j('GET https://x/quote?', 'apikey', '=deadbeefcafe failed') },
    },
    history: { reason: j('postgres', '://user:', 'hunter2', '@db.example.co:5432/postgres') },
    session: { basis: 'ok' },
    who: j('ops', '@', 'example.com'),
    jwt: j('ey', 'JhbGciOiJIUzI1NiJ9', '.', 'eyJyb2xlIjoiYW5vbiJ9', '.sig'),
  };
  const caught = new Set<string>();
  for (const [, s] of strings(planted)) {
    for (const [re, what] of SECRET_SHAPES) if (re.test(s)) caught.add(what);
  }
  for (const want of [
    'an OpenAI-style secret', 'a credential in a query string',
    'a Postgres URL with a password', 'an email address', 'a JWT',
  ]) {
    assert.ok(caught.has(want), `the detector catches ${want}`);
  }
});

test('the session block publishes calendar facts and nothing about the deployment', async () => {
  // The field the bot pointed at, checked on its own terms rather than by
  // asserting the bot was wrong. Its keys are a state, a date, three integers,
  // the calendar's own prose, the publisher's name, a read date, a coverage
  // range and the constant naming which session authority this is — all
  // public facts about the NYSE schedule.
  const body = await readHealth() as { session?: Record<string, unknown> };
  assert.ok(body.session, '/api/health carries the session verdict');
  assert.deepEqual(Object.keys(body.session).sort(), [
    'authority', 'basis', 'closeMinutesEt', 'coverage', 'date', 'nowMinutesEt',
    'openMinutesEt', 'readAt', 'source', 'state',
  ], 'the published shape is exactly this — a new key here needs a look, ' +
     'because everything on this route is world-readable');
});
