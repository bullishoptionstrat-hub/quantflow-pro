/**
 * The Render Blueprint must declare what the backend actually reads.
 *
 * This drifted badly and in both directions, and neither direction was
 * visible from inside the code:
 *
 *   - **Read but not declared.** Fourteen credentials — every free-tier
 *     connector's — were read by `src/ingestion/connectors/*` and declared
 *     nowhere in `render.yaml`. A Blueprint deploy therefore had no slot to
 *     put them in, so each of those sources reported `disabled — no
 *     credentials` in production with no way to fix it from the dashboard.
 *     Locally they worked, because a local `.env` has no such gate.
 *   - **Declared but not read.** `ALPACA_KEY` and `ALPACA_SECRET` sat in the
 *     Blueprint, in `.env.example`, in the README's key table and in
 *     CLAUDE.md's architecture bullet. There is no Alpaca connector. An
 *     operator could have signed up for an account and pasted a key into a
 *     variable nothing reads.
 *
 * Both are the same failure — a config surface nobody checks against the code
 * — so one test checks it in both directions.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..', '..');
const SRC = join(__dirname, '..', 'src');
const BLUEPRINT = join(ROOT, 'render.yaml');

/** Keys declared under the backend service in the Blueprint. */
function declaredKeys(): Set<string> {
  const yaml = readFileSync(BLUEPRINT, 'utf8');
  // The backend service runs from the top of the file to the next `- type:`.
  const start = yaml.indexOf('name: quantflow-pro-backend');
  assert.ok(start > 0, 'render.yaml should define quantflow-pro-backend');
  const after = yaml.indexOf('- type:', start);
  const section = after > 0 ? yaml.slice(start, after) : yaml.slice(start);
  return new Set(
    [...section.matchAll(/^\s*-\s*key:\s*([A-Z_0-9]+)/gm)].map((m) => m[1]!),
  );
}

/** Every `process.env.X` the backend source reads. Comments do not count. */
function readKeys(): Set<string> {
  const files = (function walk(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(join(dir, e.name))
        : e.name.endsWith('.ts') ? [join(dir, e.name)] : [],
    );
  })(SRC);

  const found = new Set<string>();
  for (const f of files) {
    const code = readFileSync(f, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^[ \t]*\/\/.*$/gm, '');
    for (const m of code.matchAll(/process\.env\.([A-Z_0-9]+)/g)) found.add(m[1]!);
    // `env.X` inside functions taking a NodeJS.ProcessEnv, e.g. rights.ts.
    for (const m of code.matchAll(/\benv\.([A-Z_0-9]{4,})/g)) found.add(m[1]!);
  }
  return found;
}

/**
 * Read by the code, deliberately not declared. Each needs a reason, and the
 * reason is the point — an empty exemption list is what this test is for.
 */
const NOT_DECLARED: Record<string, string> = {
  // Render injects both. Pinning PORT is actively wrong: the platform chooses
  // it, and the deleted backend/render.yaml pinned it to "3001".
  PORT: 'provided by Render',
  NODE_ENV: 'set by the Blueprint as a plain value, not a credential',
  // The rights gate refuses the Yahoo connector before `yahoo.ts` reads this,
  // so a Blueprint entry would advertise a switch that does nothing.
  YAHOO_ENABLED: 'dead — the connector is refused before it reads the flag',
  // Read by `resolveBusinessMode` and declared with an explicit value rather
  // than `sync: false`, so it appears in `declaredKeys` anyway; listed here
  // only if that ever changes.
};

test('every credential the backend reads is declared in the Blueprint', () => {
  const declared = declaredKeys();
  const missing = [...readKeys()]
    .filter((k) => !declared.has(k) && !(k in NOT_DECLARED))
    .sort();

  assert.deepEqual(
    missing, [],
    `read by src/ but absent from render.yaml, so a Blueprint deploy has ` +
    `nowhere to set them:\n  ${missing.join('\n  ')}`,
  );
});

test('the Blueprint declares nothing the backend never reads', () => {
  const read = readKeys();
  // Declared with a literal `value:` rather than `sync: false` — Blueprint
  // configuration rather than a credential the code looks up.
  const CONFIG_ONLY = new Set(['NODE_ENV']);
  const orphans = [...declaredKeys()]
    .filter((k) => !read.has(k) && !CONFIG_ONLY.has(k))
    .sort();

  assert.deepEqual(
    orphans, [],
    `declared in render.yaml but read by nothing — an operator could obtain ` +
    `credentials for a variable that does not exist:\n  ${orphans.join('\n  ')}`,
  );
});

test('every connector in the credentials table has a Blueprint entry', () => {
  // `CONNECTOR_CREDENTIALS` is what /api/health reports a missing key from.
  // A variable named there but absent from the Blueprint means production
  // reports "set FOO" for a FOO that cannot be set.
  const { CONNECTOR_CREDENTIALS } = require('../src/ingestion/index');
  const declared = declaredKeys();
  const missing: string[] = [];

  for (const [connector, vars] of Object.entries(CONNECTOR_CREDENTIALS)) {
    for (const v of vars as readonly string[]) {
      if (!declared.has(v)) missing.push(`${connector}: ${v}`);
    }
  }
  assert.deepEqual(missing, [], `no Blueprint slot for:\n  ${missing.join('\n  ')}`);
});

test('there is exactly one Blueprint', () => {
  // `backend/render.yaml` was a second, stale copy declaring the same service
  // name: no BUSINESS_MODE, a pinned PORT, the deprecated `env:` key, and none
  // of the connector credentials. Whichever one Render was pointed at, the
  // other was a trap for the next person to edit.
  const stale = join(__dirname, '..', 'render.yaml');
  let exists = true;
  try { readFileSync(stale, 'utf8'); } catch { exists = false; }
  assert.equal(exists, false, 'backend/render.yaml is a duplicate Blueprint — root render.yaml is the one');
});

test('BUSINESS_MODE is pinned, not left to the environment', () => {
  // Unset resolves to PRIVATE_RESEARCH, which is the safe branch — but an
  // explicit value is the difference between a deployment that chose the
  // restrictive mode and one that happened to land there.
  const yaml = readFileSync(BLUEPRINT, 'utf8');
  assert.match(yaml, /- key: BUSINESS_MODE\s*\n\s*value: PRIVATE_RESEARCH/);
});
