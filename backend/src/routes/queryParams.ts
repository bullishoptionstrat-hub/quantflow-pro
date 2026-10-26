/**
 * Reading query parameters the caller controls.
 *
 * Routes used `parseInt(req.query.limit as string) || 50` and
 * `(req.query.symbol as string)?.toUpperCase()`. Two things went wrong:
 *
 *   - `?limit=-5` parses to -5, which is truthy and below the cap, so
 *     `slice(0, -5)` returned every row but the last five: past the 200/500
 *     cap, with a negative page count beside it.
 *   - `?symbol=A&symbol=B` arrives from Express as an array, and
 *     `.toUpperCase()` on an array throws, so the route answered 500.
 *
 * A parameter that is absent, repeated or unreadable takes the route's
 * default; a number is clamped into the route's range.
 */
export function queryString(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

export function queryInt(v: unknown, fallback: number, min: number, max: number): number {
  const s = queryString(v);
  const n = s === undefined ? Number.NaN : Number(s);
  if (!Number.isInteger(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

/** A non-negative number, or the fallback; for thresholds like `minPremium`. */
export function queryNonNegative(v: unknown, fallback: number): number {
  const s = queryString(v);
  const n = s === undefined ? Number.NaN : Number(s);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}
