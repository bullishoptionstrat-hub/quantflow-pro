/**
 * Strict numeric parsing for provider payloads.
 *
 * ─── WHY THIS IS NOT `parseFloat` OR `Number(x) || 0` ───────────────────────
 *
 * Two defects in this repo came from lenient numeric coercion, and both
 * rendered fabricated numbers in a trading UI:
 *
 *   `?? 0`  (cboe.ts, finding #23) — a caught HTTP 403 became "P/C Ratio 0.00".
 *   `|| 0`  (occ.ts, finding #27)  — worse, because it also collapses a
 *                                    legitimate 0 and NaN into the same value.
 *
 * `parseFloat` adds a third failure mode: it is a PREFIX parser, so
 * `parseFloat('403 Forbidden')` is 403 and `parseFloat('1.2 (est)')` is 1.2 —
 * an error string or an annotated estimate silently becomes a confident
 * reading.
 *
 * The rule this module encodes: **absent data and zero are different facts.**
 * A parse failure yields `null`, and a real zero survives as `0`, so a caller
 * that must distinguish them can, and a caller that forgets gets `null`
 * (which formats as "unavailable") rather than a plausible-looking number.
 */

/**
 * Parse to a finite number, or null. Never zero-on-failure, never a prefix
 * parse, never NaN.
 */
export function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const t = v.trim();
  // Must be numeric in its entirety — no trailing units, notes or status text.
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/**
 * Ratio that is null when it cannot be computed, rather than 0.
 *
 * The specific defect: `vsMonthlyAverage: monthlyAvg > 0 ? vol / monthlyAvg : 0`
 * asserts "today is 0x the trailing average" whenever the average is unknown.
 * Zero is a dramatic claim about market activity; "we don't know" is the truth.
 */
export function ratio(numerator: number | null, denominator: number | null): number | null {
  if (numerator === null || denominator === null) return null;
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator)) return null;
  if (denominator === 0) return null;
  const r = numerator / denominator;
  return Number.isFinite(r) ? r : null;
}
