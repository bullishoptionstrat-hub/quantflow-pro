/**
 * The backtest row crosses a process boundary, and nothing was holding the
 * two declarations of it together.
 *
 * `TrackRecordRow` in `src/persistence/types.ts` is what `/api/track-record`
 * and `/api/backtest` publish. `BacktestRow` in `frontend/lib/types.ts` is the
 * frontend's *assertion* about that payload, and `Backtest.tsx` binds it to a
 * table. Nothing compared them, so a backend field rename left the column
 * rendering `—` forever with no error anywhere — this repo's oldest and most
 * repeated defect: a page reading a field the API does not send, failing
 * silently.
 *
 * It happened here, in the commit that renamed `excursion` to
 * `directionalReturnAtHorizon` (F-9). The backend, its tests, the typechecker
 * and the frontend suite were all green while the one rendered number was
 * dead. **The recorded fixture is why the frontend suite stayed green**: it was
 * captured before the rename, so `frontend/test/backtest.test.tsx` drove a
 * payload that agreed with the stale frontend type. The fixture and the
 * interface drifted from the backend *together*, and a test of one against the
 * other cannot see it.
 *
 * So this guard compares three things that must agree, and the third is the
 * one the existing `wireContract.test.ts` pattern was missing:
 *
 *   1. every field the frontend declares is a field the backend publishes
 *   2. every key in the recorded fixture is a field the backend publishes
 *   3. every field the frontend *renders* is one it declares
 *
 * It is deliberately one-directional on (1): the backend may publish a field
 * the frontend does not read yet, which is ordinary. The reverse — the
 * frontend naming something the backend does not send — is always a defect.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..', '..');
const BACKEND_TYPES = join(__dirname, '..', 'src', 'persistence', 'types.ts');
const FRONTEND_TYPES = join(ROOT, 'frontend', 'lib', 'types.ts');
const COMPONENT = join(ROOT, 'frontend', 'components', 'backtest', 'Backtest.tsx');
const FIXTURE = join(__dirname, 'fixtures', 'backtest.json');

/** Field names declared by `export interface <name>` in a TS source file. */
function fields(path: string, name: string): Set<string> {
  const src = readFileSync(path, 'utf8');
  const at = src.indexOf(`export interface ${name} {`);
  assert.ok(at >= 0, `${name} is still declared in ${path}`);
  const open = src.indexOf('{', at);
  // Walk to the matching brace so a nested object type cannot end it early.
  let depth = 0, end = open;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) { end = i; break; }
  }
  const body = src.slice(open + 1, end)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
  const out = new Set<string>();
  for (const m of body.matchAll(/(?:^|\n)\s{2}([A-Za-z_][A-Za-z0-9_]*)\??\s*:/g)) {
    out.add(m[1]!);
  }
  assert.ok(out.size > 4, `parsed only ${out.size} fields from ${name} — parse drift?`);
  return out;
}

test('every field the frontend declares on a backtest row is one the backend publishes', () => {
  const backend = fields(BACKEND_TYPES, 'TrackRecordRow');
  const frontend = fields(FRONTEND_TYPES, 'BacktestRow');

  const unpublished = [...frontend].filter((f) => !backend.has(f));
  assert.deepEqual(unpublished, [],
    `the frontend declares fields /api/backtest does not send: ${unpublished.join(', ')}. ` +
    'This renders as a silently empty column, never an error.');
});

test('every key in the recorded fixture is a field the backend publishes', () => {
  // The fixture is a captured payload, which is what makes it trustworthy —
  // and also what lets it go stale behind a rename while the frontend test
  // that drives it keeps passing.
  const backend = fields(BACKEND_TYPES, 'TrackRecordRow');
  const body = JSON.parse(readFileSync(FIXTURE, 'utf8'));
  assert.ok(Array.isArray(body.rows) && body.rows.length > 0,
    'the fixture still carries rows to check');

  const seen = new Set<string>();
  for (const row of body.rows) for (const k of Object.keys(row)) seen.add(k);

  const stale = [...seen].filter((k) => !backend.has(k));
  assert.deepEqual(stale, [],
    `the recorded fixture carries keys the backend no longer publishes: ${stale.join(', ')}. ` +
    'Re-record it with `npm run preview:capture`, or the frontend suite will keep ' +
    'passing against a payload the backend stopped sending.');
});

test('every row field the backtest table renders is one the frontend declares', () => {
  const frontend = fields(FRONTEND_TYPES, 'BacktestRow');
  const src = readFileSync(COMPONENT, 'utf8');

  // `r` is the row in the table's map callback.
  const read = new Set(
    [...src.matchAll(/\br\.([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]!),
  );
  assert.ok(read.size > 2, `found only ${read.size} row reads — has the binding changed shape?`);

  const undeclared = [...read].filter((f) => !frontend.has(f));
  assert.deepEqual(undeclared, [],
    `the table reads row fields the frontend type does not declare: ${undeclared.join(', ')}`);
});

test('no wire field on this path is called an excursion', () => {
  // F-9's rule, held at the boundary rather than only in the backend: an
  // excursion is a property of a path, and this system observes two endpoints.
  for (const [label, path] of [
    ['backend type', BACKEND_TYPES],
    ['frontend type', FRONTEND_TYPES],
    ['fixture', FIXTURE],
    ['component', COMPONENT],
  ] as const) {
    const src = readFileSync(path, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')       // block comments may explain the rename
      .replace(/^[ \t]*\/\/.*$/gm, '');
    assert.ok(!/\bmedianExcursion\b/.test(src),
      `${label} still names medianExcursion outside a comment`);
  }
});
