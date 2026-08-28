/**
 * Alert dedup, cooldown and severity.
 *
 * The failure mode this prevents: a single underlying event (one sweep, one
 * provider outage) firing dozens of notifications, training users to ignore
 * all of them. An alert system that cries wolf is worse than none.
 *
 * Three independent limits, all enforced:
 *   1. DEDUP     — identical alerts inside a window collapse into one.
 *   2. COOLDOWN  — per dedup key, a minimum gap between deliveries.
 *   3. RATE CAP  — a global ceiling per window, shedding lowest severity first.
 *
 * Suppressed alerts are COUNTED, not discarded silently: the next delivered
 * alert reports how many were folded into it.
 */

export type Severity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO';

/** Ordered most severe first — index doubles as the shed order. */
export const SEVERITY_ORDER: readonly Severity[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'];

export function severityRank(s: Severity): number {
  return SEVERITY_ORDER.indexOf(s);
}

export interface AlertInput {
  /** Stable identity of WHAT is being alerted about. Alerts sharing this key dedup. */
  dedupKey: string;
  severity: Severity;
  symbol?: string;
  message: string;
  /** Epoch ms. */
  at: number;
  /** Synthetic alerts must be visibly synthetic downstream. */
  isSynthetic?: boolean;
}

export type SuppressionReason = 'duplicate_in_window' | 'cooldown_active' | 'rate_cap_exceeded';

export type AlertDecision =
  | { action: 'deliver'; alert: AlertInput; suppressedSinceLast: number }
  | { action: 'suppress'; reason: SuppressionReason; dedupKey: string; nextEligibleAt: number };

export interface AlertPolicy {
  /** Identical alerts within this window collapse. */
  dedupWindowMs: number;
  /** Minimum gap between deliveries for the same key, by severity. */
  cooldownMsBySeverity: Record<Severity, number>;
  /** Max delivered alerts per rate window, across all keys. */
  maxPerWindow: number;
  rateWindowMs: number;
}

export const DEFAULT_POLICY: AlertPolicy = {
  dedupWindowMs: 60_000,
  cooldownMsBySeverity: {
    // A critical alert may repeat sooner — but still not unboundedly.
    CRITICAL: 60_000,
    HIGH: 300_000,
    MEDIUM: 900_000,
    LOW: 3_600_000,
    INFO: 3_600_000,
  },
  maxPerWindow: 20,
  rateWindowMs: 60_000,
};

interface KeyState {
  lastDeliveredAt: number;
  lastSeverity: Severity;
  suppressedSinceLast: number;
}

export class AlertGate {
  private keys = new Map<string, KeyState>();
  private delivered: Array<{ at: number; severity: Severity }> = [];

  constructor(private policy: AlertPolicy = DEFAULT_POLICY) {}

  /** Decide whether an alert is delivered. Never throws. */
  consider(alert: AlertInput): AlertDecision {
    const state = this.keys.get(alert.dedupKey);

    // Trim the rate window before counting.
    this.delivered = this.delivered.filter((d) => alert.at - d.at < this.policy.rateWindowMs);

    if (state) {
      const sinceLast = alert.at - state.lastDeliveredAt;

      if (sinceLast < this.policy.dedupWindowMs) {
        state.suppressedSinceLast += 1;
        return {
          action: 'suppress',
          reason: 'duplicate_in_window',
          dedupKey: alert.dedupKey,
          nextEligibleAt: state.lastDeliveredAt + this.policy.dedupWindowMs,
        };
      }

      const cooldown = this.policy.cooldownMsBySeverity[alert.severity];
      // An ESCALATION breaks cooldown: a MEDIUM becoming CRITICAL is new
      // information, and holding it back would be the dangerous kind of quiet.
      const escalated = severityRank(alert.severity) < severityRank(state.lastSeverity);
      if (sinceLast < cooldown && !escalated) {
        state.suppressedSinceLast += 1;
        return {
          action: 'suppress',
          reason: 'cooldown_active',
          dedupKey: alert.dedupKey,
          nextEligibleAt: state.lastDeliveredAt + cooldown,
        };
      }
    }

    // Global rate cap — shed the least severe first.
    if (this.delivered.length >= this.policy.maxPerWindow) {
      const leastSevere = this.delivered.reduce((worst, d) =>
        severityRank(d.severity) > severityRank(worst.severity) ? d : worst,
      );
      // Only displace something strictly less severe than this alert.
      if (severityRank(alert.severity) >= severityRank(leastSevere.severity)) {
        const s = this.keys.get(alert.dedupKey);
        if (s) s.suppressedSinceLast += 1;
        return {
          action: 'suppress',
          reason: 'rate_cap_exceeded',
          dedupKey: alert.dedupKey,
          nextEligibleAt: (this.delivered[0]?.at ?? alert.at) + this.policy.rateWindowMs,
        };
      }
      // Displace the least severe delivered alert to make room.
      this.delivered.splice(this.delivered.indexOf(leastSevere), 1);
    }

    const suppressedSinceLast = state?.suppressedSinceLast ?? 0;
    this.keys.set(alert.dedupKey, {
      lastDeliveredAt: alert.at,
      lastSeverity: alert.severity,
      suppressedSinceLast: 0,
    });
    this.delivered.push({ at: alert.at, severity: alert.severity });

    return { action: 'deliver', alert, suppressedSinceLast };
  }

  /** How many alerts were folded into the next delivery for this key. */
  suppressedCount(dedupKey: string): number {
    return this.keys.get(dedupKey)?.suppressedSinceLast ?? 0;
  }

  reset(): void {
    this.keys.clear();
    this.delivered = [];
  }
}

/**
 * Build a stable dedup key. Deliberately excludes timestamps and ids, so the
 * SAME condition produces the SAME key and therefore dedups.
 */
export function dedupKeyFor(parts: {
  kind: string;
  symbol?: string;
  strike?: number;
  expiry?: string;
  source?: string;
}): string {
  return [parts.kind, parts.symbol ?? '', parts.strike ?? '', parts.expiry ?? '', parts.source ?? '']
    .join('|');
}
