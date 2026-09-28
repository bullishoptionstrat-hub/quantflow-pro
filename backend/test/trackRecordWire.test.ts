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

test('the flow wire carries its own provenance (F-16)', () => {
  // §22: a derived object retains the rights lineage of its inputs. The store
  // has always carried `source`/`datasetId`/`rightsClass` per row; the wire
  // carried none of them, so the CSV a reader downloads knew less about its
  // own provenance than the row nobody exports.
  const fixture = JSON.parse(
    readFileSync(join(__dirname, 'fixtures', 'flow.json'), 'utf8'),
  ) as { data: Array<Record<string, unknown>> };
  assert.ok(fixture.data.length > 0, 'the flow fixture still carries rows');

  for (const row of fixture.data) {
    assert.ok(Array.isArray(row.datasets),
      'every served signal names the datasets that produced it');
    assert.ok(
      ['PERMITTED', 'PROHIBITED', 'UNVERIFIED', 'UNKNOWN_DATASET']
        .includes(row.rights_display as string),
      `rights_display must be a declared class, got ${String(row.rights_display)}`,
    );
    // An empty dataset list may not read as permitted: no resolvable source is
    // the least established case, not the most.
    if ((row.datasets as string[]).length === 0) {
      assert.equal(row.rights_display, 'UNKNOWN_DATASET',
        'a signal with no resolvable dataset is UNKNOWN, never PERMITTED');
    }
  }
});

test('the CSV export carries the lineage too, and the axis is named', () => {
  const csv = readFileSync(
    join(__dirname, '..', '..', 'frontend', 'components', 'flow', 'FlowFeed.tsx'),
    'utf8',
  );
  assert.match(csv, /Datasets,RightsDisplay/,
    'the export header names both provenance columns');
  assert.match(csv, /e\.datasets/, 'and the rows actually read them');
  assert.match(csv, /e\.rights_display/, '');

  // `rights_display`, never a bare `rights_class`: the same dataset can be
  // PERMITTED to display and PROHIBITED to persist (Finnhub is), and one field
  // answering two questions is the defect this repo hit with `synthetic`.
  // Comments stripped first: the adapter's docstring says the words
  // "rights_class" precisely to explain why the field is NOT called that, and
  // a scan that reads prose as code fails on its own justification. This guard
  // failed exactly that way on its first run.
  const adapter = readFileSync(
    join(__dirname, '..', 'src', 'ingestion', 'flowEngineAdapter.ts'), 'utf8',
  )
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
  assert.ok(!/\brights_class\b/.test(adapter),
    'the wire names the DISPLAY axis, not an unqualified rights class');
  assert.match(adapter, /classifySource\([^)]*'DISPLAY'/,
    'and resolves it on the DISPLAY axis, not by reusing the PERSIST decision');
});

// ─── F-16: the rules the fixture cannot witness ─────────────────────────────
//
// The two most dangerous mutations to `displayRightsOf` — publishing the
// STRONGEST class instead of the weakest, and defaulting an unresolvable
// cluster to PERMITTED — both passed every fixture-driven test above. They had
// to: every row in `flow.json` came from `simulation` alone, so no recorded
// signal mixes datasets or lacks one, and an assertion about those rows cannot
// tell the two rules apart.
//
// That is this repo's own recovery-mutation lesson arriving again: a test
// asserting an outcome on a sample that never reaches the branch is passing
// vacuously. These drive the function directly.

test('a mixed cluster publishes the WEAKEST class, not the first or the best', () => {
  const { displayRightsOf } = require('../src/ingestion/flowEngineAdapter') as
    { displayRightsOf: (s: string[]) => { datasets: string[]; rights_display: string } };

  // tradier is PERMITTED for DISPLAY; cboe_options is UNVERIFIED.
  const mixed = displayRightsOf(['tradier', 'cboe_options']);
  assert.equal(mixed.rights_display, 'UNVERIFIED',
    'one clean print must not launder a cluster — the recorder refuses on any ' +
    'refused source for PERSIST, and DISPLAY reasons the same way');
  assert.deepEqual(mixed.datasets.length, 2, 'and both datasets are named');

  // Order must not decide it.
  assert.equal(displayRightsOf(['cboe_options', 'tradier']).rights_display,
    'UNVERIFIED', 'the verdict is order-independent');
});

test('an unresolvable cluster is UNKNOWN_DATASET, never PERMITTED', () => {
  const { displayRightsOf } = require('../src/ingestion/flowEngineAdapter') as
    { displayRightsOf: (s: string[]) => { datasets: string[]; rights_display: string } };

  // No sources at all. `originOf` pushes 'unknown' when a print's origin has
  // been evicted, so this is reachable rather than theoretical.
  assert.equal(displayRightsOf([]).rights_display, 'UNKNOWN_DATASET',
    'absence of evidence is the least established case, not the most');
  assert.deepEqual(displayRightsOf([]).datasets, []);

  // An unregistered source maps to no dataset — and names none. `classifySource`
  // mints `source:<name>` as an id for one, and publishing that would put a
  // placeholder in the CSV's Datasets column beside real registry entries,
  // where a reader sorting the column could not tell them apart. This shipped
  // in the first draft and was found by the mutation pass, not by a fixture.
  assert.equal(displayRightsOf(['unknown']).rights_display, 'UNKNOWN_DATASET');
  assert.deepEqual(displayRightsOf(['unknown']).datasets, [],
    'an unregistered source contributes no dataset NAME, only the unknown class');
  for (const d of displayRightsOf(['tradier', 'unknown']).datasets) {
    assert.ok(!d.startsWith('source:'),
      `minted placeholder ${d} must never reach the wire as a dataset id`);
  }

  // And it drags a permitted cluster down with it, for the same reason.
  assert.equal(displayRightsOf(['tradier', 'unknown']).rights_display,
    'UNKNOWN_DATASET', 'an unattributable print is not laundered by a clean one');
});

test('a clean single-source cluster is still plainly permitted', () => {
  // A marker that is always on is a marker nobody reads.
  const { displayRightsOf } = require('../src/ingestion/flowEngineAdapter') as
    { displayRightsOf: (s: string[]) => { datasets: string[]; rights_display: string } };
  const clean = displayRightsOf(['tradier']);
  assert.equal(clean.rights_display, 'PERMITTED');
  assert.deepEqual(clean.datasets, ['TRADIER_STREAM']);
});

test('the wire event is actually populated from displayRightsOf', () => {
  // No assertion about the recorded fixture can see this. The fixture holds
  // the values a past boot produced; if `toWireEvent` stopped calling
  // `displayRightsOf` tomorrow, every test above would still pass against the
  // captured rows and the live wire would quietly go empty. Only re-capturing
  // would notice, and re-capturing is a housekeeping step nobody runs on a
  // change to something else.
  //
  // Found by mutation: emitting `datasets: []` from the adapter passed all 75.
  // Same shape as the grader's `continue`, which is guarded positionally for
  // the same reason — the row is missing either way on the tick that fails.
  const src = readFileSync(
    join(__dirname, '..', 'src', 'ingestion', 'flowEngineAdapter.ts'), 'utf8',
  );
  const body = /function toWireEvent\([\s\S]*?\n\}/.exec(src);
  assert.ok(body, 'toWireEvent is still a function by that name');

  assert.match(body[0], /const rights = displayRightsOf\(sources\)/,
    'toWireEvent resolves the lineage from the cluster it actually has');
  assert.match(body[0], /datasets: rights\.datasets/,
    'and publishes it rather than a literal');
  assert.match(body[0], /rights_display: rights\.rights_display/, '');

  // `sources`, plural — the whole cluster, not whichever print landed first.
  assert.match(body[0], /const \{ source, sources, synthetic \} = originOf\(sig\)/,
    'the lineage is resolved over every contributing source');
});
