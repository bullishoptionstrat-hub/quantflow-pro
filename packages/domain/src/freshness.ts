/**
 * THE 200-OK STALE-DATA DEFENSE
 *
 * THE DEFECT THIS EXISTS TO PREVENT
 * ---------------------------------
 * Cboe's legacy put/call CSVs at
 *   cdn.cboe.com/resources/options/volume_and_call_put_ratios/equitypc.csv
 * return **HTTP 200** and parse cleanly — with data that stopped updating on
 * 2019-10-04. A 200 carrying seven-year-old data is more dangerous than a 403,
 * because every naive health check reports the connector as HEALTHY.
 *
 * Therefore: HTTP status is NOT data validity. A source is healthy only if the
 * transport succeeded AND the schema matched AND the effective date is inside
 * the window its own declared cadence implies.
 */
import type { Quality, QualityFlag } from "./quality.js";
import type { Cadence } from "./provenance.js";

export interface FreshnessContract {
  /** How often the provider publishes. Drives the default staleness budget. */
  cadence: Cadence;
  /** Hard ceiling on age of `effectiveAt` before the value is STALE, in ms. */
  maxStalenessMs: number;
  /** Below this row count the payload is PARTIAL regardless of dates. */
  minRowCount: number;
  /** Optional: reject payloads whose effective date is in the future. */
  rejectFutureDates?: boolean;
}

export const DAY_MS = 86_400_000;

/** Sensible defaults per cadence; connectors may override. */
export function defaultContract(cadence: Cadence, minRowCount = 1): FreshnessContract {
  const budget: Record<Cadence, number> = {
    REALTIME: 5 * 60_000,
    DELAYED: 60 * 60_000,
    // Daily regulatory files: allow a long weekend plus a holiday.
    DAILY: 4 * DAY_MS,
    WEEKLY: 21 * DAY_MS,
    AGGREGATED: 35 * DAY_MS,
    HISTORICAL: Number.POSITIVE_INFINITY,
  };
  return { cadence, maxStalenessMs: budget[cadence], minRowCount, rejectFutureDates: true };
}

export interface FreshnessVerdict {
  fresh: boolean;
  ageMs: number;
  stalenessMs: number;
  flags: QualityFlag[];
  reason?: string;
}

/**
 * Evaluate an effective date against a contract.
 * `now` is injectable so tests are deterministic and DST-safe.
 */
export function evaluateFreshness(
  effectiveAt: string | undefined,
  contract: FreshnessContract,
  now: Date = new Date()
): FreshnessVerdict {
  if (!effectiveAt) {
    return {
      fresh: false,
      ageMs: Number.POSITIVE_INFINITY,
      stalenessMs: Number.POSITIVE_INFINITY,
      flags: ["TRADE_DATE_INFERRED", "STALE_SOURCE"],
      reason: "no effective date on payload — cannot establish freshness",
    };
  }

  // DATE-ONLY vs INSTANT.
  // "2026-08-20" parses as midnight UTC. Measuring an intraday budget from
  // midnight makes data published at 16:00 ET today look ~1 day stale — a FALSE
  // STALE that the connector probe surfaced on Cboe and Yahoo. A date-only
  // value only tells us the SESSION, so it must be evaluated at day
  // granularity: age is measured from the END of that session day.
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(effectiveAt.trim());
  if (dateOnly) {
    const effDay = effectiveAt.trim();
    const nowDay = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(now);
    const dayDiff = Math.round(
      (Date.parse(`${nowDay}T00:00:00Z`) - Date.parse(`${effDay}T00:00:00Z`)) / DAY_MS
    );
    if (dayDiff < 0 && contract.rejectFutureDates !== false) {
      return { fresh: false, ageMs: dayDiff * DAY_MS, stalenessMs: 0, flags: ['SCHEMA_DRIFT'],
               reason: `effective date ${effectiveAt} is in the future — clock skew or parse error` };
    }
    // Same session, or within the cadence's day budget (min 1 day of slack so
    // "today" and "yesterday's close" are never spuriously stale).
    const dayBudget = Math.max(1, Math.ceil(contract.maxStalenessMs / DAY_MS));
    if (dayDiff > dayBudget) {
      return {
        fresh: false, ageMs: dayDiff * DAY_MS, stalenessMs: (dayDiff - dayBudget) * DAY_MS,
        flags: ['STALE_SOURCE'],
        reason: `effective date ${effectiveAt} is ${dayDiff}d old; ` +
                `${contract.cadence} budget allows ${dayBudget}d`,
      };
    }
    return { fresh: true, ageMs: Math.max(0, dayDiff) * DAY_MS, stalenessMs: 0, flags: [] };
  }

  const eff = Date.parse(effectiveAt);
  if (Number.isNaN(eff)) {
    return {
      fresh: false,
      ageMs: Number.POSITIVE_INFINITY,
      stalenessMs: Number.POSITIVE_INFINITY,
      flags: ["SCHEMA_DRIFT"],
      reason: `unparseable effective date: ${effectiveAt}`,
    };
  }

  const ageMs = now.getTime() - eff;

  if (ageMs < 0 && contract.rejectFutureDates !== false) {
    return {
      fresh: false,
      ageMs,
      stalenessMs: 0,
      flags: ["SCHEMA_DRIFT"],
      reason: `effective date ${effectiveAt} is in the future — clock skew or parse error`,
    };
  }

  if (ageMs > contract.maxStalenessMs) {
    return {
      fresh: false,
      ageMs,
      stalenessMs: ageMs - contract.maxStalenessMs,
      flags: ["STALE_SOURCE"],
      reason:
        `effective date ${effectiveAt} is ${Math.round(ageMs / DAY_MS)}d old; ` +
        `${contract.cadence} budget allows ${Math.round(contract.maxStalenessMs / DAY_MS)}d`,
    };
  }

  return { fresh: true, ageMs, stalenessMs: 0, flags: [] };
}

export interface PayloadVerdict extends FreshnessVerdict {
  quality: Quality;
}

/** Combined freshness + row-count validation, returning a Quality directly. */
export function validatePayload(
  effectiveAt: string | undefined,
  rowCount: number,
  contract: FreshnessContract,
  now: Date = new Date()
): PayloadVerdict {
  const f = evaluateFreshness(effectiveAt, contract, now);
  const flags: QualityFlag[] = [...f.flags];

  if (rowCount < contract.minRowCount) flags.push("LOW_COVERAGE");

  let state: Quality["state"];
  if (!f.fresh && f.flags.includes("STALE_SOURCE")) state = "STALE";
  else if (!f.fresh) state = "DEGRADED";
  else if (rowCount < contract.minRowCount) state = "PARTIAL";
  else state = "GOOD";

  const reason =
    f.reason ??
    (rowCount < contract.minRowCount
      ? `row count ${rowCount} below minimum ${contract.minRowCount}`
      : undefined);

  return { ...f, flags, quality: { state, flags, note: reason } };
}
