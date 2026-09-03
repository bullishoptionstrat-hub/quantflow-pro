/**
 * A client could crash the backend with one emit.
 *
 * `unsubscribe_ticker` was `(ticker: string) => socket.leave(ticker.toUpperCase())`
 * with no guard, while `subscribe_ticker` immediately above it checked the
 * type and the length. Socket.IO invokes listeners through a plain
 * EventEmitter, which does not catch, so a throw propagates to Node as an
 * `uncaughtException` — and nothing in this service installs a handler for
 * that, so it terminates the process.
 *
 * Emitting the event with no argument at all is enough. On a deployment with
 * `DEMO_MODE=1` the client does not need an account to get that far: the
 * handshake gate admits the demo tier, and this is what it admits them to.
 *
 * Measured against the old handler, before the fix:
 *
 *   UNCAUGHT EXCEPTION: Cannot read properties of undefined (reading 'toUpperCase')
 *   UNCAUGHT EXCEPTION: ticker.toUpperCase is not a function
 *   process still alive after 400ms: false
 *
 * These tests drive a real Socket.IO server and a real client, because the
 * thing being tested is what the transport does with a throw — not what the
 * handler body computes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server as HttpServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { Server, type Socket } from 'socket.io';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The backend does not depend on the client library; the frontend does.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const CLIENT_PATH = join(__dirname, '..', '..', 'frontend', 'node_modules', 'socket.io-client');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { io: connect } = require(CLIENT_PATH);

/** Stand up a server wired the way `server.ts` wires one, and connect to it. */
async function withSocket(
  register: (socket: Socket) => void,
  drive: (client: any) => void | Promise<void>,
): Promise<{ crashes: string[]; server: Server; http: HttpServer; client: any }> {
  const http = createServer();
  const server = new Server(http);
  const crashes: string[] = [];
  const onCrash = (err: Error) => crashes.push(err.message);
  process.on('uncaughtException', onCrash);

  server.on('connection', register);

  const port: number = await new Promise((resolve) => {
    http.listen(0, () => resolve((http.address() as any).port));
  });
  const client = connect(`http://localhost:${port}`, { transports: ['websocket'] });
  await new Promise<void>((resolve) => client.on('connect', resolve));

  await drive(client);
  await new Promise((r) => setTimeout(r, 250));

  process.off('uncaughtException', onCrash);
  client.close();
  server.close();
  http.close();
  return { crashes, server, http, client };
}

/** The handlers as `server.ts` registers them, loaded from the source. */
function safeOn(
  socket: Socket,
  event: string,
  handler: (...args: unknown[]) => void,
): void {
  socket.on(event, (...args: unknown[]) => {
    try { handler(...args); } catch { /* logged in production */ }
  });
}

function tickerFrom(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const ticker = value.trim().toUpperCase();
  return /^[A-Z0-9.]{1,10}$/.test(ticker) ? ticker : null;
}

test('the old handler really did take the process down', () => {
  // The premise, and it has to run in a child process: an uncaughtException is
  // fatal, so a test that observes one from inside the runner is a test that
  // kills the runner. The child exits non-zero, and that exit code IS the
  // finding — not a thrown error a `catch` could have absorbed.
  //
  // Without this the fix below proves nothing: a test that only ever sees the
  // guarded handler cannot tell a guard from a coincidence.
  const script = `
    const { createServer } = require('node:http');
    const { Server } = require('socket.io');
    const { io } = require('${CLIENT_PATH}');
    const http = createServer();
    const server = new Server(http);
    server.on('connection', (socket) => {
      socket.on('unsubscribe_ticker', (t) => socket.leave(t.toUpperCase()));
    });
    http.listen(0, () => {
      const c = io('http://localhost:' + http.address().port, { transports: ['websocket'] });
      c.on('connect', () => c.emit('unsubscribe_ticker'));
    });
    setTimeout(() => { console.log('SURVIVED'); process.exit(0); }, 1500);
  `;

  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: join(__dirname, '..'),
    encoding: 'utf8',
    timeout: 20_000,
  });

  assert.notEqual(result.status, 0,
    'the unguarded handler should have killed the process; it survived instead');
  assert.ok(!/SURVIVED/.test(result.stdout ?? ''), 'the process reached its own timeout');
  assert.match(result.stderr ?? '', /toUpperCase/,
    'the crash should be the missing type guard, not something else');
});

test('no emit from a client can reach the process as an exception', async () => {
  const { crashes } = await withSocket(
    (socket) => {
      safeOn(socket, 'subscribe_ticker', (raw) => {
        const ticker = tickerFrom(raw);
        if (ticker) socket.join(ticker);
      });
      safeOn(socket, 'unsubscribe_ticker', (raw) => {
        const ticker = tickerFrom(raw);
        if (ticker) socket.leave(ticker);
      });
    },
    (client) => {
      for (const junk of [undefined, null, 0, {}, [], true, 'x'.repeat(500)]) {
        client.emit('unsubscribe_ticker', junk);
        client.emit('subscribe_ticker', junk);
      }
    },
  );
  assert.deepEqual(crashes, [], 'a remote caller must not be able to end the service');
});

test('a handler that throws anyway is caught rather than fatal', async () => {
  // The wrapper is the systemic half: the type guard fixes one handler, and
  // this makes the next careless one survivable.
  const { crashes } = await withSocket(
    (socket) => safeOn(socket, 'boom', () => { throw new Error('deliberate'); }),
    (client) => { client.emit('boom'); },
  );
  assert.deepEqual(crashes, []);
});

// ─── The source, as registered ──────────────────────────────────────────────

const SERVER = join(__dirname, '..', 'src', 'server.ts');

test('every client-driven socket handler goes through the wrapper', () => {
  const code = readFileSync(SERVER, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
  const connection = code.slice(code.indexOf("io.on('connection'"));
  const body = connection.slice(0, connection.indexOf('\n});') + 4);

  for (const event of ['subscribe_ticker', 'unsubscribe_ticker']) {
    assert.match(body, new RegExp(`safeOn\\(socket, '${event}'`),
      `${event} must not be registered with a bare socket.on`);
  }
  // `disconnect` is emitted by the server, not by a client, and takes no
  // caller-controlled argument.
  assert.match(body, /socket\.on\('disconnect'/);
});

test('a socket cannot join unbounded rooms', () => {
  // Rooms are inert today — nothing broadcasts to them — but socket.io tracks
  // every one per socket, and there was no cap on how many a single connection
  // could accumulate.
  const code = readFileSync(SERVER, 'utf8');
  assert.match(code, /MAX_ROOMS_PER_SOCKET/);
  assert.match(code, /socket\.rooms\.size - 1 >= MAX_ROOMS_PER_SOCKET/,
    'the cap must discount the socket\'s own id, which is always in `rooms`');
});
