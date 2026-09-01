import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import helmet from 'helmet';
import { config } from 'dotenv';
import { startIngestion } from './ingestion/index';
import { startEnrichment } from './enrichment/index';
import flowRouter from './routes/flow';
import darkpoolRouter from './routes/darkpool';
import gexRouter from './routes/gex';
import chainRouter from './routes/chain';
import healthRouter from './routes/health';
import trackRecordRouter from './routes/trackRecord';
import macroRouter from './routes/macro';
import sentimentRouter from './routes/sentiment';
import { rateLimiter } from './middleware/rateLimiter';
import {
  requireAuth, requireAuthOrDemo, isDemoModeEnabled, DEMO_HEADER,
  authenticateSocket, socketAuthConfigured,
} from './middleware/auth';

config();

export const app = express();
export const httpServer = createServer(app);

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';

// `NEXT_PUBLIC_WS_URL` points the browser straight at this server rather than
// through the frontend's /api/* rewrite, so unlike the HTTP path below this is
// a real browser-to-backend connection and the allowed origin actually does
// something. It was `'*'` with `credentials: true`.
const CORS_ORIGINS = [FRONTEND_URL, 'http://localhost:3000'];

export const io = new Server(httpServer, {
  cors: { origin: CORS_ORIGINS, methods: ['GET', 'POST'], credentials: true },
  pingTimeout: 60000,
  pingInterval: 25000,
  transports: ['websocket', 'polling'],
});

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
// HTTP traffic now arrives via the frontend's /api/* rewrite proxy, which is
// server-to-server and sends no Origin — so this only has to cover a browser
// talking to the backend directly, i.e. local development. (`CORS_ORIGINS` is
// declared above, with the Socket.IO server that shares it.)
app.use(cors({ origin: CORS_ORIGINS, credentials: true }));
app.use(express.json({ limit: '1mb' }));
app.use(rateLimiter(200, 60_000));

// ─── Routes ───────────────────────────────────────────────────────────────────
//
// Two tiers. `requireAuthOrDemo` additionally admits the read-only demo session
// when the deployment sets DEMO_MODE=1; `requireAuth` never does.
//
// The split is "does this call cost money or return entitled vendor data".
// /api/chain reads paid options chains, and the enrichment endpoints inside the
// sentiment router spend metered Firecrawl credits per call — those stay on
// requireAuth (the enrichment ones re-apply it individually inside the router,
// since their parent is on the demo-capable tier).
const demoRateLimit = rateLimiter(40, 60_000, 'demo');

/** Tighter bucket for unauthenticated demo traffic; authenticated calls skip it. */
function limitDemoTraffic(req: any, res: any, next: any) {
  if (req.headers[DEMO_HEADER] === '1' && isDemoModeEnabled()) {
    return demoRateLimit(req, res, next);
  }
  next();
}

app.use('/api/flow', limitDemoTraffic, requireAuthOrDemo, flowRouter);
app.use('/api/darkpool', limitDemoTraffic, requireAuthOrDemo, darkpoolRouter);
app.use('/api/gex', limitDemoTraffic, requireAuthOrDemo, gexRouter);
app.use('/api/macro', limitDemoTraffic, requireAuthOrDemo, macroRouter);
app.use('/api/sentiment', limitDemoTraffic, requireAuthOrDemo, sentimentRouter);
// Costs nothing per call and returns only aggregates that are already
// sample-gated, so it is safe on the demo tier.
app.use('/api/track-record', limitDemoTraffic, requireAuthOrDemo, trackRecordRouter);

// Never demo-accessible: paid chain data.
app.use('/api/chain', requireAuth, chainRouter);

// Unauthenticated by design — render.yaml sets healthCheckPath: /api/health.
app.use('/api/health', healthRouter);
app.get('/health', (_req, res) => res.json({ ok: true, ts: new Date().toISOString(), uptime: process.uptime() }));

// ─── 404 fallback ─────────────────────────────────────────────────────────────
app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

// ─── Socket.IO ────────────────────────────────────────────────────────────────
/**
 * The feed is gated at the handshake, on the same terms as `/api/flow`.
 *
 * `/api/flow` serves these signals behind `requireAuthOrDemo`; the socket
 * broadcasts the same ones and used to admit anyone who connected. The
 * decision lives in `middleware/auth.ts` beside the middleware it mirrors, so
 * the two tiers cannot drift apart.
 *
 * A rejected handshake reaches the client as `connect_error`. The reason
 * string is deliberately just "Unauthorized": it crosses to an
 * unauthenticated caller and must not say which condition failed.
 */
io.use(async (socket, next) => {
  const result = await authenticateSocket(socket.handshake.auth ?? {});
  if (!result.ok) {
    next(new Error(result.reason));
    return;
  }
  socket.data.identity = result.identity;
  next();
});

io.on('connection', (socket) => {
  const who = socket.data.identity?.demo ? 'demo' : socket.data.identity?.user?.id ?? 'unknown';
  console.log(`[Socket] connected: ${socket.id} (${who})`);
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

  // requireAuth can only validate tokens when the service-role client exists.
  // Without these it rejects every authenticated route, so say so loudly rather
  // than letting the app look "up" while serving nothing but 401s.
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    console.error(
      '[Backend] FATAL CONFIG: SUPABASE_URL / SUPABASE_SERVICE_KEY are unset — ' +
      'every authenticated /api route will return 401. Set both in the Render dashboard.'
    );
  }

  // The same condition now closes the socket, and that failure is quieter than
  // the REST one: the frontend falls back to simulated prints when the feed is
  // down, so the terminal keeps rendering and looks fine while receiving
  // nothing real. Said separately, because "the pages still work" is exactly
  // what would stop someone looking.
  if (!socketAuthConfigured()) {
    console.error(
      '[Backend] FATAL CONFIG: the live feed will reject every socket — no ' +
      'Supabase client to verify a token against, and DEMO_MODE is not 1. The ' +
      'frontend will show simulated prints instead and will not look broken. ' +
      'Set SUPABASE_URL / SUPABASE_SERVICE_KEY, or DEMO_MODE=1 for a read-only feed.'
    );
  }

  startIngestion(io);
  // Builds the Firecrawl client if a key is present; it does not fetch anything.
  // Enrichment is demand-driven because its calls cost metered credits.
  startEnrichment();
});

export default app;
