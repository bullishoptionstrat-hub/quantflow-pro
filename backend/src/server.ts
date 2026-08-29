import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import helmet from 'helmet';
import { config } from 'dotenv';
import { startIngestion } from './ingestion/index';
import flowRouter from './routes/flow';
import darkpoolRouter from './routes/darkpool';
import gexRouter from './routes/gex';
import chainRouter from './routes/chain';
import healthRouter from './routes/health';
import macroRouter from './routes/macro';
import sentimentRouter from './routes/sentiment';
import { rateLimiter } from './middleware/rateLimiter';
import { requireAuth } from './middleware/auth';
import { installSocketAuth } from './middleware/socketAuth';
import { assertEnvOrExit } from './config/env';
import { resolveDataMode } from './config/dataMode';

config();

// Must run after dotenv and before anything reads a secret. Refuses to boot in
// production when a required secret is missing or blank. Logs names, never values.
assertEnvOrExit();

export const app = express();
export const httpServer = createServer(app);

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';

// Same allowlist the HTTP layer uses. Unlike HTTP, browser socket traffic goes
// direct (there is no rewrite proxy for a WebSocket), so this one is load
// bearing rather than a development convenience.
const CORS_ORIGINS = [FRONTEND_URL, 'http://localhost:3000'];

export const io = new Server(httpServer, {
  // Was `origin: '*'` with `credentials: true` — see docs/FORENSIC_AUDIT.md #29.
  cors: { origin: CORS_ORIGINS, methods: ['GET', 'POST'], credentials: true },
  pingTimeout: 60000,
  pingInterval: 25000,
  transports: ['websocket', 'polling'],
});

// Handshake auth. Installed here, immediately after the server is constructed
// and before any connection handler, because `io.use` only guards handshakes
// that happen after it is registered.
installSocketAuth(io);

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
// HTTP traffic now arrives via the frontend's /api/* rewrite proxy, which is
// server-to-server and sends no Origin — so this only has to cover a browser
// talking to the backend directly, i.e. local development.
app.use(cors({ origin: CORS_ORIGINS, credentials: true }));
app.use(express.json({ limit: '1mb' }));
app.use(rateLimiter(200, 60_000));

// ─── Routes ───────────────────────────────────────────────────────────────────
// Authenticated: these serve paid upstream data (Tradier / Polygon / MarketData).
app.use('/api/flow', requireAuth, flowRouter);
app.use('/api/darkpool', requireAuth, darkpoolRouter);
app.use('/api/gex', requireAuth, gexRouter);
app.use('/api/chain', requireAuth, chainRouter);
app.use('/api/macro', requireAuth, macroRouter);
app.use('/api/sentiment', requireAuth, sentimentRouter);

// Unauthenticated by design — render.yaml sets healthCheckPath: /api/health.
app.use('/api/health', healthRouter);
app.get('/health', (_req, res) => res.json({ ok: true, ts: new Date().toISOString(), uptime: process.uptime() }));

// ─── 404 fallback ─────────────────────────────────────────────────────────────
app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

// ─── Socket.IO ────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`[Socket] connected: ${socket.id}`);
  socket.on('subscribe_ticker', (ticker: string) => {
    if (typeof ticker === 'string' && ticker.length <= 10) socket.join(ticker.toUpperCase());
  });
  socket.on('unsubscribe_ticker', (ticker: string) => socket.leave(ticker.toUpperCase()));
  socket.on('disconnect', () => console.log(`[Socket] disconnected: ${socket.id}`));
});

// ─── Batch broadcast ──────────────────────────────────────────────────────────
// Batching lives in `ingestion/index.ts` (`emitSignals`), which owns the io
// handle and the engine's output. The former `queueBroadcast` here was never
// called, and emitted both a global `flow_batch` and a per-symbol
// `flow_update` — delivering every event twice to room subscribers.

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = Number(process.env.PORT) || 3001;
httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`[Backend] QuantFlow Pro running on port ${PORT}`);
  console.log(`[Backend] Frontend URL: ${FRONTEND_URL}`);
  console.log(`[Backend] DATA_MODE: ${resolveDataMode()}`);

  // requireAuth can only validate tokens when the service-role client exists.
  // Without these it rejects every authenticated route, so say so loudly rather
  // than letting the app look "up" while serving nothing but 401s.
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    console.error(
      '[Backend] FATAL CONFIG: SUPABASE_URL / SUPABASE_SERVICE_KEY are unset — ' +
      'every authenticated /api route will return 401. Set both in the Render dashboard.'
    );
  }

  startIngestion(io);
});

export default app;
