/**
 * FINDING #29 REGRESSION — the socket must not be a way around route auth.
 *
 * The bypass was not subtle: `/api/flow` sat behind `requireAuth` while
 * `flow_batch` — the same payload — was broadcast to any connection, from any
 * origin, with no handshake check at all. These tests pin the handshake
 * decision itself, which is where the bypass lived.
 *
 * A real socket.io server is stood up in the last block so the assertion is
 * "an unauthenticated client receives no data", not merely "a function returned
 * false". A guard that is correct but not actually installed would pass the
 * unit tests and fail the product.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createServer, type Server as HttpServer } from 'node:http';
import { AddressInfo } from 'node:net';
import { Server } from 'socket.io';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';

import {
  authenticateHandshake,
  handshakeToken,
  installSocketAuth,
} from '../src/middleware/socketAuth';
import { resetTokenVerifierForTests } from '../src/middleware/verifyToken';

// No Supabase configured in this environment, so verification resolves to
// `unavailable`. That is deliberately still a refusal — see below.
const NO_SUPABASE_URL = process.env.SUPABASE_URL;
const NO_SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

before(() => {
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_KEY;
  resetTokenVerifierForTests();
});

after(() => {
  if (NO_SUPABASE_URL === undefined) delete process.env.SUPABASE_URL;
  else process.env.SUPABASE_URL = NO_SUPABASE_URL;
  if (NO_SUPABASE_KEY === undefined) delete process.env.SUPABASE_SERVICE_KEY;
  else process.env.SUPABASE_SERVICE_KEY = NO_SUPABASE_KEY;
  resetTokenVerifierForTests();
});

describe('handshake token extraction', () => {
  it('reads auth.token, the placement a browser can actually use', () => {
    assert.equal(handshakeToken({ auth: { token: 'abc' } }), 'abc');
  });

  it('falls back to an Authorization header for non-browser clients', () => {
    assert.equal(handshakeToken({ headers: { authorization: 'Bearer xyz' } }), 'xyz');
  });

  it('treats blank and whitespace-only tokens as absent, not as a token', () => {
    assert.equal(handshakeToken({ auth: { token: '' } }), undefined);
    assert.equal(handshakeToken({ auth: { token: '   ' } }), undefined);
    assert.equal(handshakeToken({ headers: { authorization: 'Bearer ' } }), undefined);
  });

  it('ignores a non-Bearer Authorization scheme', () => {
    assert.equal(handshakeToken({ headers: { authorization: 'Basic abc' } }), undefined);
  });

  it('ignores a non-string token rather than coercing it', () => {
    assert.equal(handshakeToken({ auth: { token: 12345 as unknown as string } }), undefined);
  });
});

describe('handshake decisions fail closed', () => {
  it('refuses a connection with no token', async () => {
    const r = await authenticateHandshake({});
    assert.equal(r.allowed, false);
    assert.equal(r.refusal, 'no_token');
  });

  it('refuses when verification is unavailable — an outage is not a free pass', async () => {
    // This is the case that matters most: when the identity provider cannot be
    // reached, the tempting failure mode is to let connections through so the
    // product keeps working. That would reopen the bypass during exactly the
    // window when nobody is watching.
    const r = await authenticateHandshake({ auth: { token: 'some-token' } });
    assert.equal(r.allowed, false);
    assert.equal(r.refusal, 'verification_unavailable');
    assert.ok(r.reason, 'the cause must be carried, never swallowed');
  });

  it('distinguishes its refusals so a client can act on them', async () => {
    const noToken = await authenticateHandshake({});
    const withToken = await authenticateHandshake({ auth: { token: 't' } });
    assert.notEqual(noToken.refusal, withToken.refusal);
  });
});

describe('END TO END — an unauthenticated client receives no broadcast', () => {
  let httpServer: HttpServer;
  let io: Server;
  let url: string;

  before(async () => {
    httpServer = createServer();
    io = new Server(httpServer);
    installSocketAuth(io);

    // Broadcast continuously, exactly as ingestion does. If the guard is not
    // installed (or is installed after the connection handler), a client will
    // receive one of these and the test fails.
    io.on('connection', (socket) => {
      socket.emit('flow_batch', [{ id: 'secret-1', underlying: 'SPY' }]);
    });
    setInterval(() => io.emit('flow_batch', [{ id: 'secret-broadcast' }]), 20).unref();

    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    url = `http://localhost:${(httpServer.address() as AddressInfo).port}`;
  });

  after(async () => {
    io.close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  it('refuses the handshake and delivers zero flow_batch events', async () => {
    const client: ClientSocket = ioClient(url, {
      transports: ['websocket'],
      reconnection: false,
      timeout: 2000,
    });

    const received: unknown[] = [];
    let connectError: Error | null = null;

    client.on('flow_batch', (payload) => received.push(payload));
    client.on('connect_error', (err) => { connectError = err; });

    // Wait well past several broadcast intervals.
    await new Promise((resolve) => setTimeout(resolve, 300));
    client.close();

    assert.equal(received.length, 0, 'an unauthenticated socket must receive NO market data');
    assert.ok(connectError, 'the handshake must be actively refused, not silently idle');
    assert.equal(client.connected, false);
  });

  it('reports a machine-readable refusal reason to the client', async () => {
    const client: ClientSocket = ioClient(url, {
      transports: ['websocket'],
      reconnection: false,
      timeout: 2000,
    });

    const err = await new Promise<Error & { data?: { refusal?: string } }>((resolve) => {
      client.on('connect_error', (e) => resolve(e as Error & { data?: { refusal?: string } }));
      setTimeout(() => resolve(new Error('no connect_error fired')), 2000);
    });
    client.close();

    assert.ok(err.data?.refusal, 'client must be able to tell "sign in" from "degraded"');
  });
});
