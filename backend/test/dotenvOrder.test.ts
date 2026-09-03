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
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const SERVER = join(__dirname, '..', 'src', 'server.ts');
const CONNECTORS = join(__dirname, '..', 'src', 'ingestion', 'connectors');

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
