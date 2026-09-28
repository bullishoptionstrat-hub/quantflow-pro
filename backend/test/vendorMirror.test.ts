/**
 * The vendored copies must match their canonical sources.
 *
 * Two directories in `backend/src` are copies, not imports: `flow-engine/`
 * from `quantflow-modules/flow-engine/src`, and `enrichment/firecrawl/` from
 * `quantflow-modules/firecrawl/src/services/firecrawl`. Both modules are ESM
 * and the backend is CJS, so they are copied with relative-import extensions
 * stripped rather than depended on.
 *
 * CLAUDE.md states the obligation — "change the engine here, and mirror it to
 * the module, or the module's test suite stops being a valid baseline for what
 * ships" — and until now nothing enforced it. A drifted copy is the worst
 * shape this can take: the module's suite goes green against code that is not
 * the code running in production, and the tests keep reporting on a file
 * nobody deploys.
 *
 * The only difference allowed is the extension stripping.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(__dirname, '..', '..');

const MIRRORS = [
  {
    name: 'flow-engine',
    vendored: join(ROOT, 'backend', 'src', 'flow-engine'),
    canonical: join(ROOT, 'quantflow-modules', 'flow-engine', 'src'),
  },
  {
    name: 'enrichment/firecrawl',
    vendored: join(ROOT, 'backend', 'src', 'enrichment', 'firecrawl'),
    canonical: join(ROOT, 'quantflow-modules', 'firecrawl', 'src', 'services', 'firecrawl'),
  },
];

/** Every .ts file under a directory, relative to it. */
function tsFiles(dir: string, prefix = ''): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const rel = join(prefix, e.name);
    if (e.isDirectory()) return tsFiles(join(dir, e.name), rel);
    return e.name.endsWith('.ts') ? [rel] : [];
  }).sort();
}

/**
 * Normalize away the differences the vendoring is allowed to introduce.
 *
 * The extension stripping applies everywhere. The other two are *declared*
 * exceptions, written out precisely rather than as a per-file exemption: an
 * allowlist that forgave `engine.ts` wholesale would let real drift hide behind
 * the one method that is legitimately different.
 */
const DECLARED_EXCEPTIONS: Array<{ file: string; why: string; strip: RegExp }> = [
  {
    file: 'engine.ts',
    // CLAUDE.md: "byte-identical to the module apart from an added `resetDaily()`".
    why: 'resetDaily() is a backend addition — the module has no session boundary to reset at',
    strip: /\n[ \t]*\/\*\*(?:(?!\*\/)[\s\S])*?Added for the backend integration[\s\S]*?\*\/\n[ \t]*resetDaily\(\): void \{[\s\S]*?\n[ \t]*\}\n/,
  },
  {
    file: 'index.ts',
    why: 'the vendoring header, which only makes sense on the copy',
    strip: /^\/\*\*\n(?: \*.*\n)*? \* Vendored from[\s\S]*?\*\/\n/,
  },
];

function normalize(src: string, file: string): string {
  let out = src.replace(/(from\s+["']\.{1,2}\/[^"']+?)\.js(["'])/g, '$1$2');
  for (const e of DECLARED_EXCEPTIONS) {
    if (e.file === file) out = out.replace(e.strip, '\n');
  }
  // Removing a block leaves the blank line that surrounded it. Collapsing
  // blank-line runs is applied to BOTH sides, so it cannot mask a difference
  // on one of them — and blank lines are the one kind of drift that does not
  // make the module's suite a worse baseline for what ships.
  return out.replace(/\n{2,}/g, '\n').trim();
}

for (const m of MIRRORS) {
  test(`${m.name}: the same files exist on both sides`, () => {
    const vendored = tsFiles(m.vendored);
    const canonical = tsFiles(m.canonical);
    assert.ok(vendored.length > 0, `no vendored files found at ${relative(ROOT, m.vendored)}`);
    assert.deepEqual(
      vendored, canonical,
      `file lists differ — a file added on one side and not the other means the ` +
      `module's suite is testing a different program than the backend ships`,
    );
  });

  test(`${m.name}: every vendored file matches its canonical source`, () => {
    const drifted: string[] = [];

    for (const f of tsFiles(m.canonical)) {
      const a = normalize(readFileSync(join(m.vendored, f), 'utf8'), f);
      const b = normalize(readFileSync(join(m.canonical, f), 'utf8'), f);
      if (a !== b) drifted.push(f);
    }

    assert.deepEqual(
      drifted, [],
      `these differ beyond the import-extension stripping, so the canonical ` +
      `test suite is no longer a baseline for what ships:\n  ${drifted.join('\n  ')}\n` +
      `Mirror the change to both copies.`,
    );
  });
}

test('the normalizer only forgives what is declared, not real edits', () => {
  // A guard on the guard: too permissive a normalizer would hide the drift
  // this file exists to catch, and pass silently while doing it.
  assert.equal(
    normalize('import { A } from "./types.js";', 'x.ts'),
    'import { A } from "./types";',
  );
  // A non-relative import keeps its extension; only relative ones are stripped.
  assert.equal(
    normalize('import x from "pkg/thing.js";', 'x.ts'),
    'import x from "pkg/thing.js";',
  );
  // Substantive differences survive normalization.
  assert.notEqual(normalize('const a = 1;', 'x.ts'), normalize('const a = 2;', 'x.ts'));
  assert.notEqual(
    normalize('if (nbbo.ts > tradeTs) return "AMBIGUOUS";', 'nbbo.ts'),
    normalize('if (nbbo.ts >= tradeTs) return "AMBIGUOUS";', 'nbbo.ts'),
  );
  // The declared exceptions are file-scoped: the same text elsewhere is drift.
  const resetDaily = readFileSync(join(MIRRORS[0]!.vendored, 'engine.ts'), 'utf8');
  assert.ok(resetDaily.includes('resetDaily'), 'engine.ts should still define it');
  assert.ok(
    !normalize(resetDaily, 'engine.ts').includes('resetDaily'),
    'the declared exception should remove it for comparison',
  );
  assert.ok(
    normalize(resetDaily, 'nbbo.ts').includes('resetDaily'),
    'and must not remove it from a file it was not declared for',
  );
});

test('every declared exception says why it exists', () => {
  for (const e of DECLARED_EXCEPTIONS) {
    assert.ok(e.why.length > 20, `${e.file} exception needs a substantive reason`);
  }
});

// ─── The vendored copy is typechecked under the LOOSER config ────────────────

test('the module typecheck is stricter, and the backend loop runs it', () => {
  // Byte-identity is not the whole obligation. The module's tsconfig sets
  // `noUncheckedIndexedAccess` and the backend's does not, so a file in
  // `flow-engine/` is checked more strictly in its canonical home than in the
  // copy that actually ships — and `npm run verify` in `backend/` used to run
  // only the looser one.
  //
  // That is not theoretical. `calendar.ts` moved into the engine carrying
  // `${seen[seen.length - 1]}`, which the backend's config accepted for four
  // days and the module's refused on the first run: under the strict flag that
  // expression is `string | undefined`, so a gap row's reason could have
  // rendered the literal "undefined". The defect was found by running the
  // module's typecheck by hand, which is exactly the kind of check nobody runs.
  const moduleCfg = JSON.parse(
    readFileSync(join(ROOT, 'quantflow-modules', 'flow-engine', 'tsconfig.json'), 'utf8')
      .replace(/\/\/.*$/gm, ''),
  );
  assert.equal(moduleCfg.compilerOptions?.noUncheckedIndexedAccess, true,
    'the module keeps the stricter indexed-access contract — turning it off ' +
    'would silently make the engine no safer than the copy');

  const pkg = JSON.parse(readFileSync(join(ROOT, 'backend', 'package.json'), 'utf8'));
  const typecheck: string = pkg.scripts?.typecheck ?? '';
  assert.match(typecheck, /typecheck:engine/,
    'backend `typecheck` must run the engine\'s own config, or the binding ' +
    'check is one nobody executes');
  assert.match(pkg.scripts?.['typecheck:engine'] ?? '',
    /quantflow-modules\/flow-engine\/tsconfig\.json/,
    'and it must point at the module\'s tsconfig, not re-check the copy');
});

test('the calendar is vendored, so it is covered by the mirror above', () => {
  // Recorded as an explicit claim because the file MOVED into this boundary in
  // the commit that wired it into `expiryInstant`, and a mirror that walks a
  // directory would pass just as happily if the move had only happened on one
  // side.
  for (const dir of [
    join(ROOT, 'backend', 'src', 'flow-engine'),
    join(ROOT, 'quantflow-modules', 'flow-engine', 'src'),
  ]) {
    assert.ok(existsSync(join(dir, 'calendar.ts')), `${dir} carries calendar.ts`);
  }
  // And `expiry.ts` reads it rather than carrying its own market facts.
  const expiry = readFileSync(
    join(ROOT, 'backend', 'src', 'flow-engine', 'expiry.ts'), 'utf8');
  assert.match(expiry, /from ["']\.\/calendar["']/);
});
