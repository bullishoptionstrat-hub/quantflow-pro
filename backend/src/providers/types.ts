/**
 * MarketDataProvider — the contract every data source declares.
 *
 * This formalizes the shape the 13 existing connectors ALREADY share
 * (`start*()` / `on*(handler)` / `get*()`), so it is an adapter layer rather
 * than a rewrite of working code.
 *
 * The point is that capabilities are enforced in code, not just documented:
 *   - a provider that is delayed cannot silently be treated as realtime
 *   - a provider that is out of quota degrades to a declared fallback, and the
 *     degradation is stamped on the event rather than hidden
 *   - a rate limit that has never been verified is marked UNVERIFIED and
 *     enforced pessimistically, never optimistically
 */

import type { Provenance, ProviderStatus } from '../config/provenance';

/** What a provider can supply. Closed union — no freeform capability strings. */
export type Capability =
  | 'option_trades'
  | 'option_chain'
  | 'option_quotes'
  | 'equity_quotes'
  | 'equity_trades'
  | 'index_quotes'
  | 'crypto_quotes'
  | 'macro_series'
  | 'news'
  | 'sentiment'
  | 'gex'
  | 'earnings'
  | 'insider_trades'
  | 'volatility_index';

/**
 * Priority band. P0 is live-critical; P5 is background research.
 * When a shared budget tightens, the highest number is shed first.
 */
export type Priority = 0 | 1 | 2 | 3 | 4 | 5;

export const PRIORITY_MEANING: Record<Priority, string> = {
  0: 'live-critical — the flow tape itself',
  1: 'core market context — chains, NBBO',
  2: 'derived analytics — GEX, volatility',
  3: 'macro and index context',
  4: 'news and sentiment',
  5: 'background research and enrichment',
};

/** How confident we are in a declared rate limit. Never optimistic by default. */
export type LimitVerification =
  | { state: 'verified'; source: string; verifiedOn: string }
  | { state: 'unverified'; reason: string };

export interface RateLimit {
  /** null = no documented per-window cap (still subject to the others). */
  requests: number | null;
  windowSeconds: number;
  /** Hard daily ceiling where the provider states one. */
  perDay?: number;
  verification: LimitVerification;
}

/**
 * Latency class. `realtime` is a strong claim and must only be set where the
 * provider genuinely serves realtime data on the FREE tier we actually use.
 */
export type LatencyClass = 'realtime' | 'delayed' | 'end_of_day' | 'periodic';

export interface ProviderCapabilities {
  id: string;
  displayName: string;
  capabilities: readonly Capability[];
  priority: Priority;
  latency: LatencyClass;
  /** Required whenever latency !== 'realtime'. Enforced by validateDescriptor. */
  estimatedDelaySeconds?: number;
  rateLimit: RateLimit;
  authKind: 'none' | 'api_key' | 'bearer' | 'oauth' | 'basic';
  /** Env vars that must ALL be present for this provider to run. */
  requiredEnv: readonly string[];
  /** Terms-of-service constraints a human must respect. Free text by nature. */
  tosNotes?: string;
  docsUrl?: string;
  /**
   * Provider to fall back to when this one is exhausted or down. The fallback's
   * events are stamped with degradation metadata — failover is never silent.
   */
  fallbackProviderId?: string;
  /** True when the free tier does NOT actually serve this data (BLOCKED). */
  blockedOnFreeTier?: boolean;
  blockedReason?: string;
}

export type DescriptorViolation =
  | 'non_realtime_without_delay_estimate'
  | 'realtime_with_delay_estimate'
  | 'blocked_without_reason'
  | 'empty_capabilities'
  | 'self_referential_fallback';

/** Structural validation of a provider declaration. */
export function validateDescriptor(d: ProviderCapabilities): DescriptorViolation[] {
  const out: DescriptorViolation[] = [];
  if (d.latency !== 'realtime' && typeof d.estimatedDelaySeconds !== 'number') {
    out.push('non_realtime_without_delay_estimate');
  }
  if (d.latency === 'realtime' && typeof d.estimatedDelaySeconds === 'number') {
    // A "realtime" provider with a delay estimate is a contradiction — one of
    // the two is a lie, and we refuse to guess which.
    out.push('realtime_with_delay_estimate');
  }
  if (d.blockedOnFreeTier && !d.blockedReason) out.push('blocked_without_reason');
  if (d.capabilities.length === 0) out.push('empty_capabilities');
  if (d.fallbackProviderId === d.id) out.push('self_referential_fallback');
  return out;
}

/**
 * Build the provenance stamp implied by a provider's declared capabilities, so
 * an event's honesty flags derive from the provider contract rather than from
 * whatever each connector author remembered to set.
 */
export function provenanceFromDescriptor(
  d: ProviderCapabilities,
  extra: {
    provider_timestamp?: string | null;
    exchange_timestamp?: string | null;
    provider_status?: ProviderStatus;
    /** Set when this provider is standing in for an exhausted/down primary. */
    degradedFrom?: string;
  } = {},
  now: () => Date = () => new Date(),
): Provenance {
  const ts = now().toISOString();
  const delayed = d.latency !== 'realtime';

  return {
    source: d.id,
    source_type:
      d.authKind === 'oauth' || d.authKind === 'basic' ? 'broker'
      : d.capabilities.includes('macro_series') ? 'aggregator'
      : 'vendor',
    provider_timestamp: extra.provider_timestamp ?? null,
    exchange_timestamp: extra.exchange_timestamp ?? null,
    received_at: ts,
    ingested_at: ts,
    raw_or_derived: 'raw',
    ...(delayed
      ? { is_delayed: true as const, estimated_delay_seconds: d.estimatedDelaySeconds ?? 0 }
      : {}),
    quality_score: qualityScoreFor(d, extra.degradedFrom !== undefined),
    schema_version: 2,
    provider_status: extra.provider_status ?? 'ok',
    ...(extra.degradedFrom
      ? {
          // Failover is recorded on the event itself. A consumer can always see
          // that this value came from a stand-in, not the intended source.
          is_inferred: true as const,
          inference_method: `failover_from:${extra.degradedFrom}`,
          confidence: 0.5,
        }
      : {}),
  };
}

/**
 * Composite input quality, 0–1. Deliberately pessimistic: an unverified rate
 * limit or a degraded failover reduces the score, because both mean we know
 * less about the data than we would like.
 */
export function qualityScoreFor(d: ProviderCapabilities, degraded = false): number {
  let score = 1;
  if (d.latency === 'delayed') score -= 0.2;
  if (d.latency === 'end_of_day') score -= 0.4;
  if (d.latency === 'periodic') score -= 0.3;
  if (d.rateLimit.verification.state === 'unverified') score -= 0.15;
  if (degraded) score -= 0.3;
  return Math.max(0, Math.round(score * 100) / 100);
}

/** Runtime state a provider reports about itself. */
export interface ProviderHealth {
  id: string;
  configured: boolean;
  missingEnv: readonly string[];
  status: ProviderStatus;
  lastError: string | null;
}
