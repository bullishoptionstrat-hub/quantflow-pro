/**
 * A throwaway Supabase-shaped stack: a real PostgreSQL cluster with every file
 * in `supabase/` applied, a real PostgREST in front of it, and the `/rest/v1`
 * prefix `@supabase/supabase-js` expects. ROADMAP 1.1d.
 *
 * Why this exists. `supabaseStore.ts` was covered only by stubs shaped like
 * PostgREST replies, and a stub agrees with whatever query the code builds —
 * which is how `listUngraded` shipped returning nothing on a healthy
 * deployment. The only thing that can disagree with a query is the server
 * that runs it.
 *
 * What it is not. It is not Supabase: no GoTrue, no Realtime, no storage, no
 * pooler, and `supabaseShim.sql` stands in for the roles and the `auth`
 * schema. What it *does* share with Supabase is the part the store touches:
 * PostgreSQL's constraints, triggers and RLS, and PostgREST's query grammar,
 * JSON serialization (`numeric` as a string, `timestamptz` as ISO) and
 * `Content-Range` counts.
 *
 * The JWT secret is minted per run and the cluster is deleted on `stop()`;
 * nothing here is, or reads, a real credential.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { chownSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const REPO = path.resolve(__dirname, '../../..');
const SUPABASE_DIR = path.join(REPO, 'supabase');
const SHIM = path.join(__dirname, 'supabaseShim.sql');

export interface Stack {
  /** What `createClient` takes as the project URL. */
  url: string;
  serviceKey: string;
  anonKey: string;
  /** Run SQL directly, as the cluster's superuser. */
  psql(sql: string): string;
  stop(): Promise<void>;
}

/** Which binaries the stack needs, and where it looked. Thrown, never skipped. */
export function locateBinaries(): { pgBin: string; postgrest: string } {
  const candidates = [
    process.env.PG_BIN,
    ...listPgBins(),
  ].filter((p): p is string => typeof p === 'string' && p.length > 0);
  const pgBin = candidates.find((d) => existsSync(path.join(d, 'initdb')));
  const postgrest = [process.env.POSTGREST_BIN, which('postgrest')]
    .find((p): p is string => typeof p === 'string' && p.length > 0 && existsSync(p));
  if (!pgBin || !postgrest) {
    throw new Error(
      'The Postgres stack needs PostgreSQL server binaries (initdb, pg_ctl) and PostgREST. '
      + `initdb: ${pgBin ?? 'not found (set PG_BIN)'}; postgrest: ${postgrest ?? 'not found (set POSTGREST_BIN)'}. `
      + 'This suite refuses rather than skips: a skipped database test reads exactly like a passing one.',
    );
  }
  return { pgBin, postgrest };
}

function listPgBins(): string[] {
  const root = '/usr/lib/postgresql';
  if (!existsSync(root)) return [];
  return readdirSync(root).sort().reverse().map((v) => path.join(root, v, 'bin'));
}

function which(cmd: string): string | undefined {
  const r = spawnSync('sh', ['-c', `command -v ${cmd}`], { encoding: 'utf8' });
  const out = r.stdout.trim();
  return out.length > 0 ? out : undefined;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      s.close(() => (typeof addr === 'object' && addr ? resolve(addr.port) : reject(new Error('no port'))));
    });
  });
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');

/** HS256, the algorithm Supabase's legacy keys use. */
export function signJwt(payload: Record<string, unknown>, secret: string): string {
  const head = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const sig = createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}

/** The cluster refuses to run as root, so a root caller drops to `postgres`. */
function asPgUser(argv: string[]): [string, string[]] {
  if (process.getuid?.() === 0) return ['runuser', ['-u', 'postgres', '--', ...argv]];
  return [argv[0]!, argv.slice(1)];
}

function run(argv: string[], input?: string): string {
  const [cmd, args] = asPgUser(argv);
  const r = spawnSync(cmd, args, { encoding: 'utf8', input });
  if (r.status !== 0) {
    throw new Error(`${argv.join(' ')} exited ${r.status}:\n${r.stderr || r.stdout}`);
  }
  return r.stdout;
}

/** `schema.sql`, then every migration in filename order — the documented setup. */
export function setupFiles(): string[] {
  const migrations = readdirSync(path.join(SUPABASE_DIR, 'migrations'))
    .filter((f) => f.endsWith('.sql')).sort()
    .map((f) => path.join(SUPABASE_DIR, 'migrations', f));
  return [path.join(SUPABASE_DIR, 'schema.sql'), ...migrations];
}

async function waitFor(url: string, deadlineMs: number): Promise<void> {
  const until = Date.now() + deadlineMs;
  let last = '';
  while (Date.now() < until) {
    try {
      const res = await fetch(url);
      if (res.status < 500) return;
      last = `HTTP ${res.status}`;
    } catch (e) {
      last = (e as Error).message;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`PostgREST did not come up at ${url}: ${last}`);
}

export async function startStack(): Promise<Stack> {
  const { pgBin, postgrest } = locateBinaries();
  const dir = mkdtempSync(path.join(os.tmpdir(), 'qf-pgstack-'));
  const data = path.join(dir, 'data');
  if (process.getuid?.() === 0) {
    const pw = spawnSync('id', ['-u', 'postgres'], { encoding: 'utf8' });
    const gw = spawnSync('id', ['-g', 'postgres'], { encoding: 'utf8' });
    chownSync(dir, Number(pw.stdout.trim()), Number(gw.stdout.trim()));
  }

  const pgPort = await freePort();
  const apiPort = await freePort();
  const proxyPort = await freePort();
  const secret = randomBytes(32).toString('hex');

  run([path.join(pgBin, 'initdb'), '-D', data, '-U', 'postgres', '--auth=trust', '-E', 'UTF8', '--no-sync']);
  run([path.join(pgBin, 'pg_ctl'), '-D', data, '-w', '-l', path.join(dir, 'pg.log'), '-o',
    `-p ${pgPort} -k ${dir} -c listen_addresses=127.0.0.1 -c fsync=off`, 'start']);

  const psqlArgs = [path.join(pgBin, 'psql'), '-h', dir, '-p', String(pgPort), '-U', 'postgres',
    '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q', '-X'];
  const psql = (sql: string) => run([...psqlArgs, '-At'], sql);

  let api: ChildProcess | undefined;
  let proxy: http.Server | undefined;
  const stop = async () => {
    proxy?.close();
    if (api && api.exitCode === null) {
      api.kill('SIGTERM');
      await new Promise((r) => api!.once('exit', r));
    }
    try { run([path.join(pgBin, 'pg_ctl'), '-D', data, '-m', 'immediate', 'stop']); } catch { /* already down */ }
    rmSync(dir, { recursive: true, force: true });
  };

  try {
    psql(readFileSync(SHIM, 'utf8'));
    for (const f of setupFiles()) {
      run([...psqlArgs, '-f', f]);
    }

    api = spawn(postgrest, [], {
      env: {
        PATH: process.env.PATH,
        PGRST_DB_URI: `postgres://authenticator@127.0.0.1:${pgPort}/postgres`,
        PGRST_DB_SCHEMAS: 'public',
        PGRST_DB_ANON_ROLE: 'anon',
        PGRST_JWT_SECRET: secret,
        PGRST_SERVER_HOST: '127.0.0.1',
        PGRST_SERVER_PORT: String(apiPort),
        PGRST_LOG_LEVEL: 'error',
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });

    // supabase-js addresses `${url}/rest/v1/<table>`; PostgREST serves `/<table>`.
    // A large header ceiling so the proxy is never the limit being measured:
    // PostgREST puts an `in.(…)` filter in the URL, and how long a URL the
    // *server* accepts is one of the things this stack exists to find out.
    proxy = http.createServer({ maxHeaderSize: 1 << 20 }, (req, res) => {
      const target = (req.url ?? '/').replace(/^\/rest\/v1/, '') || '/';
      const up = http.request(
        { host: '127.0.0.1', port: apiPort, path: target, method: req.method, headers: req.headers, maxHeaderSize: 1 << 20 },
        (r) => { res.writeHead(r.statusCode ?? 502, r.headers); r.pipe(res); },
      );
      up.on('error', (e) => { res.writeHead(502); res.end(e.message); });
      req.pipe(up);
    });
    await new Promise<void>((r) => proxy!.listen(proxyPort, '127.0.0.1', r));
    await waitFor(`http://127.0.0.1:${apiPort}/`, 15_000);
  } catch (e) {
    await stop();
    throw e;
  }

  const issued = Math.floor(Date.now() / 1000);
  const key = (role: string) => signJwt({ iss: 'supabase', role, iat: issued, exp: issued + 3600 }, secret);
  return {
    url: `http://127.0.0.1:${proxyPort}`,
    serviceKey: key('service_role'),
    anonKey: key('anon'),
    psql,
    stop,
  };
}
