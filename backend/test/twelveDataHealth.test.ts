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

test('the reason names the size of the request that was refused', () => {
  // The vendor says "10 API credits were used, with the current limit being 8"
  // without knowing where the 10 came from. Twelve Data charges one credit per
  // symbol, so the request's size *is* its credit cost — an operator reading
  // only the vendor's half would wait for the next minute.
  //
  // It used to read `${WATCHED.length}`, which was true only while every cycle
  // asked for the whole board. Now that the rotation is scoped to
  // `restSymbols()` and cut to the per-minute cap, those differ, and a reason
  // reporting ten for a request that sent eight is a wrong number pointing at
  // a batch size the code no longer has.
  const src = readFileSync(CONNECTOR, 'utf8');
  assert.match(src, /\$\{symbols\.length\} symbol/,
    'the 429 reason must derive its count from the request, not from WATCHED');
  assert.ok(!/\$\{WATCHED\.length\} symbols per cycle/.test(src),
    'the old board-sized claim must be gone, not merely joined by a second one');
});

// ─── The socket's entitlement, and the budget that follows from it ──────────

test('the rotation is scoped by the ack, not by a list written in this file', async () => {
  // Measured 2026-09-17 on the live free-tier key: subscribing to all ten
  // watched symbols returns QQQ and AAPL in `success` and the other eight in
  // `fails`. Probed apart, SPY alone is refused and QQQ alone is accepted — so
  // the plan is scoped by symbol, not capped by count. Hard-coding the pair
  // here would be an assertion about someone else's plan; the ack is the only
  // authority, and it is free.
  const { td, sockets } = await load({ resolve: {} });
  await td.startTwelveData();
  assert.deepEqual(td.restSymbols().length, 10, 'before the ack, REST must cover everything');

  ack(sockets[0], ['QQQ', 'AAPL'], ['SPY', 'NVDA', 'TSLA', 'MSFT', 'AMD', 'META', 'AMZN', 'MSTR']);

  // Being accepted is a promise, not a delivery. Until each accepted symbol
  // actually arrives, REST keeps covering it — off-hours the socket accepts
  // QQQ and sends nothing for fifteen hours, and dropping it from the rotation
  // on the strength of the ack would be the same "configured means working"
  // move this connector keeps being fixed for.
  assert.equal(td.restSymbols().length, 10, 'an accepted symbol that has never arrived is covered');

  for (const symbol of ['QQQ', 'AAPL']) {
    sockets[0].emit('message', Buffer.from(JSON.stringify({
      event: 'price', symbol, price: '598.12', timestamp: 1789000000,
    })));
  }

  const rest = td.restSymbols();
  assert.ok(!rest.includes('QQQ') && !rest.includes('AAPL'), 'these two are arriving on the socket');
  assert.ok(rest.includes('SPY'), 'SPY is refused by the plan — REST is its only path to a mark');
  assert.equal(rest.length, 8);

  const src = readFileSync(CONNECTOR, 'utf8');
  assert.ok(!/streamAccepted\s*=\s*new Set\(\[/.test(src),
    'the accepted set must come from the vendor, never from a literal here');
});

test('the accepted set is read from success/fails, not from the ack status string', async () => {
  // The status varied across the live probes — `ok` when all ten were... they
  // never were; `warning` on the partial, `error` when every symbol failed.
  // Keying off that string would read the measured partial (`warning`) as a
  // failure and drop the two symbols the socket does carry.
  const { td, sockets } = await load({ resolve: {} });
  await td.startTwelveData();
  ack(sockets[0], ['QQQ'], ['SPY'], 'error');
  sockets[0].emit('message', Buffer.from(JSON.stringify({
    event: 'price', symbol: 'QQQ', price: '598.12', timestamp: 1789000000,
  })));
  assert.ok(!td.restSymbols().includes('QQQ'),
    'a symbol in `success` is carried whatever the envelope calls the ack');
});

test('an accepted symbol that stops arriving comes back onto REST', async (t) => {
  // The trap in the global version: with QQQ streaming, one "something arrived
  // recently" test would suppress REST for the whole board and starve the
  // eight symbols that have no other path. Delivery is tracked per symbol, so
  // a silent-but-accepted symbol is re-covered rather than assumed healthy.
  const { td, sockets } = await load({ resolve: {} });
  await td.startTwelveData();
  ack(sockets[0], ['QQQ', 'AAPL'], ['SPY']);
  sockets[0].emit('message', Buffer.from(JSON.stringify({
    event: 'price', symbol: 'QQQ', price: '598.12', timestamp: 1789000000,
  })));
  assert.ok(!td.restSymbols().includes('QQQ'), 'it is arriving, so REST need not buy it');

  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + td.STREAM_GRACE_MS + 1 });
  assert.ok(td.restSymbols().includes('QQQ'),
    'accepted is not delivering — after the grace window REST covers it again');
});

test('the cadence fits the daily credit cap, which chunking alone does not', () => {
  // The arithmetic that decides the design. The old poller asked for ten
  // symbols every 60s: 14,400 credits/day against a cap of 800, eighteen times
  // over. Chunking under the per-minute cap clears the 429 and still exhausts
  // the day in ~80 cycles — healthy for an hour, then dark.
  const { rotationIntervalMs, chunkSymbols, DAILY_CREDIT_CAP, RESERVED_DAILY_CREDITS,
    PER_MINUTE_CREDIT_CAP, RESERVED_PER_MINUTE_CREDITS,
    MAX_SYMBOLS_PER_REQUEST } = require('../src/ingestion/connectors/twelveData');
  const DAY = 86_400_000;
  const usable = DAILY_CREDIT_CAP - RESERVED_DAILY_CREDITS;

  for (const credits of [1, 2, 5, 8, 10, 25]) {
    const spendPerDay = Math.floor(DAY / rotationIntervalMs(credits)) * credits;
    assert.ok(spendPerDay <= usable,
      `${credits} symbols/rotation spends ${spendPerDay}/day against ${usable} usable`);
  }

  // The measured state: eight symbols on REST.
  assert.ok(rotationIntervalMs(8) > 60_000 * 15,
    'eight symbols cannot be refreshed inside the M15 horizon on this budget — ' +
    'the note must say so rather than the cadence pretending otherwise');

  // Chunking is what stops the 429, and it is not what stops the overspend.
  // The cap a request is cut to is the per-minute cap *less* what the
  // entitlement probe needs from the same minute: measured on the first live
  // boot, a request sized to the full eight made the vendor refuse the probe
  // ("9 API credits were used, with the current limit being 8"), and the one
  // source the grader depends on reported `unknown`.
  for (const chunk of chunkSymbols(['a','b','c','d','e','f','g','h','i','j'])) {
    assert.ok(chunk.length <= MAX_SYMBOLS_PER_REQUEST, 'no request may exceed the per-minute cap');
    assert.ok(chunk.length + RESERVED_PER_MINUTE_CREDITS <= PER_MINUTE_CREDIT_CAP,
      'a request must leave the entitlement probe room inside the same minute');
  }
  assert.equal(chunkSymbols([]).length, 0);
});

test('the rotation does not spend between passes', async () => {
  // `rotationIntervalMs` only means anything if something waits it out. Ten
  // symbols is two chunks; after both, the next tick must buy nothing.
  const { td, requests } = await load({ resolve: {} });
  await td.startTwelveData();
  assert.equal(requests.length, 1, 'boot issues one request, not the whole board');
  assert.equal(requests[0].length, 6,
    'and it is cut to the per-minute cap less the entitlement probe reservation');

  await td.tick();
  assert.equal(requests.length, 2, 'mid-pass, the remaining chunk is owed');
  assert.deepEqual(requests[1], ['AMD', 'META', 'AMZN', 'MSTR']);

  await td.tick();
  await td.tick();
  assert.equal(requests.length, 2, 'the pass is complete — the next one is not due for 24 min');
});

test('the coverage note names the refused symbols and the horizon it cannot serve', async () => {
  const { td, sockets, health } = await load({
    resolve: { SPY: quote('SPY', '754.04') },
  });
  await td.startTwelveData();
  assert.equal(td.streamCoverageNote(), null, 'no ack yet — nothing measured to report');

  ack(sockets[0], ['QQQ', 'AAPL'], ['SPY', 'NVDA', 'TSLA', 'MSFT', 'AMD', 'META', 'AMZN', 'MSTR']);
  const note = td.streamCoverageNote();
  assert.match(note, /carries 2 of 10/);
  assert.match(note, /SPY/, 'the operator needs the names, not just the count');
  assert.match(note, /M15/, 'a 19-minute mark cannot grade a 15-minute horizon — say it');

  // And it reaches the health channel when the ack lands, not at the end of a
  // 24-minute pass — the request working is not the same claim as the source
  // being healthy.
  const last = health[health.length - 1];
  assert.equal(last.ok, true);
  assert.equal(last.degraded, true, 'eight of ten symbols off-stream is degraded, not nominal');
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

test('the ack never upgrades a failing rotation to merely degraded', async () => {
  // A socket refusing eight symbols *and* a dead REST rotation is an outage.
  // Reporting `degraded` because the ack happened to arrive second would be
  // the flattering read — and `degraded` renders as a contributing source.
  const { td, sockets, health } = await load({ reject: httpError(429, CREDIT_BODY) });
  await td.startTwelveData();
  assert.equal(health[health.length - 1].ok, false);

  ack(sockets[0], ['QQQ'], ['SPY', 'NVDA', 'TSLA', 'MSFT', 'AMD', 'META', 'AMZN', 'MSTR', 'AAPL']);

  const last = health[health.length - 1];
  assert.equal(last.ok, false, 'the rotation is still failing — the ack does not make it healthy');
  assert.match(last.reason, /out of API credits/);
});

test('the daily budget stops the rotation the cadence alone would not', async (t) => {
  // `rotationIntervalMs` paces a continuously running process into the daily
  // cap. Render's free tier sleeps at 15 minutes, so the real process restarts
  // repeatedly, and every start runs a boot rotation the pacing never sees.
  // The counter is the backstop: ten wakes must not spend ten rotations'
  // worth of an eight-rotation budget.
  const { td, health } = await load({ resolve: { SPY: quote('SPY', '754.04') } });
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  await td.startTwelveData();

  // Far more passes than a day can pay for, each one fully due.
  for (let i = 0; i < 200; i++) {
    t.mock.timers.tick(25 * 60 * 1000);
    await td.tick();
  }

  assert.ok(td.creditsUsedToday() <= td.USABLE_DAILY_CREDITS,
    `spent ${td.creditsUsedToday()} against ${td.USABLE_DAILY_CREDITS} usable`);
  assert.ok(td.creditsUsedToday() > 0, 'it must actually have been spending — otherwise this passes vacuously');

  const last = health[health.length - 1];
  assert.equal(last.ok, false, 'a mark source quiet until midnight is not a healthy one');
  assert.match(last.reason, /Daily credit budget spent/,
    'stopping silently is the failure this connector keeps being fixed for');
});

test('a coverage note suppressed by a failed boot still reaches the operator', async (t) => {
  // `reportCoverage` refuses to talk over a failing rotation, and the ack that
  // triggers it arrives once per socket connect — so a boot whose first
  // request fails suppresses the note with no second ack coming to re-send it.
  // The note must therefore ride out on the next cycle that succeeds, or the
  // entitlement gap is invisible until the socket happens to reconnect.
  const { td, sockets, health, setResponse } = await load({ reject: httpError(429, CREDIT_BODY) });
  await td.startTwelveData();
  assert.equal(health[health.length - 1].ok, false, 'the boot request failed');

  ack(sockets[0], ['QQQ', 'AAPL'], ['SPY', 'NVDA', 'TSLA', 'MSFT', 'AMD', 'META', 'AMZN', 'MSTR']);
  assert.equal(health[health.length - 1].ok, false, 'and the ack does not upgrade it');

  setResponse({ resolve: { SPY: quote('SPY', '754.04') } });
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 25 * 60 * 1000 });
  await td.tick();

  const last = health[health.length - 1];
  assert.equal(last.ok, true);
  assert.equal(last.degraded, true, 'the gap is still there — it must not read as nominal');
  assert.match(last.reason, /carries 2 of 10/,
    'the note the failed boot swallowed has to arrive with the first good cycle');
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

/** Drive the vendor's `subscribe-status` ack through a fake socket. */
function ack(socket: FakeSocket, success: string[], fails: string[], status = 'warning') {
  socket.emit('message', Buffer.from(JSON.stringify({
    event: 'subscribe-status',
    status,
    success: success.map((symbol) => ({ symbol, exchange: 'NASDAQ' })),
    fails: fails.map((symbol) => ({ symbol })),
  })));
}

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
  const requests: string[][] = [];
  let current = resp;
  const get = async (_url: string, cfg?: any) => {
    // The symbols asked for are the credits spent, so the tests that care
    // about the budget need the request, not just its outcome.
    requests.push(String(cfg?.params?.symbol ?? '').split(',').filter(Boolean));
    if (current.reject) throw current.reject;
    return { data: current.resolve };
  };
  const FakeWS: any = function () { const s = new FakeSocket(); sockets.push(s); return s; };

  const td = freshRequire('../src/ingestion/connectors/twelveData', {
    axios: { default: { get }, get },
    ws: { __esModule: true, default: FakeWS },
  });

  const health: any[] = [];
  td.onTwelveDataHealth((h: any) => health.push(h));
  return { td, health, sockets, requests, setResponse: (r: typeof resp) => { current = r; } };
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
