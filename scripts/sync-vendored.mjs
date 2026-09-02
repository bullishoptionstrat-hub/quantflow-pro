#!/usr/bin/env node
/**
 * Sync canonical packages into the backend's vendored copies.
 *
 * ─── WHY VENDOR AT ALL ──────────────────────────────────────────────────────
 *
 * The backend deploys to Render with `rootDir: backend`, building via
 * `npm install && npm run build` and starting with `node dist/server.js`
 * (render.yaml). A `file:../packages/domain` dependency would install as a
 * symlink whose `main` points at `dist/index.js` — and nothing in that build
 * ever compiles the domain package, so the import would resolve to nothing at
 * runtime. Making the backend's build compile a sibling package would depend
 * on Render's checkout shape, which cannot be verified from a dev environment.
 *
 * So the backend keeps a compiled-in copy. This is the same decision already
 * documented in CLAUDE.md for `backend/src/flow-engine/`, for the same reason.
 *
 * ─── WHY THIS SCRIPT EXISTS ─────────────────────────────────────────────────
 *
 * Vendoring's failure mode is silent drift, and CLAUDE.md already warns about
 * it: "Change the engine here, and mirror it to the module — or the module's
 * test suite stops being a valid baseline for what ships." That warning was
 * enforced by nothing. This script makes the copy reproducible, and
 * `backend/test/vendorDrift.test.ts` makes divergence a test failure rather
 * than a discovery.
 *
 * Usage:  node scripts/sync-vendored.mjs [--check]
 *   --check  exit non-zero if any vendored file is out of date (for CI)
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;

/** Canonical source -> vendored destination. */
export const VENDOR_TARGETS = [
  { name: '@quantflow/domain', from: 'packages/domain/src', to: 'backend/src/domain' },
];

/**
 * The backend compiles as CommonJS, where TypeScript resolves `./x` directly.
 * The canonical packages use explicit `./x.js` specifiers (correct for ESM
 * output). Stripping the extension is the ONLY transformation applied — if
 * this ever needs to do more than that, the vendoring approach has stopped
 * being appropriate and should be revisited rather than extended.
 */
export function transform(source) {
  return source.replace(/(from\s+["']\.[^"']*?)\.js(["'])/g, '$1$2');
}

function walk(dir, base = dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full, base));
    else if (entry.endsWith('.ts')) out.push(relative(base, full));
  }
  return out.sort();
}

const HEADER = (name, rel) =>
  `// AUTO-GENERATED — DO NOT EDIT.\n` +
  `// Vendored from ${name} (${rel}) by scripts/sync-vendored.mjs.\n` +
  `// Edit the canonical source and re-run the script; backend/test/vendorDrift.test.ts\n` +
  `// fails if this copy drifts.\n`;

const check = process.argv.includes('--check');
let stale = 0;
let written = 0;

for (const target of VENDOR_TARGETS) {
  const fromDir = join(ROOT, target.from);
  const toDir = join(ROOT, target.to);

  for (const rel of walk(fromDir)) {
    const src = readFileSync(join(fromDir, rel), 'utf8');
    const expected = HEADER(target.name, `${target.from}/${rel}`) + transform(src);
    const destPath = join(toDir, rel);

    let current = null;
    try { current = readFileSync(destPath, 'utf8'); } catch { /* absent */ }

    if (current === expected) continue;

    if (check) {
      console.error(`STALE: ${target.to}/${rel}`);
      stale++;
    } else {
      mkdirSync(dirname(destPath), { recursive: true });
      writeFileSync(destPath, expected);
      console.log(`wrote ${target.to}/${rel}`);
      written++;
    }
  }
}

if (check) {
  if (stale > 0) {
    console.error(`\n${stale} vendored file(s) out of date. Run: node scripts/sync-vendored.mjs`);
    process.exit(1);
  }
  console.log('vendored copies are in sync');
} else {
  console.log(written === 0 ? 'already in sync' : `synced ${written} file(s)`);
}
