/**
 * QuantFlow Pro — web enrichment seam
 *
 * Wraps the vendored Firecrawl module (`./firecrawl/`) for the backend. The
 * module supplies transport, schema validation and typed errors; what is added
 * here is everything that depends on *this* service's constraints:
 *
 *   - **Demand-driven, never scheduled.** Every other connector polls because it
 *     feeds the tape. Firecrawl feeds a context panel, and its calls cost metered
 *     credits, so a fetch happens only when a request asks for one. The module's
 *     own cache (15m news / 6h documents) is what keeps a busy page from turning
 *     into a credit burn — no interval, so there is no background spend at all.
 *
 *   - **Latched fail-closed.** `AUTH` and `INSUFFICIENT_CREDITS` do not resolve
 *     on their own: a revoked key stays revoked and an exhausted plan stays
 *     exhausted until the billing cycle rolls or someone changes the env. Once
 *     either is seen, every later call short-circuits without touching the
 *     network until the process restarts. This is the same reasoning that stops
 *     the Tradier reconnect loop on a token the probe has proven dead.
 *
 *   - **The context-only contract travels with the data.** Firecrawl news is a
 *     context layer and must never be read as a trade trigger. The module states
 *     that in its docs; docs do not reach an API client, so `context_only` and
 *     `disclaimer` ride on the response itself — the same way `synthetic` and
 *     `side: AMBIGUOUS` carry their contracts onto the flow wire.
 */
import {
  EnrichmentService,
  FirecrawlClient,
  FirecrawlError,
  type FirecrawlErrorCode,
  type NewsContextItem,
} from './firecrawl/index';

export type EnrichmentState = 'connected' | 'disabled' | 'error';

/**
 * The contract, verbatim, on every payload this module produces. Firecrawl
 * results describe what has already been written about a name; they are not
 * evidence about where it goes next.
 */
export const CONTEXT_ONLY_DISCLAIMER =
  'Context layer only — never a trade trigger. Bias is earned exclusively through price confirmation.';

/** Error codes that no retry can clear. Seeing one latches the service off. */
const TERMINAL_CODES: ReadonlySet<FirecrawlErrorCode> = new Set<FirecrawlErrorCode>([
  'AUTH',
  'INSUFFICIENT_CREDITS',
]);

let service: EnrichmentService | null = null;
let state: EnrichmentState = 'disabled';
let stateReason = 'FIRECRAWL_API_KEY is not set — web enrichment is off';
/** Latched: set once a terminal error is seen, cleared only by a restart. */
let latchedOff = false;

/**
 * Build the client if a key is configured. Safe to call more than once and safe
 * to call with no key — a missing key is a configuration choice, not a failure,
 * and reports as `disabled` exactly like every other keyless connector.
 */
export function startEnrichment(): void {
  if (!process.env.FIRECRAWL_API_KEY) {
    state = 'disabled';
    stateReason = 'FIRECRAWL_API_KEY is not set — web enrichment is off';
    return;
  }
  try {
    service = new EnrichmentService(FirecrawlClient.fromEnv());
    state = 'connected';
    stateReason = 'configured; fetches on demand only';
    latchedOff = false;
  } catch (err) {
    // The only throw here is a malformed key (the module requires an `fc-`
    // prefix). That is terminal in the same way a revoked key is.
    service = null;
    state = 'error';
    stateReason = err instanceof FirecrawlError
      ? `${err.code}: ${err.message}`
      : String(err);
    latchedOff = true;
  }
}

export interface EnrichmentStatus {
  state: EnrichmentState;
  reason: string;
  /** True once a terminal error latched the service off until restart. */
  latchedOff: boolean;
}

export function getEnrichmentStatus(): EnrichmentStatus {
  return { state, reason: stateReason, latchedOff };
}

/** Thrown to the route layer with enough detail to render a reason to a user. */
export class EnrichmentUnavailable extends Error {
  constructor(
    readonly reason: string,
    /** 503 for "not configured / latched off", 502 for a live upstream failure. */
    readonly httpStatus: 502 | 503,
    readonly code?: FirecrawlErrorCode,
  ) {
    super(reason);
    this.name = 'EnrichmentUnavailable';
  }
}

function assertUsable(): EnrichmentService {
  if (state === 'disabled') {
    throw new EnrichmentUnavailable(stateReason, 503);
  }
  if (latchedOff || !service) {
    throw new EnrichmentUnavailable(
      `${stateReason} — enrichment is latched off until the service restarts`,
      503,
    );
  }
  return service;
}

/**
 * Record a failure against the service and translate it for the route layer.
 * Terminal codes latch; transient ones leave the service usable so the next
 * request can try again.
 */
function recordFailure(err: unknown): never {
  if (err instanceof FirecrawlError) {
    state = 'error';
    stateReason = `${err.code}: ${err.message}`;
    if (TERMINAL_CODES.has(err.code)) {
      latchedOff = true;
      throw new EnrichmentUnavailable(stateReason, 503, err.code);
    }
    throw new EnrichmentUnavailable(stateReason, 502, err.code);
  }
  state = 'error';
  stateReason = err instanceof Error ? err.message : String(err);
  throw new EnrichmentUnavailable(stateReason, 502);
}

export interface NewsContextResult {
  query: string;
  items: NewsContextItem[];
  /** Always true. Machine-readable half of the contract above. */
  context_only: true;
  disclaimer: string;
  fetchedAt: string;
}

/**
 * Recent news context for a symbol or theme. One search per uncached call.
 */
export async function fetchNewsContext(query: string, limit = 5): Promise<NewsContextResult> {
  const svc = assertUsable();
  try {
    const items = await svc.fetchNewsContext(query, limit);
    // A successful call clears a previous transient failure.
    state = 'connected';
    stateReason = 'configured; fetches on demand only';
    return {
      query,
      items,
      context_only: true,
      disclaimer: CONTEXT_ONLY_DISCLAIMER,
      fetchedAt: new Date().toISOString(),
    };
  } catch (err) {
    recordFailure(err);
  }
}

/**
 * Fetch a regulatory notice as markdown, with sha256 change detection so a
 * caller that already holds `previousHash` can skip reprocessing.
 */
export async function fetchRegulatoryNotice(url: string, previousHash?: string) {
  const svc = assertUsable();
  try {
    const { doc, changed } = await svc.fetchFinraNotice(url, previousHash);
    state = 'connected';
    stateReason = 'configured; fetches on demand only';
    return { doc, changed, context_only: true as const, disclaimer: CONTEXT_ONLY_DISCLAIMER };
  } catch (err) {
    recordFailure(err);
  }
}
