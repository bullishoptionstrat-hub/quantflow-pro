/**
 * The FRED connector, once it has a key.
 *
 * Two things become live the moment `FRED_API_KEY` is set, and neither was
 * covered before:
 *
 *   1. **A key FRED rejects must not read as `connected`.** `fetchSeries`
 *      logged its error and returned, `fetchAll` swallowed the lot, and
 *      `startConnector` marked the source `connected` because `startFRED`
 *      resolved. A wrong key produced ten HTTP 400s, an empty macro panel and
 *      a green light — the same shape as the Stooq and Cboe failures.
 *   2. **The key must not leak.** FRED accepts its key only as a query
 *      parameter, and echoes the request URL in some error bodies. That body
 *      is carried verbatim into `sourceErrors`, which `/api/health` serves
 *      unauthenticated.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const KEY = 'abcdef0123456789abcdef0123456789';

test('a rejected key is reported, and names itself as the likely cause', async () => {
  const fred = load({ status: 400, body: { error_message: 'Bad Request. The value for variable api_key is not registered.' } });
  const seen: any[] = [];
  fred.onFREDHealth((h: any) => seen.push(h));
  await fred.startFRED();

  const last = seen[seen.length - 1];
  assert.equal(last.ok, false, 'a cycle where every series failed is not ok');
  assert.match(last.reason, /10\/10 series failed/);
  assert.match(last.reason, /FRED_API_KEY is not accepted/);
  assert.match(last.reason, /not registered/, "the vendor's own words must survive");
});

test('the key never reaches the health string, even when FRED echoes the URL', async () => {
  // The body FRED returns when it repeats the request back at you.
  const fred = load({
    status: 400,
    body: { error_message: `Bad Request for https://api.stlouisfed.org/fred/series/observations?series_id=GDP&api_key=${KEY}` },
  });
  const seen: any[] = [];
  fred.onFREDHealth((h: any) => seen.push(h));
  await fred.startFRED();

  const reason = seen[seen.length - 1].reason;
  assert.ok(!reason.includes(KEY), 'the api key must never appear in a public health string');
  assert.match(reason, /api_key=\[REDACTED\]/);
});

test('a healthy cycle reports ok and populates the cache', async () => {
  const fred = load({ status: 200, body: { observations: [
    { date: '2026-08-01', value: '4.12' },
    { date: '2026-07-01', value: '4.37' },
  ] } });
  const seen: any[] = [];
  fred.onFREDHealth((h: any) => seen.push(h));
  await fred.startFRED();

  assert.equal(seen[seen.length - 1].ok, true);
  const data = fred.getMacroData();
  assert.equal(data.length, 10, 'all ten series should be cached');
  const ffr = data.find((s: any) => s.seriesId === 'FEDFUNDS');
  assert.equal(ffr.value, 4.12);
  assert.equal(ffr.previousValue, 4.37);
  assert.equal(ffr.change, -0.25);
});

test('a partial failure is not reported as a total one', async () => {
  // One bad series is a series problem; ten is a key problem. Saying "check
  // your key" for the first would send the operator after the wrong thing.
  let n = 0;
  const fred = load(() => (++n === 1
    ? { status: 500, body: 'upstream hiccup' }
    : { status: 200, body: { observations: [{ date: '2026-08-01', value: '1.5' }] } }));
  const seen: any[] = [];
  fred.onFREDHealth((h: any) => seen.push(h));
  await fred.startFRED();

  const last = seen[seen.length - 1];
  assert.equal(last.ok, false);
  assert.match(last.reason, /1\/10 series failed/);
  assert.ok(!/FRED_API_KEY is not accepted/.test(last.reason));
});

test('no key at all stays silent rather than reporting a failure', async () => {
  // Absent is not broken. `startConnector` already reports a missing key from
  // the credentials table, and a second contradictory message helps nobody.
  const fred = load({ status: 200, body: { observations: [] } }, '');
  const seen: any[] = [];
  fred.onFREDHealth((h: any) => seen.push(h));
  await fred.startFRED();
  assert.equal(seen.length, 0, 'no key means no cycle ran, so nothing to report');
});

// ─── Loading with a stubbed transport ───────────────────────────────────────

type Reply = { status: number; body: any };

function load(reply: Reply | (() => Reply), key: string = KEY) {
  const next = typeof reply === 'function' ? reply : () => reply;
  const stub = {
    get: async () => {
      const r = next();
      if (r.status >= 400) {
        const err: any = new Error(`Request failed with status code ${r.status}`);
        err.response = { status: r.status, data: r.body };
        err.isAxiosError = true;
        throw err;
      }
      return { data: r.body };
    },
  };

  const path = require.resolve('../src/ingestion/connectors/fred');
  const axiosPath = require.resolve('axios');
  const prevKey = process.env.FRED_API_KEY;
  const realAxios = require.cache[axiosPath];

  process.env.FRED_API_KEY = key;
  delete require.cache[path];
  require.cache[axiosPath] = { id: axiosPath, filename: axiosPath, loaded: true,
    exports: { default: stub, ...stub } } as any;
  try {
    return require(path);
  } finally {
    if (realAxios) require.cache[axiosPath] = realAxios;
    else delete require.cache[axiosPath];
    delete require.cache[path];
    if (prevKey === undefined) delete process.env.FRED_API_KEY;
    else process.env.FRED_API_KEY = prevKey;
  }
}
