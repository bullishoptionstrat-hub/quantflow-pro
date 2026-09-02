/**
 * Priority-based quota manager.
 *
 * Enforces each provider's DECLARED rate limit in code rather than trusting
 * every call site to be polite. Two behaviors matter most:
 *
 *   1. Exhaustion DEGRADES, it does not crash. A caller gets a typed decision
 *      ('allow' | 'defer' | 'degrade' | 'deny'), never an exception.
 *   2. Failover is VISIBLE. When a request is served by a fallback provider,
 *      the decision names the provider it degraded from, and the resulting
 *      event carries that in its provenance (see provenanceFromDescriptor).
 *
 * Unverified limits are enforced pessimistically — see UNVERIFIED_SAFETY_FACTOR.
 */

import {
  getProvider,
  missingEnvFor,
} from './registry';
import type { Priority, ProviderCapabilities } from './types';

/**
 * We only spend this fraction of an UNVERIFIED limit. If we are not sure what
 * the ceiling is, we must not walk right up to our guess of it.
 */
export const UNVERIFIED_SAFETY_FACTOR = 0.5;

/**
 * Reserve headroom for high-priority work. A P4 caller may not consume the last
 * of a shared budget that a P0 caller might need this window.
 */
export const PRIORITY_RESERVE: Record<Priority, number> = {
  0: 0,     // may use 100% of the budget
  1: 0.05,
  2: 0.15,
  3: 0.25,
  4: 0.4,
  5: 0.5,   // background work stops at half
};

export type QuotaDecision =
  | { action: 'allow'; providerId: string; remaining: number }
  | { action: 'defer'; providerId: string; retryAfterSeconds: number; reason: string }
  | { action: 'degrade'; providerId: string; degradedFrom: string; reason: string }
  | { action: 'deny'; providerId: string; reason: string };

interface Window {
  count: number;
  resetAtMs: number;
}

interface ProviderQuotaState {
  window: Window;
  day: Window;
  consecutiveErrors: number;
  circuitOpenUntilMs: number;
}

const state = new Map<string, ProviderQuotaState>();

/** Open the circuit after this many consecutive failures. */
export const CIRCUIT_ERROR_THRESHOLD = 5;
export const CIRCUIT_COOLDOWN_MS = 60_000;

function ensure(id: string, now: number): ProviderQuotaState {
  let s = state.get(id);
  if (!s) {
    s = {
      window: { count: 0, resetAtMs: now },
      day: { count: 0, resetAtMs: now },
      consecutiveErrors: 0,
      circuitOpenUntilMs: 0,
    };
    state.set(id, s);
  }
  return s;
}

/** Effective per-window budget after the unverified-safety haircut. */
export function effectiveBudget(p: ProviderCapabilities): number | null {
  const raw = p.rateLimit.requests;
  if (raw === null) return null;
  if (p.rateLimit.verification.state === 'verified') return raw;
  return Math.max(1, Math.floor(raw * UNVERIFIED_SAFETY_FACTOR));
}

/** Effective daily ceiling after the same haircut. */
export function effectiveDailyBudget(p: ProviderCapabilities): number | null {
  const raw = p.rateLimit.perDay;
  if (raw === undefined) return null;
  if (p.rateLimit.verification.state === 'verified') return raw;
  return Math.max(1, Math.floor(raw * UNVERIFIED_SAFETY_FACTOR));
}

/**
 * Ask whether a call may proceed.
 *
 * `priority` is the priority of the WORK, which may be lower than the
 * provider's own band (e.g. a background backfill using a P0 provider).
 */
export function requestQuota(
  providerId: string,
  opts: { priority?: Priority; env?: NodeJS.ProcessEnv; now?: () => number } = {},
): QuotaDecision {
  const now = (opts.now ?? Date.now)();
  const env = opts.env ?? process.env;
  const provider = getProvider(providerId);

  if (!provider) {
    return { action: 'deny', providerId, reason: 'unknown_provider' };
  }
  if (provider.blockedOnFreeTier) {
    return {
      action: 'deny',
      providerId,
      reason: `blocked_on_free_tier: ${provider.blockedReason ?? 'no free tier'}`,
    };
  }

  const missing = missingEnvFor(provider, env);
  if (missing.length > 0) {
    return { action: 'deny', providerId, reason: `missing_env: ${missing.join(', ')}` };
  }

  const s = ensure(providerId, now);

  // Circuit breaker — a provider that keeps failing is rested, not hammered.
  if (now < s.circuitOpenUntilMs) {
    return degradeOrDefer(provider, s, now, 'circuit_open');
  }

  // Roll windows.
  if (now >= s.window.resetAtMs) {
    s.window = { count: 0, resetAtMs: now + provider.rateLimit.windowSeconds * 1000 };
  }
  if (now >= s.day.resetAtMs) {
    s.day = { count: 0, resetAtMs: now + 86_400_000 };
  }

  const priority = opts.priority ?? provider.priority;

  // Daily ceiling first — it is the harder wall.
  const dailyBudget = effectiveDailyBudget(provider);
  if (dailyBudget !== null) {
    const reserve = Math.floor(dailyBudget * PRIORITY_RESERVE[priority]);
    if (s.day.count >= dailyBudget - reserve) {
      return degradeOrDefer(provider, s, now, 'daily_quota_exhausted');
    }
  }

  const budget = effectiveBudget(provider);
  if (budget !== null) {
    const reserve = Math.floor(budget * PRIORITY_RESERVE[priority]);
    if (s.window.count >= budget - reserve) {
      return degradeOrDefer(provider, s, now, 'window_quota_exhausted');
    }
  }

  s.window.count += 1;
  s.day.count += 1;

  return {
    action: 'allow',
    providerId,
    remaining: budget === null ? Number.POSITIVE_INFINITY : Math.max(0, budget - s.window.count),
  };
}

/**
 * When exhausted: hand off to the declared fallback if there is a usable one,
 * otherwise tell the caller when to retry. Never throws, never silently drops.
 */
function degradeOrDefer(
  provider: ProviderCapabilities,
  s: ProviderQuotaState,
  now: number,
  reason: string,
): QuotaDecision {
  const fallbackId = provider.fallbackProviderId;
  if (fallbackId) {
    const fallback = getProvider(fallbackId);
    if (fallback && !fallback.blockedOnFreeTier) {
      return {
        action: 'degrade',
        providerId: fallbackId,
        degradedFrom: provider.id,
        reason,
      };
    }
  }
  const retryAfterSeconds = Math.max(
    1,
    Math.ceil((Math.max(s.window.resetAtMs, s.circuitOpenUntilMs) - now) / 1000),
  );
  return { action: 'defer', providerId: provider.id, retryAfterSeconds, reason };
}

/** Report a failed call. Opens the circuit after repeated failures. */
export function reportFailure(providerId: string, now: () => number = Date.now): void {
  const s = ensure(providerId, now());
  s.consecutiveErrors += 1;
  if (s.consecutiveErrors >= CIRCUIT_ERROR_THRESHOLD) {
    s.circuitOpenUntilMs = now() + CIRCUIT_COOLDOWN_MS;
  }
}

/** Report a successful call. Closes the circuit. */
export function reportSuccess(providerId: string, now: () => number = Date.now): void {
  const s = ensure(providerId, now());
  s.consecutiveErrors = 0;
  s.circuitOpenUntilMs = 0;
}

export interface QuotaSnapshot {
  providerId: string;
  windowUsed: number;
  windowBudget: number | null;
  dayUsed: number;
  dayBudget: number | null;
  circuitOpen: boolean;
  limitVerified: boolean;
}

export function quotaSnapshot(now: () => number = Date.now): QuotaSnapshot[] {
  const t = now();
  return [...state.entries()]
    .map(([providerId, s]): QuotaSnapshot => {
      const p = getProvider(providerId);
      return {
        providerId,
        windowUsed: t >= s.window.resetAtMs ? 0 : s.window.count,
        windowBudget: p ? effectiveBudget(p) : null,
        dayUsed: t >= s.day.resetAtMs ? 0 : s.day.count,
        dayBudget: p ? effectiveDailyBudget(p) : null,
        circuitOpen: t < s.circuitOpenUntilMs,
        limitVerified: p?.rateLimit.verification.state === 'verified',
      };
    })
    .sort((a, b) => a.providerId.localeCompare(b.providerId));
}

/** Test-only reset. */
export function __resetQuota(): void {
  state.clear();
}
