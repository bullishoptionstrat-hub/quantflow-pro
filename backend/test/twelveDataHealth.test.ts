/**
 * The mark source must not report `connected` while every poll fails.
 *
 * This is the third instance of one family. Stooq served a browser-challenge
 * page under HTTP 200 and cached twelve zeros while `/api/health` said
 * `connected`; CoinGecko was rate-limited and kept saying `connected` while
 * serving an ageing cache. Both were given a per-cycle health callback. Twelve
 * Data never got one — its batch swallowed every failure in a bare
 * `console.error`, so `startTwelveData` resolved cleanly on a request that had
 * already failed and `startConnector` recorded `connected`.
 *
 * It is the worst place for it. `markSources` lists exactly `['twelvedata']`,
 * so every graded outcome takes its underlying mark from this connector. A
 * silent failure here is indistinguishable from a quiet market, and "why is
 * every outcome UNGRADED" was answerable only by reading the process log.
 *
 * The 429 body below is verbatim from the live API on 2026-09-16, free Basic
 * plan, with this deployment's own ten-symbol batch.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CONNECTOR = join(__dirname, '..', 'src', 'ingestion', 'connectors', 'twelveData.ts');

/** What Twelve Data actually answers a 10-symbol `/quote` with on free Basic. */
const CREDIT_BODY = {
  code: 429,
  message:
    'You have run out of API credits for the current minute. 10 API credits were used, ' +
    'with the current limit being 8. Wait for the next minute or consider switching to a higher plan.',
  status: 'error',
};

const KEY = 'test-key-not-a-real-one';

// ─── The failure is reported at all ─────────────────────────────────────────

test('a credit-exhausted batch reports failure instead of logging it', async () => {
  const { td, health } = await load({ reject: httpError(429, CREDIT_BODY) });
  await td.startTwelveData();

  assert.ok(health.length > 0, 'the cycle must report its health, not just print it');
  const last = health[health.length - 1];
  assert.equal(last.ok, false, 'a 429 with an empty cache is not a healthy source');
  assert.match(last.reason, /out of API credits/, "the vendor's own words");
});

test('the reason names our batch size, which is the part the vendor cannot know', () => {
  // The vendor says "10 API credits were used, with the current limit being 8"
  // without knowing where the 10 came from. It is `WATCHED.length`: Twelve Data
  // charges one credit per symbol, so the batch size *is* the credit cost and
  // ten against a cap of eight cannot succeed — not intermittently, ever. An
  // operator reading only the vendor's half would wait for the next minute.
  const src = readFileSync(CONNECTOR, 'utf8');
  assert.match(src, /\$\{WATCHED\.length\} symbols per cycle/,
    'the 429 reason should derive the count from WATCHED, not restate a literal');
});

test('the failure reason never carries the key', async () => {
  // /api/health is unauthenticated, and this connector puts its key in the
  // query string — so an echoed URL in an error body is a published credential.
  const { td, health } = await load({
    reject: httpError(401, { message: `Invalid request to /quote?apikey=${KEY}` }),
  });
  await td.startTwelveData();
  const last = health[health.length - 1];
  assert.ok(last, 'the cycle must report — an unreported failure passes this vacuously');
  assert.match(last.reason, /apikey=\[REDACTED\]/);
  assert.ok(!JSON.stringify(health).includes(KEY), 'the key must be scrubbed');
});

// ─── It does not just refuse everything ─────────────────────────────────────

test('a batch that prices symbols reports ok, and caches them', async () => {
  const { td, health } = await load({
    resolve: { SPY: quote('SPY', '661.74'), QQQ: quote('QQQ', '598.12') },
  });
  await td.startTwelveData();

  assert.deepEqual(health[health.length - 1], { ok: true });
  assert.equal(td.getSpotPrice('SPY'), 661.74);
});

// ─── The shapes that used to read as success ────────────────────────────────

test('HTTP 200 with an error body is not a successful cycle', async () => {
  // Twelve Data answers some refusals with 200 and an error envelope — the same
  // asymmetry `classifyProbeStatus` exists for. Read as a symbol map this is one
  // entry named `status`, so the old code priced nothing and said nothing.
  const { td, health } = await load({ resolve: { code: 401, status: 'error',
    message: 'Your API key is invalid' } });
  await td.startTwelveData();

  const last = health[health.length - 1];
  assert.equal(last.ok, false);
  assert.match(last.reason, /Your API key is invalid/);
  assert.equal(td.getSpotQuotes().size, 0);
});

test('a batch where every symbol is refused is a failure, not a quiet market', async () => {
  const { td, health } = await load({
    resolve: { SPY: { status: 'error', message: 'no' }, QQQ: { status: 'error', message: 'no' } },
  });
  await td.startTwelveData();

  const last = health[health.length - 1];
  assert.equal(last.ok, false);
  assert.match(last.reason, /no priced symbol/);
  assert.match(last.reason, /2 refused/);
});

// ─── Two paths, failing independently ───────────────────────────────────────

test('a failing batch while the stream delivers is degraded, not down', async (t) => {
  // The REST batch and the WebSocket are independent paths into one cache.
  // Reporting `error` while the socket feeds the board would be as false as
  // reporting `connected` while it does not, so the note channel carries it —
  // the settings page already renders connected-with-a-note as DEGRADED.
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { td, health, sockets } = await load({ reject: httpError(429, CREDIT_BODY) });
  await td.startTwelveData();
  assert.equal(health[health.length - 1].ok, false, 'nothing has arrived yet');

  // A price frame off the socket: the board is now being fed.
  sockets[0].emit('message', Buffer.from(JSON.stringify({
    event: 'price', symbol: 'SPY', price: '661.74', timestamp: 1789000000,
  })));
  assert.equal(td.getSpotPrice('SPY'), 661.74);

  t.mock.timers.tick(60_000);
  await new Promise((r) => setImmediate(r));

  const last = health[health.length - 1];
  assert.equal(last.ok, true, 'the stream is delivering, so the source is contributing');
  assert.equal(last.degraded, true);
  assert.match(last.reason, /REST quote batch failing/);
});

// ─── The structural claim about startConnector ──────────────────────────────

test('the report lands before startTwelveData resolves', async () => {
  // `startConnector` sets `connected` in the `.then()` of `start()`, and has one
  // escape hatch: it leaves the source alone if it already reads `error`. That
  // hatch is only reachable if the connector reports during `start()` — which is
  // exactly where the first `fetchQuotesBatch` runs.
  const { td, health } = await load({ reject: httpError(429, CREDIT_BODY) });
  const promise = td.startTwelveData();
  await promise;
  assert.ok(health.length >= 1, 'health must be reported by the time start() resolves');
  assert.equal(health[0].ok, false);
});

test('the wiring routes ok, degraded and failure to three different places', () => {
  const src = readFileSync(
    join(__dirname, '..', 'src', 'ingestion', 'index.ts'), 'utf8');
  const block = src.slice(src.indexOf('onTwelveDataHealth(('));
  assert.ok(block.length > 0, 'startIngestion must subscribe to Twelve Data health');
  const wiring = block.slice(0, block.indexOf('\n  });'));
  assert.match(wiring, /sources\['twelvedata'\] = 'connected'/);
  assert.match(wiring, /connectorNotes\['twelvedata'\] = h\.reason/);
  assert.match(wiring, /sources\['twelvedata'\] = 'error'/);
});

test('the batch no longer swallows its failure', () => {
  const src = readFileSync(CONNECTOR, 'utf8');
  const tail = src.slice(src.indexOf('  } catch (err: any) {'));
  const body = tail.slice(0, tail.indexOf('\n  }\n'));
  assert.match(body, /reportFailure\(/,
    'the catch must report, not just print — a bare console.error there is the defect');
});

// ─── Harness ────────────────────────────────────────────────────────────────

function quote(symbol: string, close: string) {
  return { symbol, close, change: '1.20', percent_change: '0.18',
    volume: '70000000', timestamp: 1789000000 };
}

function httpError(status: number, data: unknown) {
  return Object.assign(new Error(`Request failed with status code ${status}`),
    { response: { status, data } });
}

/** A recording stand-in for a `ws` socket; the test drives its handlers. */
class FakeSocket {
  handlers: Record<string, Function[]> = {};
  on(event: string, fn: Function) { (this.handlers[event] ??= []).push(fn); return this; }
  send() {}
  emit(event: string, ...args: any[]) { for (const h of this.handlers[event] ?? []) h(...args); }
}

/**
 * Load the connector against a stubbed axios and `ws`.
 *
 * Fresh per test: the connector holds its cache, its health handler and its
 * delivery clock in module scope, and a leaked cache would let one test's quote
 * make another test's failure look degraded.
 */
async function load(resp: { resolve?: unknown; reject?: unknown }) {
  const sockets: FakeSocket[] = [];
  const get = async () => {
    if (resp.reject) throw resp.reject;
    return { data: resp.resolve };
  };
  const FakeWS: any = function () { const s = new FakeSocket(); sockets.push(s); return s; };

  const td = freshRequire('../src/ingestion/connectors/twelveData', {
    axios: { default: { get }, get },
    ws: { __esModule: true, default: FakeWS },
  });

  const health: any[] = [];
  td.onTwelveDataHealth((h: any) => health.push(h));
  return { td, health, sockets };
}

function freshRequire(path: string, stubs: Record<string, any>) {
  const resolved = require.resolve(path);
  const saved: Record<string, any> = {};
  const paths: Record<string, string> = {};
  for (const [name, exports] of Object.entries(stubs)) {
    const p = require.resolve(name);
    paths[name] = p;
    saved[name] = require.cache[p];
    require.cache[p] = { id: p, filename: p, loaded: true, exports } as any;
  }
  const savedKey = process.env.TWELVE_DATA_API_KEY;
  process.env.TWELVE_DATA_API_KEY = KEY;
  delete require.cache[resolved];
  try {
    return require(resolved);
  } finally {
    if (savedKey === undefined) delete process.env.TWELVE_DATA_API_KEY;
    else process.env.TWELVE_DATA_API_KEY = savedKey;
    for (const [name, p] of Object.entries(paths)) {
      if (saved[name]) require.cache[p] = saved[name];
      else delete require.cache[p];
    }
    delete require.cache[resolved];
  }
}
