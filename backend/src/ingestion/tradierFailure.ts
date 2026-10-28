/**
 * What kind of failure a Tradier request met, so `/api/health` names the
 * remedy rather than a status code.
 *
 * The case this exists for is an egress proxy. Measured from a sandboxed host
 * on 2026-10-28: a request to api.tradier.com through a proxy that refuses the
 * host reaches axios as **HTTP 403** with a `text/plain` body, "request blocked:
 * no rule or allowlist entry allows host". Tradier documents its own 403 as an
 * entitlement failure, so reading the status alone sends an operator to buy a
 * data plan for a network rule. Neither a 403 nor a 407 is ever read as a bad
 * credential: only 401 is.
 *
 * Tradier's own 401/403 bodies have not been observed here (no production
 * token has been held); the JSON-body test for "the vendor answered" is the
 * same one `entitlement.ts` uses.
 */
export type TradierFailureKind =
  | 'missing_config'
  | 'credentials_rejected'
  | 'not_entitled'
  | 'proxy_refused'
  | 'rate_limited'
  | 'provider_error'
  | 'network'
  | 'unknown';

const PROXY_TEXT = /request blocked|allowlist|proxy|tunnel/i;

export function classifyTradierFailure(err: unknown, tokenSet = true): TradierFailureKind {
  if (!tokenSet) return 'missing_config';
  const e = err as { response?: { status?: number; data?: unknown }; code?: string; message?: string };
  const status = e?.response?.status;
  if (status === undefined) {
    // No response at all. A CONNECT refused by a proxy can also arrive this way.
    if (PROXY_TEXT.test(String(e?.message ?? ''))) return 'proxy_refused';
    return e?.code || e?.message ? 'network' : 'unknown';
  }
  const body = e.response?.data;
  const vendorJson = body !== null && typeof body === 'object';
  if (status === 407) return 'proxy_refused';
  if (status === 403) {
    if (vendorJson) return 'not_entitled';
    return typeof body === 'string' && PROXY_TEXT.test(body) ? 'proxy_refused' : 'unknown';
  }
  if (status === 401) return 'credentials_rejected';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'provider_error';
  return 'unknown';
}

export const TRADIER_FAILURE_REMEDY: Record<TradierFailureKind, string> = {
  missing_config: 'TRADIER_TOKEN is not set',
  credentials_rejected: 'Tradier rejected the token (401): reissue it',
  not_entitled: 'Tradier refused the request (403 with a vendor body): the plan does not cover it',
  proxy_refused: 'an egress proxy refused the connection before Tradier answered: a network rule, not the token',
  rate_limited: 'Tradier rate-limited the request (429)',
  provider_error: 'Tradier returned a server error (5xx)',
  network: 'no response arrived (DNS, timeout or connection reset)',
  unknown: 'unclassified response; see the detail',
};
