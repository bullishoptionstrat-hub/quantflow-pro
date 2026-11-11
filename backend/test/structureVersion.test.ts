/**
 * The structure engine's version, purity and reach.
 *
 * Three claims the engine makes about itself, checked against its source:
 *
 *  1. A changed definition changes the version. Parameters are hashed into
 *     `STRUCTURE_METHOD_VERSION` by construction; a changed RULE is caught by
 *     pinning the detectors' source (comments and whitespace aside) to
 *     `STRUCTURE_RULES_VERSION`, so code edited without a bump fails here
 *     instead of shipping events under the old name.
 *  2. It is pure and clock-free: nothing reads the host's time or randomness,
 *     and nothing it reaches — transitively — is a network, ingestion or
 *     storage module.
 *  3. Nothing calls it yet. There is no bar source, so there is no route; a
 *     route over an engine with no data would serve an empty list that reads
 *     exactly like a quiet market.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import {
  DEFAULT_PARAMS, STRUCTURE_METHOD_VERSION, STRUCTURE_RULES_VERSION, StructureParams,
  methodVersionFor, methodVersionOf, paramRefusals, resolveParams,
} from '../src/structure/params';
import { stripComments } from './zeroDefaults';

const SRC = join(__dirname, '..', 'src');
const STRUCTURE = join(SRC, 'structure');
const BAR = join(SRC, 'market', 'bar.ts');

/**
 * The rule set as pinned. Changing anything a detector computes changes this
 * hash; the fix is to bump `STRUCTURE_RULES_VERSION` in `params.ts` and record
 * the new hash here, in the same commit, so the version on every event names
 * the rules that produced it. `params.ts` itself is excluded: its defaults are
 * already hashed into the version, and its own logic is the hashing.
 */
const PIN = {
  rulesVersion: 'structure-rules/1',
  sourceSha256: '57aaa0d93d9bd0f1c0fc98f5bcac5b808e778983c46e175db8209287dda5d2ef',
};

const structureFiles = () => readdirSync(STRUCTURE).filter((f) => f.endsWith('.ts')).sort().map((f) => join(STRUCTURE, f));

function normalisedSourceHash(): string {
  const h = createHash('sha256');
  for (const f of [...structureFiles().filter((f) => !f.endsWith('params.ts')), BAR]) {
    h.update(relative(SRC, f));
    h.update(stripComments(readFileSync(f, 'utf8')).replace(/\s+/g, ' ').trim());
  }
  return h.digest('hex');
}

test('the default version is the hash of the rules and the default parameters', () => {
  assert.equal(STRUCTURE_METHOD_VERSION, methodVersionOf(DEFAULT_PARAMS));
  assert.match(STRUCTURE_METHOD_VERSION, /^structure-rules\/1:[0-9a-f]{16}$/);
  assert.equal(methodVersionOf({ ...DEFAULT_PARAMS }), STRUCTURE_METHOD_VERSION, 'deterministic');
  const reordered = Object.fromEntries(Object.entries(DEFAULT_PARAMS).reverse()) as unknown as StructureParams;
  assert.equal(methodVersionOf(reordered), STRUCTURE_METHOD_VERSION, 'key order cannot change it');
});

test('every parameter is in the version: changing any one changes it', () => {
  const keys = Object.keys(DEFAULT_PARAMS) as (keyof StructureParams)[];
  assert.equal(keys.length, 7, 'a new parameter must be added to this test deliberately');
  const seen = new Set([STRUCTURE_METHOD_VERSION]);
  for (const k of keys) {
    const changed = resolveParams({ [k]: DEFAULT_PARAMS[k] + 1 } as Partial<StructureParams>);
    const v = methodVersionOf(changed);
    assert.ok(!seen.has(v), `changing ${k} did not change the version`);
    seen.add(v);
  }
});

test('the rule version is in the hash too', () => {
  assert.notEqual(methodVersionFor('structure-rules/2', DEFAULT_PARAMS), STRUCTURE_METHOD_VERSION);
});

test('parameters are refused, not repaired', () => {
  const r = (o: Partial<StructureParams>) => paramRefusals({ ...DEFAULT_PARAMS, ...o });
  assert.ok(r({ pivotRight: 0 }).some((x) => /pivotRight must be an integer of at least 1/.test(x)), 'a pivot emitted at its own bar');
  assert.ok(r({ pivotLeft: 1.5 }).some((x) => /pivotLeft/.test(x)));
  assert.ok(r({ atrPeriod: 0 }).some((x) => /atrPeriod/.test(x)));
  assert.ok(r({ displacementK: 0 }).some((x) => /displacementK/.test(x)));
  assert.ok(r({ displacementK: NaN }).some((x) => /displacementK/.test(x)));
  assert.ok(r({ sweepReclaimBars: 0 }).some((x) => /sweepReclaimBars/.test(x)));
  assert.ok(r({ fvgExpiryBars: -1 }).some((x) => /fvgExpiryBars/.test(x)));
  assert.ok(r({ smtAlignToleranceBars: -1 }).some((x) => /smtAlignToleranceBars/.test(x)));
  assert.deepEqual(r({ smtAlignToleranceBars: 0 }), [], 'exact alignment is a legitimate (strict) choice');
  assert.throws(() => resolveParams({ pivotRight: 0 }));
});

test('the rules are pinned to STRUCTURE_RULES_VERSION: a changed definition must change the version', () => {
  const now = normalisedSourceHash();
  assert.equal(STRUCTURE_RULES_VERSION, PIN.rulesVersion,
    `STRUCTURE_RULES_VERSION is now ${STRUCTURE_RULES_VERSION}: record it in PIN with the source hash ${now}`);
  assert.equal(now, PIN.sourceSha256,
    `the structure source changed (hash ${now}) while STRUCTURE_RULES_VERSION is still ${PIN.rulesVersion}. ` +
    'Bump STRUCTURE_RULES_VERSION in src/structure/params.ts and record the new version and hash in PIN.');
});

// ── Purity ──────────────────────────────────────────────────────────────────

/**
 * What the engine may reach, transitively. An allowlist, not a denylist: a new
 * import fails here until someone decides it belongs, which is the direction
 * this repository fails in everywhere else.
 */
const ALLOWED_FILES = new Set([
  ...structureFiles().map((f) => relative(SRC, f)),
  join('market', 'bar.ts'),
  join('market', 'civil.ts'),
  join('market', 'session.ts'),
  join('flow-engine', 'calendar.ts'),
]);
const ALLOWED_BUILTINS = new Set(['node:crypto']);

const specifiers = (code: string): string[] =>
  [...code.matchAll(/(?:import|export)\s[^;]*?from\s*['"]([^'"]+)['"]|import\s*['"]([^'"]+)['"]/g)].map((m) => m[1] ?? m[2]);

test('the engine reaches only itself, the calendar and civil time — transitively', () => {
  const seen = new Set<string>();
  const queue = [...structureFiles(), BAR];
  const offenders: string[] = [];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    const rel = relative(SRC, file);
    if (!ALLOWED_FILES.has(rel)) { offenders.push(`${rel} is reached but not allowed`); continue; }
    for (const spec of specifiers(stripComments(readFileSync(file, 'utf8')))) {
      if (!spec.startsWith('.')) {
        if (!ALLOWED_BUILTINS.has(spec)) offenders.push(`${rel} imports ${spec}`);
        continue;
      }
      const target = resolve(dirname(file), `${spec}.ts`);
      if (!existsSync(target)) { offenders.push(`${rel} imports ${spec}, which is not a .ts file`); continue; }
      queue.push(target);
    }
  }
  assert.deepEqual(offenders, []);
  assert.ok(seen.size >= 13, 'the walk actually walked');
});

test('nothing in the engine reads the clock, randomness, the environment or a timer', () => {
  const banned: [RegExp, string][] = [
    [/\bDate\.now\s*\(/, 'Date.now()'],
    [/new\s+Date\s*\(\s*\)/, 'new Date() without an argument'],
    [/\bperformance\.now\b/, 'performance.now'],
    [/\bMath\.random\b/, 'Math.random'],
    [/\bprocess\./, 'process.*'],
    [/\b(setTimeout|setInterval|setImmediate)\s*\(/, 'a timer'],
    [/\brequire\s*\(/, 'require()'],
  ];
  const offenders: string[] = [];
  for (const f of [...structureFiles(), BAR]) {
    const code = stripComments(readFileSync(f, 'utf8'));
    for (const [re, what] of banned) if (re.test(code)) offenders.push(`${relative(SRC, f)}: ${what}`);
  }
  assert.deepEqual(offenders, []);
  // The scan must still catch the forms it exists for.
  for (const probe of ['const t = Date.now();', 'const d = new Date();', 'Math.random()']) {
    assert.ok(banned.some(([re]) => re.test(probe)), `the scan misses ${probe}`);
  }
});

test('nothing outside the engine calls it yet: no route, no connector, no recorder', () => {
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const e of readdirSync(dir)) {
      const full = join(dir, e);
      if (statSync(full).isDirectory()) walk(full, out);
      else if (full.endsWith('.ts')) out.push(full);
    }
    return out;
  };
  const callers = walk(SRC)
    .filter((f) => !f.startsWith(STRUCTURE + '/'))
    .filter((f) => specifiers(stripComments(readFileSync(f, 'utf8')))
      .some((s) => s.startsWith('.') && resolve(dirname(f), s).startsWith(STRUCTURE)))
    .map((f) => relative(SRC, f));
  assert.deepEqual(callers, [],
    'the structure engine has no bar source, so nothing may serve it yet. When Phase A adds one, ' +
    'wire it deliberately and change this test in the same commit.');
});
