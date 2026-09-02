/**
 * Root build for Vercel projects whose Root Directory is the repo root.
 *
 * WHY THIS EXISTS: the repository root is a monorepo *verification* entrypoint,
 * not a deployable app — the deployable frontend lives in `frontend/`, which
 * has its own Vercel project and its own `vercel.json`.
 *
 * WHAT THIS IS NOT: this was originally added believing it would fix a failing
 * `Vercel - quantflow-deploy` check. It did not. That check was already failing
 * on PR #2 in July, in a tree with no root `package.json` at all, so it is
 * pre-existing and unrelated (see IMPLEMENTATION_LEDGER.md - CORRECTION).
 *
 * It is kept on its own smaller merit: without a root `build` script,
 * `npm run build` at the repo root fails with `Missing script: "build"`, and
 * any Vercel project that auto-detects a Node project here would too. This
 * emits a small static page into `public/` (Vercel's default output directory
 * for the "Other" preset) so that command does something sensible and says
 * plainly what the root is.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'public');

mkdirSync(outDir, { recursive: true });

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>QuantFlow Pro — repository root</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; min-height:100vh; display:grid; place-items:center;
         background:#09090b; color:#e4e4e7;
         font:15px/1.6 ui-monospace,"JetBrains Mono",Menlo,monospace; padding:24px; }
  main { max-width:34rem; }
  h1 { font-size:17px; margin:0 0 12px; color:#fafafa; }
  p { margin:0 0 12px; color:#a1a1aa; }
  code { color:#fbbf24; }
</style>
</head>
<body>
<main>
  <h1>QuantFlow Pro — repository root</h1>
  <p>This is the monorepo root, which is a verification entrypoint rather than a
     deployable application. Nothing is served from here.</p>
  <p>The deployable frontend is the <code>frontend/</code> workspace, which has its
     own Vercel project and configuration.</p>
</main>
</body>
</html>
`;

writeFileSync(join(outDir, 'index.html'), html);
console.log(`[root build] wrote ${join(outDir, 'index.html')}`);
