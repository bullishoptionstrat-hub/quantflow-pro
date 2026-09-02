/**
 * PROVENANCE KERNEL
 *
 * Every dataset that reaches a user carries one of these. Not a comment, not a
 * README line — a required field on the value itself, so it cannot be dropped
 * without a type error.
 *
 * The distinction that matters most here is the three timestamps. A regulatory
 * dataset has a trade date (when the activity happened), a publication time
 * (when the regulator released it), and a fetch time (when we pulled it).
 * Research that uses `effectiveAt` as if it were `availableAt` commits
 * publication-lag lookahead: a FINRA file describing Friday's trading is not
 * knowable Friday morning. See pointInTime.ts.
 */

export type Cadence =
  | "REALTIME"
  | "DELAYED"
  | "DAILY"
  | "WEEKLY"
  | "HISTORICAL"
  | "AGGREGATED";

export interface Provenance {
  /** Organization that published the data. e.g. "FINRA", "OCC", "Cboe". */
  provider: string;
  /** Specific dataset within that provider. e.g. "CNMS daily short volume". */
  dataset: string;
  sourceUrl?: string;

  /** When the underlying market activity occurred (trade date / session). */
  effectiveAt?: string;
  /** When the provider made it publicly retrievable. Governs point-in-time. */
  availableAt?: string;
  /** When our process actually retrieved it. */
  fetchedAt: string;
  /** When the observation itself was timestamped by the source, if it carries one. */
  observedAt?: string;

  cadence: Cadence;

  /** One-line description of how a derived value was computed. */
  methodology?: string;
  /** Everything a careful reader must know before trusting the number. */
  caveats: string[];

  /** Bumped whenever parse or compute semantics change. Enables replay fidelity. */
  parserVersion: string;

  /** TRUE when the value approximates a proprietary or unpublished construct. */
  approximation?: boolean;
}

export function makeProvenance(p: Omit<Provenance, "fetchedAt"> & { fetchedAt?: string }): Provenance {
  return { ...p, fetchedAt: p.fetchedAt ?? new Date().toISOString() };
}
