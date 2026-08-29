import { Request, Response, NextFunction } from 'express';

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

// In-memory rate limiter (replace with Upstash Redis in production)
const store = new Map<string, RateLimitEntry>();

function getKey(req: Request): string {
  return (
    (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
    req.socket.remoteAddress ||
    'unknown'
  );
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

// Clean up stale entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of store.entries()) {
    if (entry.resetAt < now) store.delete(key);
  }
}, 300_000);
