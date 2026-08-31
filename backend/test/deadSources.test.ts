/**
 * A source that is down must not present itself as data.
 *
 * Two connectors were manufacturing values out of failed requests, and both
 * reached the terminal as numbers a reader would act on:
 *
 *   - Stooq now answers with a JavaScript browser-verification page instead of
 *     its CSV — HTTP **200**, an HTML body. The parser's only guard was
 *     `lines.length < 2`, which a four-line challenge page clears, so every
 *     field read as `''` and `parseFloat('' || '0')` cached twelve quotes with
 *     `close: 0`. SPX, NDX, DJIA and the whole yield curve, priced at zero,
 *     with `/api/health` reporting stooq `connected`.
 *   - Cboe's `options_volume.json` returns HTTP **403**. `fetchPutCallRatios`
 *     swallowed it in a bare `catch`, returned `{}`, and `fetchAll` filled
 *     every field with `?? 0` — so the panel showed an equity put/call ratio
 *     of 0.00, coloured green, sourced from a denied request.
 *
 * These tests drive the parsers directly with the responses the live endpoints
 * actually return today.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CONNECTORS = join(__dirname, '..', 'src', 'ingestion', 'connectors');

/** The shape Stooq serves in place of the CSV, as captured 2026-08-31. */
const CHALLENGE_PAGE = [
  '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="robots" content="noindex,nofollow"></head>',
  '<body><noscript>This site requires JavaScript to verify your browser.</noscript><script nonce="x">',
  '(async()=>{const c="AAAA",d=4;})();',
  '</script></body></html>',
].join('\n');

// ─── Stooq ──────────────────────────────────────────────────────────────────

test('the challenge page yields no cached quote', async () => {
  const stooq = await loadStooqWithResponse(CHALLENGE_PAGE);
  await stooq.startStooq();
  assert.equal(
    stooq.getStooqQuotes().size, 0,
    'a browser-verification page must cache nothing — it used to cache twelve zeros',
  );
});

test('the challenge page is reported, with a reason naming the cause', async () => {
  const stooq = await loadStooqWithResponse(CHALLENGE_PAGE);
  const seen: any[] = [];
  stooq.onStooqHealth((h: any) => seen.push(h));
  await stooq.startStooq();

  assert.ok(seen.length > 0, 'the cycle must report its health');
  const last = seen[seen.length - 1];
  assert.equal(last.ok, false);
  assert.match(last.reason, /HTML page, not CSV/);
  assert.match(last.reason, /12\/12 symbols failed/);
});

test('a well-formed CSV still caches, so the guard is not just refusing everything', async () => {
  const csv = 'Date,Open,High,Low,Close,Volume\n2026-08-28,6501.2,6540.0,6490.1,6532.75,0';
  const stooq = await loadStooqWithResponse(csv);
  const seen: any[] = [];
  stooq.onStooqHealth((h: any) => seen.push(h));
  await stooq.startStooq();

  const quotes = stooq.getStooqQuotes();
  assert.ok(quotes.size > 0, 'valid CSV must still populate the cache');
  const spx = quotes.get('SPX');
  assert.equal(spx.close, 6532.75);
  assert.equal(spx.date, '2026-08-28');
  assert.equal(seen[seen.length - 1].ok, true);
});

test('a CSV whose close parses to zero is refused', async () => {
  // The value that used to reach the panel. A price of 0 is not a price.
  const csv = 'Date,Open,High,Low,Close,Volume\n2026-08-28,0,0,0,0,0';
  const stooq = await loadStooqWithResponse(csv);
  await stooq.startStooq();
  assert.equal(stooq.getStooqQuotes().size, 0);
});

test('the bare catch that hid all of this is gone', () => {
  // Comments stripped first — the note explaining what `catch {}` used to hide
  // is documentation, and a rule that forbade describing the bug would be a
  // strange way to prevent it.
  const body = readFileSync(join(CONNECTORS, 'stooq.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
  assert.ok(
    !/catch\s*\{\s*\}/.test(body),
    'an empty catch block is how a dead source stayed invisible',
  );
});

// ─── Cboe put/call ──────────────────────────────────────────────────────────

test('a denied put/call request reports null, never zero', async () => {
  const cboe = await loadCboeWithPcrStatus(403);
  await cboe.startCBOE();
  const d = cboe.getCBOEData();

  assert.ok(d, 'the VIX half must still populate — one dead endpoint is not both');
  for (const field of [
    'putCallRatioEquity', 'putCallRatioIndex', 'putCallRatioTotal',
    'equityCallVolume', 'equityPutVolume', 'indexCallVolume',
    'indexPutVolume', 'totalOptionsVolume',
  ]) {
    assert.equal(d[field], null, `${field} must be null, not 0, when the source refused`);
  }
  assert.match(d.putCallUnavailable, /403/);
});

test('the put/call block still populates when the endpoint answers', async () => {
  const cboe = await loadCboeWithPcrStatus(200);
  await cboe.startCBOE();
  const d = cboe.getCBOEData();
  assert.equal(d.putCallRatioEquity, 0.71);
  assert.equal(d.putCallRatioIndex, 1.35);
  assert.equal(d.putCallUnavailable, undefined);
});

test('zero remains expressible for a source that really reports zero', () => {
  // Null means "no answer". It must not collapse the difference with a real 0,
  // which is why the fix is nullable fields rather than a sentinel.
  const body = readFileSync(join(CONNECTORS, 'cboe.ts'), 'utf8');
  assert.match(body, /putCallRatioEquity: number \| null/);
  assert.ok(
    !/putCallRatioEquity: pcr\.\w+ \?\? 0/.test(body),
    'the `?? 0` that turned a 403 into a ratio must not come back',
  );
});

// ─── Loading with a stubbed transport ───────────────────────────────────────

/** Fresh module instances per test — both connectors hold module-level caches. */
function freshRequire(path: string, axiosStub: any) {
  const resolved = require.resolve(path);
  const axiosPath = require.resolve('axios');
  delete require.cache[resolved];
  const realAxios = require.cache[axiosPath];
  require.cache[axiosPath] = { id: axiosPath, filename: axiosPath, loaded: true,
    exports: axiosStub } as any;
  try {
    return require(resolved);
  } finally {
    if (realAxios) require.cache[axiosPath] = realAxios;
    else delete require.cache[axiosPath];
    delete require.cache[resolved];
  }
}

async function loadStooqWithResponse(body: string) {
  return freshRequire('../src/ingestion/connectors/stooq', {
    default: { get: async () => ({ data: body }) },
    get: async () => ({ data: body }),
  });
}

async function loadCboeWithPcrStatus(status: number) {
  const quote = (price: number) => ({ data: { data: { current_price: price } } });
  const stub = {
    get: async (url: string) => {
      if (url.includes('options_volume.json')) {
        if (status === 403) {
          const err: any = new Error('Request failed with status code 403');
          err.response = { status: 403, data: '<Error><Code>AccessDenied</Code></Error>' };
          err.isAxiosError = true;
          throw err;
        }
        return { data: { data: [{
          equity_put_call_ratio: '0.71', index_put_call_ratio: '1.35',
          total_put_call_ratio: '0.88', equity_call_volume: '100',
          equity_put_volume: '71', index_call_volume: '20',
          index_put_volume: '27', total_volume: '218',
        }] } };
      }
      return quote(14.92);
    },
  };
  return freshRequire('../src/ingestion/connectors/cboe', { default: stub, ...stub });
}
