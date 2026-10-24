/**
 * After rotation: does any credential ever committed to this repository still
 * work, and does any local file still hold one?
 *
 *   npx tsx tools/security/verifyRevoked.ts            # both checks
 *   npx tsx tools/security/verifyRevoked.ts --offline  # local files only, no network
 *
 * Run it AFTER rotating. Before rotation every key answers STILL_VALID, and
 * the run only sends disclosed keys around for no information.
 *
 * What it sends, and to whom: each exposed value goes only to the vendor that
 * issued it, in one cheap authenticated request — the same act the connector
 * performs. Nothing is printed but variable names, the fingerprint from
 * `exposure.ts`, a verdict and the HTTP status. A value never reaches stdout,
 * a log or a file.
 *
 * The verdicts are three, not two, for the reason `entitlement.ts` gives:
 * REVOKED and STILL_VALID are claims, and anything the vendor did not clearly
 * say — a timeout, a rate limit, a plan refusal — is UNKNOWN rather than
 * either. Every status mapping below is the vendor's documented convention
 * (or measured where stated); none has been run against a rotated key yet.
 */
// First, by the rule `dotenvOrder.test.ts` holds every script entrypoint to.
import 'dotenv/config';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { scanHistory, referencesIn, type Exposure } from './exposure';

export type Verdict = 'REVOKED' | 'STILL_VALID' | 'UNKNOWN' | 'NOT_PROBED';

interface Probe {
  request: (v: string) => { url: string; init?: RequestInit };
  classify: (status: number, body: string) => Verdict;
  basis: string;
}

const has = (body: string, re: RegExp) => re.test(body);

/** One probe per variable name. A name with none reports NOT_PROBED, never a guess. */
export const PROBES: Record<string, Probe> = {
  POLYGON_API_KEY: {
    request: (v) => ({ url: 'https://api.polygon.io/v3/reference/tickers?limit=1', init: { headers: { Authorization: `Bearer ${v}` } } }),
    // Measured 2026-09-13: an unknown key is 401; a valid key on a plan
    // lacking the endpoint is 403 NOT_AUTHORIZED — which is still a working key.
    classify: (s) => (s === 401 ? 'REVOKED' : s === 200 || s === 403 ? 'STILL_VALID' : 'UNKNOWN'),
    basis: 'measured: 401 unknown key, 403 valid key without entitlement',
  },
  FINNHUB_API_KEY: {
    request: (v) => ({ url: 'https://finnhub.io/api/v1/quote?symbol=AAPL', init: { headers: { 'X-Finnhub-Token': v } } }),
    classify: (s) => (s === 401 ? 'REVOKED' : s === 200 ? 'STILL_VALID' : 'UNKNOWN'),
    basis: 'documented: 401 for an invalid token',
  },
  FMP_API_KEY: {
    request: (v) => ({ url: `https://financialmodelingprep.com/stable/quote?symbol=AAPL&apikey=${encodeURIComponent(v)}` }),
    classify: (s, b) => (s === 401 || has(b, /invalid api key/i) ? 'REVOKED' : s === 200 ? 'STILL_VALID' : 'UNKNOWN'),
    basis: 'documented: 401 / "Invalid API KEY" body',
  },
  FRED_API_KEY: {
    request: (v) => ({ url: `https://api.stlouisfed.org/fred/series?series_id=GNPCA&file_type=json&api_key=${encodeURIComponent(v)}` }),
    classify: (s, b) => (has(b, /api_key.*(not registered|not.*valid)|bad request.*api_key/i) ? 'REVOKED' : s === 200 ? 'STILL_VALID' : 'UNKNOWN'),
    basis: 'documented: 400 with an api_key error message',
  },
  TWELVE_DATA_API_KEY: {
    request: (v) => ({ url: `https://api.twelvedata.com/api_usage?apikey=${encodeURIComponent(v)}` }),
    // Measured 2026-09-14: a refusal arrives as {"code":401,...} — sometimes under HTTP 200.
    classify: (s, b) => (s === 401 || has(b, /"code"\s*:\s*401/) ? 'REVOKED' : s === 200 && has(b, /current_usage/) ? 'STILL_VALID' : 'UNKNOWN'),
    basis: 'measured: code 401 in the body, sometimes under HTTP 200',
  },
  NEWS_API_KEY: {
    request: (v) => ({ url: 'https://newsapi.org/v2/top-headlines?country=us&pageSize=1', init: { headers: { 'X-Api-Key': v } } }),
    classify: (s, b) => (s === 401 || has(b, /apiKeyInvalid|apiKeyDisabled/) ? 'REVOKED' : s === 200 ? 'STILL_VALID' : 'UNKNOWN'),
    basis: 'documented: 401 apiKeyInvalid / apiKeyDisabled. Note the exposed value under this name is an Event Registry key, which newsapi.org has always refused — see EVENT_REGISTRY_API_KEY for the verdict that matters',
  },
  EVENT_REGISTRY_API_KEY: {
    request: (v) => ({
      url: 'https://eventregistry.org/api/v1/article/getArticles',
      init: { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ apiKey: v, keyword: 'market', articlesCount: 1 }) },
    }),
    // Measured 2026-09: a rejected key answers HTTP 200 with an `error` field.
    classify: (s, b) => (has(b, /"error"/) && has(b, /key/i) ? 'REVOKED' : s === 200 && has(b, /"articles"/) ? 'STILL_VALID' : 'UNKNOWN'),
    basis: 'measured: HTTP 200 with an error field for a refused key',
  },
  TRADIER_API_KEY: {
    request: (v) => ({ url: 'https://sandbox.tradier.com/v1/user/profile', init: { headers: { Authorization: `Bearer ${v}`, Accept: 'application/json' } } }),
    classify: (s) => (s === 401 ? 'REVOKED' : s === 200 ? 'STILL_VALID' : 'UNKNOWN'),
    basis: 'documented: 401 for an invalid token. The exposed value sat beside TRADIER_ENV=sandbox, so the sandbox host is asked',
  },
  FIRECRAWL_API_KEY: {
    request: (v) => ({ url: 'https://api.firecrawl.dev/v1/team/credit-usage', init: { headers: { Authorization: `Bearer ${v}` } } }),
    classify: (s) => (s === 401 ? 'REVOKED' : s === 200 ? 'STILL_VALID' : 'UNKNOWN'),
    basis: 'documented: 401 for an invalid key',
  },
};

export interface Result { names: string[]; fingerprint: string; verdict: Verdict; status: number | null; basis: string }

export async function verify(
  exposures: readonly Exposure[], values: ReadonlyMap<string, string>,
  fetchImpl: typeof fetch = fetch,
): Promise<Result[]> {
  const out: Result[] = [];
  for (const e of exposures) {
    const value = values.get(e.fingerprint);
    const probe = e.names.map((n) => PROBES[n]).find(Boolean);
    if (!probe || value === undefined) {
      out.push({ names: e.names, fingerprint: e.fingerprint, verdict: 'NOT_PROBED', status: null,
        basis: 'no probe for this variable — rotate it and confirm at the vendor dashboard' });
      continue;
    }
    const { url, init } = probe.request(value);
    let status: number | null = null;
    let verdict: Verdict = 'UNKNOWN';
    try {
      const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(15_000) });
      status = res.status;
      verdict = probe.classify(res.status, await res.text());
    } catch { verdict = 'UNKNOWN'; }
    out.push({ names: e.names, fingerprint: e.fingerprint, verdict, status, basis: probe.basis });
  }
  return out;
}

/** Working-tree files to check for a value that is still the compromised one, `.env` files included. */
export function localFiles(repo: string): string[] {
  const listed = execFileSync('git', ['ls-files', '-z', '--cached', '--others'], { cwd: repo, maxBuffer: 1 << 26 })
    .toString().split('\0').filter((p) => p && !p.includes('node_modules/'));
  const envs = ['backend/.env', 'frontend/.env.local', '.env'].filter((p) => existsSync(join(repo, p)));
  return [...new Set([...listed, ...envs])];
}

async function main() {
  const repo = join(__dirname, '..', '..', '..');
  const offline = process.argv.includes('--offline');
  const values = new Map<string, string>();
  const exposures = scanHistory(repo, values);
  const fps = new Set(exposures.map((e) => e.fingerprint));
  const refs = referencesIn(localFiles(repo), (p) => {
    try { return readFileSync(join(repo, p), 'utf8'); } catch { return null; }
  }, fps);

  console.log(`${exposures.length} credential value(s) have ever been committed to this repository.\n`);
  console.log('Local files still holding a compromised value:');
  console.log(refs.length ? refs.map((r) => `  ${r}`).join('\n') : '  none');

  let bad = refs.length > 0;
  if (!offline) {
    console.log('\nVendor verdicts (values never printed):');
    for (const r of await verify(exposures, values)) {
      console.log(`  ${r.verdict.padEnd(11)} ${r.names.join(' = ').padEnd(44)} fp=${r.fingerprint} http=${r.status ?? '-'}  (${r.basis})`);
      if (r.verdict === 'STILL_VALID') bad = true;
    }
  }
  process.exitCode = bad ? 1 : 0;
}

if (require.main === module) void main();
