/**
 * A number the vendor actually sent, or null.
 *
 * This is the field-granularity half of the rule `deadSources.test.ts` closed
 * at response granularity: a field the vendor did not send is not a zero. The
 * coercion is what hides the difference — `parseFloat(undefined ?? 0)` is `0`,
 * not `NaN`, and `Number(null)` is `0` — so an absent field arrives looking
 * exactly like a real reading of zero, and nothing downstream can tell them
 * apart.
 *
 * Two functions rather than one, because accepting a numeric string is a
 * decision about a vendor's schema and not a detail. `num` is for a vendor
 * documented to send JSON numbers, where a string is a surprise worth
 * refusing; `numeric` is for one that sends its numbers as strings (Cboe,
 * Tastytrade). Collapsing them into a single permissive helper would silently
 * widen what three connectors accept.
 *
 * Lived in four connectors as three hand-rolled copies before it lived here.
 */

/** A finite JSON number, or null. A string is refused. */
export function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** A finite number, parsed from a number or a numeric string, or null. */
export function numeric(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

/** `null` as `undefined` — for a wire field that must be absent, not zero. */
export function orUndefined(v: number | null): number | undefined {
  return v === null ? undefined : v;
}
