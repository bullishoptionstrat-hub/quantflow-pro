/**
 * Serve a captured backend alongside the frontend's production build.
 *
 * Why this exists. Exercising the UI normally means running the backend, the
 * ML service and `next dev` at once. That is fine on a workstation and
 * impossible on a constrained box: the real backend is ~320MB of ingestion
 * pipeline and `next dev` another ~300MB, and a browser on top of both will
 * not fit. This is ~35MB and serves the same pages against the same data.
 *
 *   npx tsx tools/preview/capture.ts --out .preview/cap     # against a live backend
 *   cd ../frontend && npm run build
 *   npx tsx tools/preview/serve.ts --cap .preview/cap --site ../frontend/.next
 *
 * Both halves come off one origin, so the pages' same-origin `/api/*` calls
 * resolve with no proxy and no CORS.
 *
 * **The handshake gate is imported, not reimplemented.** `authenticateSocket`
 * is the same function `server.ts` installs, so the demo path this exercises
 * is the shipped one. A preview that approximated the gate would be the exact
 * kind of second copy that goes quietly stale — and this repo already has a
 * test suite devoted to that failure mode.
 *
 * What it is not: live. Prices do not move, and every connector shows whatever
 * state it had when the capture was taken. That is the honest shape of a
 * snapshot and the banner in the frontend says as much.
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync, readdirSync, copyFileSync, mkdirSync } from 'node:fs';
import { extname, join, resolve, basename } from 'node:path';
import { Server as SocketServer } from 'socket.io';
import { authenticateSocket } from '../../src/middleware/auth';

function arg(flag: string, fallback: string): string {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

const CAP = resolve(arg('--cap', '.preview/cap'));
const NEXT = resolve(arg('--site', '../frontend/.next'));
const PORT = Number(arg('--port', '3360'));

/** Capture name → the route it answers. Mirrors `capture.ts`. */
const ROUTE_FOR: Record<string, string> = {
  health: '/api/health', flow: '/api/flow', flowstats: '/api/flow/stats',
  unusual: '/api/flow/unusual', darkpool: '/api/darkpool', gex: '/api/gex',
  gexsym: '/api/gex/symbols', macro: '/api/macro', vix: '/api/macro/vix',
  crypto: '/api/macro/crypto', quotes: '/api/macro/quotes', track: '/api/track-record',
};

const routes: Record<string, unknown> = {};
for (const [name, route] of Object.entries(ROUTE_FOR)) {
  const f = join(CAP, `${name}.json`);
  if (existsSync(f)) routes[route] = JSON.parse(readFileSync(f, 'utf8'));
}

/**
 * Lay the prerendered pages out as a static site.
 *
 * `next build` writes `.next/server/app/<route>.html` and the chunks under
 * `.next/static`. Serving them directly is what avoids `next-server`.
 * Middleware does not run, so pages open without the auth redirect — say so
 * rather than letting someone conclude the gate is broken.
 */
function buildSite(): string {
  const site = join(CAP, '..', 'site');
  const appDir = join(NEXT, 'server', 'app');
  if (!existsSync(appDir)) {
    console.error(`No build at ${NEXT}. Run \`npm run build\` in frontend/ first.`);
    process.exit(1);
  }
  mkdirSync(join(site, '_next'), { recursive: true });

  // The chunk tree, copied wholesale.
  (function copyDir(from: string, to: string) {
    mkdirSync(to, { recursive: true });
    for (const e of readdirSync(from, { withFileTypes: true })) {
      if (e.isDirectory()) copyDir(join(from, e.name), join(to, e.name));
      else copyFileSync(join(from, e.name), join(to, e.name));
    }
  })(join(NEXT, 'static'), join(site, '_next', 'static'));

  let pages = 0;
  for (const f of readdirSync(appDir)) {
    if (!f.endsWith('.html')) continue;
    const name = basename(f, '.html');
    if (name === 'index') copyFileSync(join(appDir, f), join(site, 'index.html'));
    else {
      mkdirSync(join(site, name), { recursive: true });
      copyFileSync(join(appDir, f), join(site, name, 'index.html'));
    }
    pages++;
  }
  console.log(`[preview] ${pages} prerendered pages`);
  return site;
}

const SITE = buildSite();

const MIME: Record<string, string> = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.txt': 'text/plain', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.woff': 'font/woff',
  '.woff2': 'font/woff2', '.map': 'application/json',
};

const server = createServer((req, res) => {
  const path = (req.url ?? '/').split('?')[0]!.replace(/\/+$/, '') || '/';

  if (path in routes) {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(routes[path]));
  }
  if (path.startsWith('/api/')) {
    // Named explicitly: an endpoint that was never captured is a gap in the
    // fixture, not a backend that is down, and the two look identical from a page.
    res.writeHead(404, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: `Not captured: ${path}` }));
  }

  let file = join(SITE, path === '/' ? 'index.html' : path);
  if (!extname(file)) file = join(file, 'index.html');
  if (!resolve(file).startsWith(SITE)) { res.writeHead(403); return res.end(); }

  try {
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    res.end(readFileSync(file));
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  }
});

// ─── The feed ───────────────────────────────────────────────────────────────

const io = new SocketServer(server, { cors: { origin: true, credentials: true } });

io.use(async (socket, next) => {
  const result = await authenticateSocket(socket.handshake.auth ?? {});
  next(result.ok ? undefined : new Error(result.reason));
});

const captured = (routes['/api/flow'] as { data?: unknown[] } | undefined)?.data ?? [];

io.on('connection', (socket) => {
  // Replayed in small batches on the same `flow_batch` event the real pipeline
  // uses, so the page's socket handling is genuinely exercised rather than the
  // feed being stubbed out at the component.
  let i = 0;
  const timer = setInterval(() => {
    if (i >= captured.length) return clearInterval(timer);
    socket.emit('flow_batch', captured.slice(i, i + 3));
    i += 3;
  }, 350);
  socket.on('disconnect', () => clearInterval(timer));
});

server.listen(PORT, () => {
  const manifest = existsSync(join(CAP, 'manifest.json'))
    ? JSON.parse(readFileSync(join(CAP, 'manifest.json'), 'utf8'))
    : null;
  console.log(`[preview] ${Object.keys(routes).length} endpoints, ${captured.length} signals`);
  if (manifest?.capturedAt) console.log(`[preview] snapshot from ${manifest.capturedAt}`);
  if (!process.env.DEMO_MODE) {
    // The gate is the real one, so it refuses a demo socket unless the
    // deployment opted in — exactly as in production.
    console.warn('[preview] DEMO_MODE is not 1, so the feed will refuse every socket. ' +
                 'Start with DEMO_MODE=1 for the flow page to fill.');
  }
  console.log(`[preview] http://localhost:${PORT}`);
});
