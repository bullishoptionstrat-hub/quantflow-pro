/**
 * `.env` has to be loaded before the import graph, and the position is
 * load-bearing.
 *
 * `config()` used to be called in `server.ts`'s statement body, below the
 * imports. With `module: commonjs`, TypeScript compiles imports to `require`
 * calls in source order and evaluates each module fully before the importer's
 * body runs — so every module-level `process.env.X` in the graph had already
 * read an **empty** environment by the time `config()` populated it.
 *
 * That silently disabled every connector configured from a `.env` file. The
 * reporting then made it worse rather than obvious: `startConnector` calls
 * `missingCredentials()` at *call* time, when `process.env` is finally
 * populated, so it concluded the credentials were present and marked the
 * source `connected` — while the connector had skipped at import time for want
 * of the same key. Observed, with three real keys in `backend/.env`:
 *
 *     /api/health   fred    connected      finnhub  connected
 *     log           [fred] No key — skipped
 *                   (no [finnhub] line at all)
 *
 * Render injects real environment variables before the process starts, so this
 * never bit in production. It bit every developer with a `.env`, and it bit
 * them by lying.
 *
 * ── And the guard written for it checked one filename ───────────────────────
 *
 * `const SERVER = .../src/server.ts`. That is the hand-drawn scope this repo
 * keeps re-learning, and `backend/tools/` was on the other side of it. Two
 * entrypoints there read `process.env` with no `dotenv/config` at all:
 *
 *     tools/collection/doctor.ts   the tool CLAUDE.md documents as the answer
 *                                  to "can this deployment accumulate a track
 *                                  record?"
 *     tools/preview/serve.ts       reads DEMO_MODE
 *
 * The doctor is the one that mattered, and it failed in the same shape as the
 * original: it imports `CONNECTOR_CREDENTIALS` from `src/ingestion/index`,
 * whose module-level `process.env` reads run *during that import* — before any
 * statement in the tool could load a `.env`. Measured, against a
 * `backend/.env` holding four real keys:
 *
 *     [BLOCKED] A source permitted to persist
 *               5 source(s) may be persisted ... and none has credentials.
 *
 * With the same `.env` exported into the shell first, that line reads `[ ok ]`.
 * So the tool built to tell an operator *why* nothing is being collected was
 * itself inventing one of the reasons — and, unlike a connector, it is the
 * thing you consult precisely when you are already confused. The original bug
 * lied by reporting a dead source `connected`; this one lied in the other
 * direction, about a source that was configured.
 *
 * The scope below is now every entrypoint: `src/server.ts` plus every file
 * under `tools/` that a package script runs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const BACKEND = join(__dirname, '..');
const SERVER = join(BACKEND, 'src', 'server.ts');
const CONNECTORS = join(BACKEND, 'src', 'ingestion', 'connectors');
const TOOLS = join(BACKEND, 'tools');

/**
 * Every file a `package.json` script executes.
 *
 * Read out of the scripts rather than listed here, because a list is what let
 * `tools/` go unchecked in the first place. A new `npm run <thing>` that boots
 * a `.ts` file is in scope the moment someone adds it.
 */
function scriptEntrypoints(): string[] {
  const pkg = JSON.parse(readFileSync(join(BACKEND, 'package.json'), 'utf8'));
  const paths = new Set<string>();
  for (const cmd of Object.values(pkg.scripts as Record<string, string>)) {
    for (const m of cmd.matchAll(/(?:^|\s)((?:src|tools)\/[\w./-]+\.ts)/g)) {
      paths.add(m[1]!);
    }
  }
  return [...paths].sort();
}

/** Source lines with comments and blanks removed, in order. */
function codeLines(path: string): string[] {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.replace(/\/\/.*$/, '').trim())
    .filter(Boolean);
}

test('dotenv is loaded before anything that reads the environment', () => {
  const lines = codeLines(SERVER);
  const dotenvAt = lines.findIndex((l) => /^import ['"]dotenv\/config['"]/.test(l));
  assert.notEqual(dotenvAt, -1,
    "server.ts must side-effect import 'dotenv/config'; a deferred config() call runs too late");

  const firstLocalImport = lines.findIndex((l) => /^import .*from ['"]\.\//.test(l));
  assert.notEqual(firstLocalImport, -1, 'expected server.ts to import local modules');
  assert.ok(dotenvAt < firstLocalImport,
    'dotenv/config must come before the first local import, or the graph reads an empty env');
});

test('the deferred call is gone, not merely supplemented', () => {
  const lines = codeLines(SERVER);
  assert.ok(!lines.some((l) => /^config\(\);?$/.test(l)),
    'a bare config() in the statement body runs after the whole import graph');
  assert.ok(!lines.some((l) => /from ['"]dotenv['"]/.test(l)),
    "importing { config } from 'dotenv' invites calling it too late again");
});

test('every entrypoint a script runs loads .env before its import graph', () => {
  // The widening. `server.ts` was guarded by name and the two tools were not,
  // so the tool documented as the answer to "why is nothing being collected?"
  // answered it with a reason it had invented.
  const entrypoints = scriptEntrypoints();
  assert.ok(entrypoints.length >= 4,
    `expected several script entrypoints, found ${entrypoints.length}`);

  const offenders: string[] = [];
  for (const rel of entrypoints) {
    const lines = codeLines(join(BACKEND, rel));
    const dotenvAt = lines.findIndex((l) => /^import ['"]dotenv\/config['"]/.test(l));

    // A file that never reads the environment, directly or through a local
    // import, has nothing to get wrong. `capture.ts` is the real example.
    const readsEnv = lines.some((l) => /process\.env\./.test(l));
    const localImportAt = lines.findIndex((l) => /^import .*from ['"]\.\.?\//.test(l));
    if (!readsEnv && localImportAt === -1) continue;

    if (dotenvAt === -1) { offenders.push(`${rel}: no dotenv/config import`); continue; }
    if (localImportAt !== -1 && dotenvAt > localImportAt) {
      offenders.push(`${rel}: dotenv/config comes after the first local import`);
    }
  }

  assert.deepEqual(offenders, [],
    'These boot with an empty environment for the duration of their import ' +
    'graph. Any module-level `process.env` read in what they import sees ' +
    'nothing, and the result is a tool reporting a configured source as ' +
    `unconfigured:\n  ${offenders.join('\n  ')}`);
});

test('the doctor imports the module whose env reads it depends on', () => {
  // Why the doctor specifically could not be left to `--url`: it reads
  // credentials through `CONNECTOR_CREDENTIALS`, at import time, in its
  // config-only mode — the mode with no running backend to ask instead.
  const doctor = readFileSync(join(TOOLS, 'collection', 'doctor.ts'), 'utf8');
  assert.match(doctor, /from '\.\.\/\.\.\/src\/ingestion\/index'/,
    'if this import goes, re-check whether the dotenv line above it still earns its place');
});

test('connectors read their credentials at module load, which is why the order matters', () => {
  // Not a defect to fix here — module-level reads are how every connector is
  // written, and they are correct *given* the load order. This records the
  // dependency, so anyone who moves the dotenv import can see what it breaks.
  const moduleLevelReaders = readdirSync(CONNECTORS)
    .filter((f) => f.endsWith('.ts'))
    .filter((f) => /^const \w+ = process\.env\./m.test(readFileSync(join(CONNECTORS, f), 'utf8')));

  assert.ok(moduleLevelReaders.length >= 5,
    `expected connectors to capture credentials at module load; found ${moduleLevelReaders.length}`);
});

test('a source that is contributing is not reported as broken', () => {
  // The mirror image of the bug above, found the same way. FRED reported
  // `error` when 1 of its 10 series failed — one had been discontinued
  // upstream — so an operator saw a red source and went hunting a key problem
  // that did not exist, while nine series filled the panel fine. Its own
  // comment already said "a few failing is a per-series problem and the rest
  // of the panel is fine"; the code did not implement it.
  const fred = readFileSync(join(CONNECTORS, 'fred.ts'), 'utf8');
  assert.match(fred, /ok: !allFailed/, 'a partial failure still contributes');
  assert.match(fred, /degraded: !allFailed/, 'and must say what is missing');

  const index = readFileSync(join(__dirname, '..', 'src', 'ingestion', 'index.ts'), 'utf8');
  assert.match(index, /connectorNotes\['fred'\] = h\.reason/,
    'the reason belongs in the note channel, not in sourceErrors');
  assert.match(index, /for \(const \[source, note\] of Object\.entries\(connectorNotes\)\)/,
    'and the notes must reach /api/health');
});
