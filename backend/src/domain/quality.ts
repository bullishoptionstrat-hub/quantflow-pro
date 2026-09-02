// AUTO-GENERATED — DO NOT EDIT.
// Vendored from @quantflow/domain (packages/domain/src/quality.ts) by scripts/sync-vendored.mjs.
// Edit the canonical source and re-run the script; backend/test/vendorDrift.test.ts
// fails if this copy drifts.
/**
 * DATA QUALITY KERNEL
 *
 * One taxonomy for the whole platform. Connectors do NOT invent their own flag
 * strings — Tier-2 started doing exactly that (HIGH_MISSING_*, LOW_COVERAGE_*)
 * and it was already diverging per file.
 */

export type QualityState =
  | "GOOD"
  | "DEGRADED"
  | "STALE"
  | "PARTIAL"
  | "UNAVAILABLE"
  | "QUARANTINED";

export const QUALITY_FLAGS = [
  "LOW_COVERAGE",
  "STALE_SOURCE",
  "SCHEMA_DRIFT",
  "HIGH_REJECT_COUNT",
  "PRICE_LOOKUP_MISSING",
  "TRADE_DATE_INFERRED",
  "ADJUSTED_SERIES_EXCLUDED",
  "SOURCE_DISAGREEMENT",
  "QUOTE_STALE",
  "HISTORICAL_WEIGHTS_APPROXIMATED",
  "CURRENT_CONSTITUENT_BACKFILL",
  "PUBLICATION_LAG_UNKNOWN",
  "INSUFFICIENT_SAMPLE",
  "SYNTHETIC_DATA",
  "FALLBACK_SOURCE_USED",
] as const;

export type QualityFlag = (typeof QUALITY_FLAGS)[number];

export interface Quality {
  state: QualityState;
  flags: QualityFlag[];
  /** Human-readable reason, required whenever state is not GOOD. */
  note?: string;
}

export function good(flags: QualityFlag[] = []): Quality {
  return { state: flags.length === 0 ? "GOOD" : "DEGRADED", flags };
}

export function quality(state: QualityState, flags: QualityFlag[], note?: string): Quality {
  return { state, flags, note };
}

/** Worst-of combination — used when an analytic depends on several inputs. */
const SEVERITY: Record<QualityState, number> = {
  GOOD: 0,
  DEGRADED: 1,
  PARTIAL: 2,
  STALE: 3,
  QUARANTINED: 4,
  UNAVAILABLE: 5,
};

export function combineQuality(parts: Quality[]): Quality {
  if (parts.length === 0) return { state: "UNAVAILABLE", flags: [], note: "no inputs" };
  let worst = parts[0];
  for (const p of parts) if (SEVERITY[p.state] > SEVERITY[worst.state]) worst = p;
  const flags = [...new Set(parts.flatMap((p) => p.flags))];
  return { state: worst.state, flags, note: worst.note };
}
