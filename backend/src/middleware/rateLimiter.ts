import { Request, Response, NextFunction } from 'express';

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

// In-memory rate limiter (replace with Upstash Redis in production)
const store = new Map<string, RateLimitEntry>();

/**
 * How many proxies sit in front of this service. Render puts exactly one there.
 *
 * `X-Forwarded-For` grows left to right: each proxy **appends** the address it
 * received the request from. So with one trusted hop the client's real address
 * is the **last** entry — the one our proxy wrote — and everything to its left
 * was supplied by the caller.
 */
const TRUST_PROXY_HOPS = Math.max(0, parseInt(process.env.TRUST_PROXY_HOPS || '1', 10) || 0);

/**
 * The address to count against, taken from a position the caller cannot write.
 *
 * This read `xff.split(',')[0]` — the **leftmost** entry, which is whatever the
 * caller sent. Every request could name a new one and get a fresh bucket, so
 * the limiter counted to one and never fired:
 *
 *     honest, same client x5 : 200 200 200 429 429
 *     forged XFF, same client: 200 200 200 200 200
 *
 * That defeated the global 200/min limiter and, more expensively, the 40/min
 * `demo` bucket that bounds what an unauthenticated caller can cost this
 * deployment.
 *
 * With no header, or fewer entries than trusted hops, this falls back to the
 * socket address — which behind a proxy is the proxy, so every caller shares
 * one bucket. That direction fails closed (everyone throttled) rather than
 * open (nobody throttled), which is the right way round for a
 * misconfiguration.
 */
function getKey(req: Request): string {
  const header = req.headers['x-forwarded-for'];
  const raw = Array.isArray(header) ? header.join(',') : header;
  const chain = (raw ?? '').split(',').map((p) => p.trim()).filter(Boolean);

  if (TRUST_PROXY_HOPS > 0 && chain.length >= TRUST_PROXY_HOPS) {
    return chain[chain.length - TRUST_PROXY_HOPS]!;
  }
  return req.socket.remoteAddress || 'unknown';
}

/**
 * @param keyPrefix Namespaces the counter. Two limiters without distinct
 *   prefixes share one bucket per IP, so a request passing through both would
 *   be counted twice and the tighter limit would throttle the looser one.
 */
export function rateLimiter(
  maxRequests: number = 120,
  windowMs: number = 60_000,
  keyPrefix = ''
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const key = keyPrefix ? `${keyPrefix}:${getKey(req)}` : getKey(req);
    const now = Date.now();
    const entry = store.get(key);

    if (!entry || entry.resetAt < now) {
      store.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }

    if (entry.count >= maxRequests) {
      res.setHeader('Retry-After', Math.ceil((entry.resetAt - now) / 1000));
      res.status(429).json({ error: 'Too Many Requests' });
      return;
    }

    entry.count++;
    next();
  };
}

// Clean up stale entries every 5 minutes.
//
// `.unref()` because this fires at module load: importing the limiter — which
// `server.ts` does, and so does anything that imports it transitively — held
// the Node event loop open, so a CLI or a test that touched it never exited.
// Same defect the connectors' pollers had.
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of store.entries()) {
    if (entry.resetAt < now) store.delete(key);
  }
}, 300_000).unref();
