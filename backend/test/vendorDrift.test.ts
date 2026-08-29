/**
 * VENDORING DRIFT GUARD
 *
 * `backend/src/domain/**` and `backend/src/flow-engine/**` are compiled-in
 * copies of packages that live elsewhere in the repo. Vendoring is deliberate
 * — see scripts/sync-vendored.mjs for why the Render build shape forces it —
 * but its failure mode is silent divergence.
 *
 * CLAUDE.md already states the stake for the engine copy: "Change the engine
 * here, and mirror it to the module — or the module's test suite stops being a
 * valid baseline for what ships." Until now that was enforced by nothing but
 * the sentence itself. A copy that has quietly drifted means the 14 engine
 * tests and the 45 domain tests are testing something other than the code that
 * runs in production, which is a worse position than having no tests at all,
 * because the green check actively misleads.
 *
 * These tests make divergence a failure rather than a discovery.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const REPO = join(__dirname, '..', '..');

function walkTs(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walkTs(full, base));
    else if (entry.endsWith('.ts')) out.push(relative(base, full));
  }
  return out.sort();
}

/** Mirrors the single transformation scripts/sync-vendored.mjs applies. */
function stripJsExtensions(source: string): string {
  return source.replace(/(from\s+["']\.[^"']*?)\.js(["'])/g, '$1$2');
}

/** Drop the generated header so the comparison is of real content. */
function withoutHeader(source: string): string {
  return source.startsWith('// AUTO-GENERATED')
    ? source.split('\n').slice(4).join('\n')
    : source;
}

describe('@quantflow/domain vendored copy matches its canonical source', () => {
  const canonicalDir = join(REPO, 'packages', 'domain', 'src');
  const vendoredDir = join(REPO, 'backend', 'src', 'domain');

  it('vendors every canonical file — none silently omitted', () => {
    const canonical = walkTs(canonicalDir);
    const vendored = walkTs(vendoredDir);
    assert.deepEqual(vendored, canonical,
      'file sets differ; run: node scripts/sync-vendored.mjs');
  });

  it('every vendored file is byte-identical after extension stripping', () => {
    for (const rel of walkTs(canonicalDir)) {
      const canonical = stripJsExtensions(readFileSync(join(canonicalDir, rel), 'utf8'));
      const vendored = withoutHeader(readFileSync(join(vendoredDir, rel), 'utf8'));
      assert.equal(vendored, canonical,
        `${rel} has drifted from packages/domain/src/${rel}. ` +
        'Edit the canonical source and run: node scripts/sync-vendored.mjs');
    }
  });

  it('every vendored file carries the do-not-edit header', () => {
    for (const rel of walkTs(vendoredDir)) {
      const text = readFileSync(join(vendoredDir, rel), 'utf8');
      assert.ok(text.startsWith('// AUTO-GENERATED — DO NOT EDIT.'),
        `${rel} is missing the generated header — was it hand-edited?`);
    }
  });
});

describe('flow-engine vendored copy matches its canonical module', () => {
  /**
   * This copy predates the sync script and carries one INTENTIONAL addition:
   * `resetDaily()`, which CLAUDE.md documents. So the assertion here is
   * "identical apart from that method", not "identical" — stated explicitly so
   * the exception cannot quietly widen into a second, then a third difference.
   */
  const canonicalDir = join(REPO, 'quantflow-modules', 'flow-engine', 'src');
  const vendoredDir = join(REPO, 'backend', 'src', 'flow-engine');

  it('vendors every canonical file', () => {
    assert.deepEqual(walkTs(vendoredDir), walkTs(canonicalDir));
  });

  /**
   * The exact text of the sanctioned addition, as a literal. Written out in
   * full rather than matched by pattern so that ANY edit to it — even a
   * reworded comment — trips this test and forces a deliberate decision,
   * instead of a loose regex quietly absorbing new differences.
   */
  const SANCTIONED_ADDITION = [
    '  /**',
    '   * Clear per-session state. `repeatHits` is scored as "prior signals on the',
    '   * same contract+side *today*", so a long-lived process must reset it at the',
    '   * session boundary — otherwise every contract drifts toward the maximum',
    '   * repeat component and `splitBuf` grows without bound.',
    '   *',
    '   * Added for the backend integration; not present in the standalone module.',
    '   */',
    '  resetDaily(): void {',
    '    this.repeatHits.clear();',
    '    this.splitBuf.clear();',
    '  }',
    '',
  ].join('\n') + '\n';

  it('differs from the module ONLY by extension stripping and resetDaily()', () => {
    const unexpected: string[] = [];

    for (const rel of walkTs(canonicalDir)) {
      const canonical = stripJsExtensions(readFileSync(join(canonicalDir, rel), 'utf8'));
      const vendored = readFileSync(join(vendoredDir, rel), 'utf8');
      if (vendored === canonical) continue;

      // engine.ts may differ by exactly the sanctioned addition and nothing else.
      if (rel === 'engine.ts' && vendored.replace(SANCTIONED_ADDITION, '') === canonical) continue;

      unexpected.push(rel);
    }

    assert.deepEqual(unexpected, [],
      'flow-engine copy has drifted beyond the documented resetDaily() addition. ' +
      'CLAUDE.md: change the engine here AND mirror it to the module.');
  });

  it('the sanctioned addition is actually present — the exception is not vacuous', () => {
    // If resetDaily were removed from the vendored copy, the test above would
    // still pass (no drift). This asserts the documented difference exists, so
    // the allowance describes reality rather than permitting anything.
    const vendored = readFileSync(join(vendoredDir, 'engine.ts'), 'utf8');
    assert.ok(vendored.includes(SANCTIONED_ADDITION), 'resetDaily() addition is missing');
  });
});
