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

config();

export const app = express();
export const httpServer = createServer(app);

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';

export const io = new Server(httpServer, {
  cors: { origin: '*', methods: ['GET', 'POST'], credentials: true },
  pingTimeout: 60000,
  pingInterval: 25000,
  transports: ['websocket', 'polling'],
});

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: '*', credentials: true }));
app.use(express.json({ limit: '1mb' }));
app.use(rateLimiter(200, 60_000));

// ─── Routes ───────────────────────────────────────────────────────────────────
app.use('/api/flow', flowRouter);
app.use('/api/darkpool', darkpoolRouter);
app.use('/api/gex', gexRouter);
app.use('/api/chain', chainRouter);
app.use('/api/macro', macroRouter);
app.use('/api/sentiment', sentimentRouter);
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

// ─── Batch broadcast queue ────────────────────────────────────────────────────
const eventQueue: any[] = [];
let batchTimer: ReturnType<typeof setTimeout> | null = null;

export function queueBroadcast(event: any) {
  eventQueue.push(event);
  if (!batchTimer) {
    batchTimer = setTimeout(() => {
      if (eventQueue.length > 0) {
        io.emit('flow_batch', [...eventQueue]);
        eventQueue.forEach((e) => { if (e.symbol) io.to(e.symbol).emit('flow_update', e); });
      }
      eventQueue.length = 0;
      batchTimer = null;
    }, 100);
  }
}

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = Number(process.env.PORT) || 3001;
httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`[Backend] QuantFlow Pro running on port ${PORT}`);
  console.log(`[Backend] Frontend URL: ${FRONTEND_URL}`);
  startIngestion(io);
});

export default app;
