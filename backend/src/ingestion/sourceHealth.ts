/**
 * Per-source health and staleness.
 *
 * The prompt's Wave 1 exit criterion: "health endpoint returns real per-source
 * staleness". Real means measured from actual event arrivals — never a
 * hardcoded 'connected' string, which is what `sources['simulation']='connected'`
 * was (audit #1) and why that lie was possible.
 *
 * A source that has never delivered an event reports `lastEventAt: null` and
 * `status: 'never_reported'`. It is never rendered as healthy by omission.
 */

import { badgeFor, type Provenance, type ProviderStatus } from '../config/provenance';

export type SourceLifecycle =
  | 'never_reported'   // registered but no event has ever arrived
  | 'fresh'            // event within freshness window
  | 'stale'            // last event older than the window
  | 'disabled'         // deliberately off (no credentials, or live mode)
  | 'error';           // last attempt failed

export interface SourceHealth {
  source: string;
  lifecycle: SourceLifecycle;
  lastEventAt: string | null;
  stalenessSeconds: number | null;
  eventCount: number;
  /** Freshness threshold applied to this source, so the number isn't a mystery. */
  freshnessWindowSeconds: number;
  lastBadge: ReturnType<typeof badgeFor> | null;
  providerStatus: ProviderStatus | null;
  lastErrorAt: string | null;
}

/**
 * Different sources have honestly different cadences — a 5/day GEX vendor is
 * not stale at 60s. Defaults are deliberately generous; a source with no entry
 * here uses DEFAULT_FRESHNESS_SECONDS.
 */
const FRESHNESS_SECONDS: Record<string, number> = {
  tradier: 60,
  polygon: 120,
  finnhub: 60,
  simulation: 30,
  seed: 86_400,
  yahoo: 300,
  stooq: 900,
  cboe: 3_600,
  fred: 86_400,
  flashalpha: 86_400,
  reddit: 3_600,
  newsapi: 3_600,
  coingecko: 600,
};

export const DEFAULT_FRESHNESS_SECONDS = 300;

interface SourceRecord {
  lastEventAtMs: number | null;
  eventCount: number;
  lifecycle: SourceLifecycle;
  lastBadge: ReturnType<typeof badgeFor> | null;
  providerStatus: ProviderStatus | null;
  lastErrorAtMs: number | null;
}

const records = new Map<string, SourceRecord>();

function ensure(source: string): SourceRecord {
  let rec = records.get(source);
  if (!rec) {
    rec = {
      lastEventAtMs: null,
      eventCount: 0,
      lifecycle: 'never_reported',
      lastBadge: null,
      providerStatus: null,
      lastErrorAtMs: null,
    };
    records.set(source, rec);
  }
  return rec;
}

/** Declare a source exists before it delivers anything, so silence is visible. */
export function registerSource(source: string, lifecycle: SourceLifecycle = 'never_reported'): void {
  const rec = ensure(source);
  // Never downgrade a source that has already delivered events back to
  // 'never_reported' — that would hide a real outage behind a fresh registration.
  if (rec.eventCount === 0) rec.lifecycle = lifecycle;
  else if (lifecycle === 'disabled' || lifecycle === 'error') rec.lifecycle = lifecycle;
}

export function recordEvent(
  source: string,
  provenance?: Provenance,
  now: () => number = Date.now,
): void {
  const rec = ensure(source);
  rec.lastEventAtMs = now();
  rec.eventCount += 1;
  rec.lifecycle = 'fresh';
  rec.lastBadge = badgeFor(provenance);
  rec.providerStatus = provenance?.provider_status ?? null;
}

export function recordError(source: string, now: () => number = Date.now): void {
  const rec = ensure(source);
  rec.lastErrorAtMs = now();
  rec.lifecycle = 'error';
}

export function recordDisabled(source: string): void {
  ensure(source).lifecycle = 'disabled';
}

export function freshnessWindowFor(source: string): number {
  return FRESHNESS_SECONDS[source] ?? DEFAULT_FRESHNESS_SECONDS;
}

/** Snapshot of every known source, staleness computed at call time. */
export function getSourceHealth(now: () => number = Date.now): SourceHealth[] {
  const t = now();

  return [...records.entries()]
    .map(([source, rec]): SourceHealth => {
      const windowSeconds = freshnessWindowFor(source);
      const stalenessSeconds =
        rec.lastEventAtMs === null ? null : Math.max(0, Math.round((t - rec.lastEventAtMs) / 1000));

      // Staleness is derived at read time, so a source that goes quiet degrades
      // on its own rather than staying 'fresh' because nothing polled it.
      let lifecycle = rec.lifecycle;
      if (
        (lifecycle === 'fresh' || lifecycle === 'stale') &&
        stalenessSeconds !== null &&
        stalenessSeconds > windowSeconds
      ) {
        lifecycle = 'stale';
      }

      return {
        source,
        lifecycle,
        lastEventAt: rec.lastEventAtMs === null ? null : new Date(rec.lastEventAtMs).toISOString(),
        stalenessSeconds,
        eventCount: rec.eventCount,
        freshnessWindowSeconds: windowSeconds,
        lastBadge: rec.lastBadge,
        providerStatus: rec.providerStatus,
        lastErrorAt: rec.lastErrorAtMs === null ? null : new Date(rec.lastErrorAtMs).toISOString(),
      };
    })
    .sort((a, b) => a.source.localeCompare(b.source));
}

/** Overall rollup. `degraded` when any non-disabled source is stale or errored. */
export function getOverallHealth(now: () => number = Date.now): {
  status: 'ok' | 'degraded' | 'no_data';
  sourceCount: number;
  freshCount: number;
} {
  const all = getSourceHealth(now);
  const considered = all.filter((s) => s.lifecycle !== 'disabled');
  const fresh = considered.filter((s) => s.lifecycle === 'fresh');

  if (considered.length === 0) return { status: 'no_data', sourceCount: all.length, freshCount: 0 };
  return {
    status: fresh.length === considered.length ? 'ok' : 'degraded',
    sourceCount: all.length,
    freshCount: fresh.length,
  };
}

/** Test-only reset. */
export function __resetSourceHealth(): void {
  records.clear();
}
