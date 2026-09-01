/**
 * Capture a running backend's REST responses to a directory.
 *
 * Half of the preview tool: `serve.ts` replays what this records.
 *
 * The point is fidelity. A fixture written by hand drifts from the API it
 * describes and nobody notices until it is describing a shape the backend
 * stopped producing two months ago. These files are whatever the backend
 * actually said, at a moment you can date.
 *
 *   npx tsx tools/preview/capture.ts [--url http://localhost:3001] [--out .preview/cap]
 *
 * Run it against a backend with `DEMO_MODE=1`; the demo header is what gets a
 * response without a Supabase session. Endpoints behind plain `requireAuth`
 * (`/api/chain`, the enrichment routes) are deliberately not captured — they
 * return entitled vendor data or spend metered credits, and a fixture of
 * either is a thing that should not be sitting in a directory.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

interface Endpoint { name: string; path: string; }

const ENDPOINTS: Endpoint[] = [
  { name: 'health',    path: '/api/health' },
  { name: 'flow',      path: '/api/flow' },
  { name: 'flowstats', path: '/api/flow/stats' },
  { name: 'unusual',   path: '/api/flow/unusual' },
  { name: 'darkpool',  path: '/api/darkpool' },
  { name: 'gex',       path: '/api/gex?symbol=SPY' },
  { name: 'gexsym',    path: '/api/gex/symbols' },
  { name: 'macro',     path: '/api/macro' },
  { name: 'vix',       path: '/api/macro/vix' },
  { name: 'crypto',    path: '/api/macro/crypto' },
  { name: 'quotes',    path: '/api/macro/quotes' },
  { name: 'track',     path: '/api/track-record' },
];

function arg(flag: string, fallback: string): string {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

async function main(): Promise<void> {
  const base = arg('--url', 'http://localhost:3001').replace(/\/+$/, '');
  const out = arg('--out', '.preview/cap');
  mkdirSync(out, { recursive: true });

  let ok = 0;
  const manifest: Record<string, { path: string; status: number; bytes: number }> = {};

  for (const ep of ENDPOINTS) {
    try {
      const res = await fetch(`${base}${ep.path}`, {
        headers: { 'X-QuantFlow-Demo': '1' },
        signal: AbortSignal.timeout(15_000),
      });
      const text = await res.text();

      if (!res.ok) {
        console.warn(`  ${ep.name.padEnd(10)} ${res.status} — skipped`);
        manifest[ep.name] = { path: ep.path, status: res.status, bytes: 0 };
        continue;
      }
      // Parsed and re-stringified so a non-JSON body fails here, loudly, rather
      // than at replay time where it looks like a bug in the page.
      writeFileSync(join(out, `${ep.name}.json`), JSON.stringify(JSON.parse(text)));
      manifest[ep.name] = { path: ep.path, status: res.status, bytes: text.length };
      console.log(`  ${ep.name.padEnd(10)} ${res.status}  ${text.length} bytes`);
      ok++;
    } catch (err: any) {
      console.warn(`  ${ep.name.padEnd(10)} failed — ${err?.message ?? err}`);
    }
  }

  writeFileSync(join(out, 'manifest.json'), JSON.stringify({
    capturedAt: new Date().toISOString(),
    source: base,
    // Recorded because a capture's value depends entirely on what the backend
    // had configured when it was taken. A snapshot from a keyless run and one
    // from a fully-credentialed run look similar and mean different things.
    note: 'Captured with X-QuantFlow-Demo: 1. Connector states reflect whatever ' +
          'credentials that backend had at capture time.',
    endpoints: manifest,
  }, null, 2));

  console.log(`\n${ok}/${ENDPOINTS.length} captured → ${out}`);
  if (ok === 0) {
    console.error('Nothing captured. Is the backend running, and is DEMO_MODE=1 set?');
    process.exitCode = 1;
  }
}

void main();
