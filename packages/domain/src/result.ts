/**
 * DATA RESULT — the zero-sentinel killer.
 *
 * THE DEFECT THIS EXISTS TO PREVENT
 * ---------------------------------
 * The Cboe put/call connector did this:
 *
 *     try { ...fetch... } catch { return {}; }
 *     ...
 *     putCallRatioTotal: parseFloat(today.equity_put_call_ratio ?? 0)
 *
 * The endpoint returns HTTP 403. The catch swallowed it. The `?? 0` turned
 * "we have no idea" into "the put/call ratio is 0.00" — a real, plottable,
 * completely fabricated number, rendered in a trading UI with no warning.
 *
 * In financial infrastructure, absent data and zero are different facts. This
 * type makes them different *types*, so the compiler stops you conflating them.
 *
 * USAGE RULE: a connector returns DataResult. It never returns a bare number
 * that might be a sentinel. Callers must narrow on `status` before reading
 * `value`, which means the "forgot to handle failure" path does not compile.
 */
import type { Provenance } from "./provenance.js";
import type { Quality } from "./quality.js";

export type DataResult<T> =
  | {
      status: "OK";
      value: T;
      provenance: Provenance;
      quality: Quality;
    }
  | {
      status: "STALE";
      /** Last known value, if we have one. Absent when we never had one. */
      value?: T;
      provenance: Provenance;
      quality: Quality;
      /** How stale, in milliseconds past the acceptable window. */
      stalenessMs: number;
      reason: string;
    }
  | {
      status: "UNAVAILABLE";
      reason: string;
      provenance?: Provenance;
      quality?: Quality;
    };

export function ok<T>(value: T, provenance: Provenance, quality: Quality): DataResult<T> {
  return { status: "OK", value, provenance, quality };
}

export function stale<T>(
  provenance: Provenance,
  quality: Quality,
  stalenessMs: number,
  reason: string,
  value?: T
): DataResult<T> {
  return { status: "STALE", value, provenance, quality, stalenessMs, reason };
}

export function unavailable<T>(
  reason: string,
  provenance?: Provenance,
  quality?: Quality
): DataResult<T> {
  return { status: "UNAVAILABLE", reason, provenance, quality };
}

export function isOk<T>(r: DataResult<T>): r is Extract<DataResult<T>, { status: "OK" }> {
  return r.status === "OK";
}

/**
 * Read a value or get undefined — NEVER a zero default.
 *
 * There is deliberately no `unwrapOr(result, 0)` helper in this module. If a
 * caller genuinely wants a numeric default they must write it at the call site
 * where a reviewer can see it, rather than reaching for a convenience function
 * that reintroduces exactly the defect this file exists to prevent.
 */
export function valueOrUndefined<T>(r: DataResult<T>): T | undefined {
  if (r.status === "OK") return r.value;
  if (r.status === "STALE") return r.value;
  return undefined;
}

/** Serializable shape for API responses — status is always explicit to clients. */
export function toWire<T>(r: DataResult<T>): Record<string, unknown> {
  if (r.status === "OK") {
    return { status: r.status, value: r.value, provenance: r.provenance, quality: r.quality };
  }
  if (r.status === "STALE") {
    return {
      status: r.status,
      value: r.value ?? null,
      provenance: r.provenance,
      quality: r.quality,
      stalenessMs: r.stalenessMs,
      reason: r.reason,
    };
  }
  return {
    status: r.status,
    value: null,
    reason: r.reason,
    provenance: r.provenance ?? null,
    quality: r.quality ?? null,
  };
}
