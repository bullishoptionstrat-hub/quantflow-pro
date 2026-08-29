/**
 * QuantFlow Pro — data rights registry
 *
 * Every external dataset the backend reads is classified here, per business
 * mode, with the restriction quoted from the publisher's own terms and a link
 * to the page it was read from. The classification is enforced in code rather
 * than described in a document, because a memo does not stop a fetch.
 *
 * Two capabilities are distinguished, and the distinction is the point:
 *
 *   DISPLAY  — read it, show it to the operator, discard it
 *   PERSIST  — write it into the durable signal history
 *
 * They are separate because the risk is separate. Reading a delayed quote page
 * once is a different act from accumulating a database out of it, and a source
 * whose terms we have *not* verified is a much worse basis for a permanent
 * record than for an ephemeral panel. Anything not affirmatively PERMITTED is
 * refused for PERSIST.
 *
 * Fail-closed rules:
 *   - UNVERIFIED is never treated as permitted. Uncertainty resolves to
 *     refusal, not to "probably fine".
 *   - An unknown dataset id is refused, not defaulted.
 *   - `resolveBusinessMode()` rejects a malformed BUSINESS_MODE rather than
 *     degrading to the permissive branch.
 */

// ─── Modes ──────────────────────────────────────────────────────────────────

export type BusinessMode = 'PRIVATE_RESEARCH' | 'PUBLIC_COMMERCIAL';

export const BUSINESS_MODES: readonly BusinessMode[] = [
  'PRIVATE_RESEARCH',
  'PUBLIC_COMMERCIAL',
] as const;

/** The mode used when BUSINESS_MODE is unset. The restrictive one. */
export const DEFAULT_BUSINESS_MODE: BusinessMode = 'PRIVATE_RESEARCH';

export class BusinessModeError extends Error {
  constructor(raw: string) {
    super(
      `BUSINESS_MODE="${raw}" is not a valid mode. ` +
      `Expected one of: ${BUSINESS_MODES.join(', ')}. ` +
      `Refusing to guess — an unrecognised mode is not silently treated as ${DEFAULT_BUSINESS_MODE}.`,
    );
    this.name = 'BusinessModeError';
  }
}

/**
 * Read the mode from the environment.
 *
 * Unset → PRIVATE_RESEARCH. Set but unrecognised → throws. The second half
 * matters: a typo like "PUBLIC" or "public_commercial" must not quietly land
 * on the permissive branch, and it must not quietly land on the restrictive
 * one either, because then the operator believes a setting took effect that
 * did not.
 */
export function resolveBusinessMode(env: NodeJS.ProcessEnv = process.env): BusinessMode {
  const raw = env.BUSINESS_MODE;
  if (raw === undefined || raw.trim() === '') return DEFAULT_BUSINESS_MODE;
  const candidate = raw.trim();
  if ((BUSINESS_MODES as readonly string[]).includes(candidate)) {
    return candidate as BusinessMode;
  }
  throw new BusinessModeError(raw);
}

// ─── Classification ─────────────────────────────────────────────────────────

export type RightsClass =
  /** Terms reviewed and they permit this use. */
  | 'PERMITTED'
  /** Terms reviewed and they forbid this use, or the access method it needs. */
  | 'PROHIBITED'
  /**
   * Terms not established for *this* endpoint. Distinct from PROHIBITED: we
   * are not asserting a restriction, we are recording that we do not know.
   * Treated as refused everywhere a decision is required.
   */
  | 'UNVERIFIED';

export type Capability = 'DISPLAY' | 'PERSIST';

export interface DatasetRights {
  /** Stable id used at every call site. */
  id: string;
  /** Human label for logs and the /api/health surface. */
  label: string;
  /** The host actually contacted by the connector. */
  host: string;
  /** Class per mode, per capability. */
  display: Record<BusinessMode, RightsClass>;
  persist: Record<BusinessMode, RightsClass>;
  /**
   * The publisher's own words, verbatim, where a restriction is asserted.
   * Empty when the class is PERMITTED or when the basis is an absence of
   * terms rather than a quote.
   */
  quotedRestriction?: string;
  /** Where the quote or the permission was read from. */
  termsUrl: string;
  /** When a human last read that page. Stale dates are a finding, not a detail. */
  termsReadAt: string;
  /** Why this classification, in one sentence. Always present. */
  basis: string;
}

/**
 * The registry.
 *
 * A note on the two Cboe entries. The Tier-4 review quoted this, from
 * `cboe.com/delayed_quotes/`:
 *
 *   "IT IS STRICTLY PROHIBITED TO DOWNLOAD DELAYED QUOTE TABLE DATA FROM THIS
 *    WEB SITE BY USING AUTO-EXTRACTION PROGRAMS/QUERIES AND/OR SOFTWARE."
 *
 * The connector does not hit that page. It hits
 * `cdn.cboe.com/api/global/delayed_quotes/options/*.json`, a different host.
 * Whether the quoted prohibition reaches the CDN endpoint is an open question
 * that cannot be closed by reading the page we have. So it is UNVERIFIED, not
 * PROHIBITED — we do not assert a restriction we have not established. It is
 * refused for PERSIST in both modes anyway, because UNVERIFIED is not a basis
 * for a permanent record.
 */
export const DATASETS: readonly DatasetRights[] = [
  {
    id: 'TRADIER_STREAM',
    label: 'Tradier market data stream',
    host: 'api.tradier.com',
    display: { PRIVATE_RESEARCH: 'PERMITTED', PUBLIC_COMMERCIAL: 'UNVERIFIED' },
    persist: { PRIVATE_RESEARCH: 'PERMITTED', PUBLIC_COMMERCIAL: 'UNVERIFIED' },
    termsUrl: 'https://documentation.tradier.com/',
    termsReadAt: '2026-08-29',
    basis:
      'Entitled broker feed consumed under the account holder\'s own agreement. ' +
      'Private research use is covered; external retransmission of OPRA-derived ' +
      'data is a separate agreement we have not established, so commercial is UNVERIFIED.',
  },
  {
    id: 'POLYGON_OPTIONS',
    label: 'Polygon options trades/quotes',
    host: 'api.polygon.io',
    display: { PRIVATE_RESEARCH: 'PERMITTED', PUBLIC_COMMERCIAL: 'UNVERIFIED' },
    persist: { PRIVATE_RESEARCH: 'PERMITTED', PUBLIC_COMMERCIAL: 'UNVERIFIED' },
    termsUrl: 'https://polygon.io/terms',
    termsReadAt: '2026-08-29',
    basis:
      'Licensed API consumed under a paid plan. Redistribution rights depend on ' +
      'the specific plan and are not established here, so commercial is UNVERIFIED.',
  },
  {
    id: 'CBOE_CDN_DELAYED_CHAIN',
    label: 'Cboe delayed options chain (CDN JSON)',
    host: 'cdn.cboe.com',
    display: { PRIVATE_RESEARCH: 'UNVERIFIED', PUBLIC_COMMERCIAL: 'UNVERIFIED' },
    persist: { PRIVATE_RESEARCH: 'UNVERIFIED', PUBLIC_COMMERCIAL: 'UNVERIFIED' },
    quotedRestriction:
      'IT IS STRICTLY PROHIBITED TO DOWNLOAD DELAYED QUOTE TABLE DATA FROM THIS ' +
      'WEB SITE BY USING AUTO-EXTRACTION PROGRAMS/QUERIES AND/OR SOFTWARE. CBOE ' +
      'WILL BLOCK IP ADDRESSES OF ALL PARTIES WHO ATTEMPT TO DO SO.',
    termsUrl: 'https://www.cboe.com/delayed_quotes/',
    termsReadAt: '2026-08-29',
    basis:
      'The quoted prohibition is published on cboe.com/delayed_quotes/. The connector ' +
      'reads cdn.cboe.com, a different host, and whether the prohibition reaches it ' +
      'has not been established. Recorded as unknown rather than asserted either way. ' +
      'Open question: ask Cboe whether the CDN JSON endpoints fall under the ' +
      'delayed-quotes terms, and whether a licensed chain product exists at a ' +
      'self-hosted price point.',
  },
  {
    id: 'OCC_VOLUME_TOTALS',
    label: 'OCC daily volume totals',
    host: 'marketdata.theocc.com',
    display: { PRIVATE_RESEARCH: 'UNVERIFIED', PUBLIC_COMMERCIAL: 'UNVERIFIED' },
    persist: { PRIVATE_RESEARCH: 'UNVERIFIED', PUBLIC_COMMERCIAL: 'UNVERIFIED' },
    quotedRestriction:
      'use or launch any automated system, including "robots", "spiders", or ' +
      '"offline readers"',
    termsUrl: 'https://www.theocc.com/terms-of-use',
    termsReadAt: '2026-08-29',
    basis:
      'OCC terms restrict automated systems. Whether that reaches an internal, ' +
      'non-commercial fetch of a published aggregate is not established. ' +
      'Open question: ask OCC whether internal non-commercial retrieval is permitted.',
  },
  {
    id: 'YAHOO_QUOTES',
    label: 'Yahoo Finance quotes / option chains',
    host: 'query1.finance.yahoo.com',
    display: { PRIVATE_RESEARCH: 'PROHIBITED', PUBLIC_COMMERCIAL: 'PROHIBITED' },
    persist: { PRIVATE_RESEARCH: 'PROHIBITED', PUBLIC_COMMERCIAL: 'PROHIBITED' },
    quotedRestriction:
      'automated access to the service is prohibited, including for private use',
    termsUrl: 'https://legal.yahoo.com/us/en/yahoo/terms/otos/index.html',
    termsReadAt: '2026-08-29',
    basis:
      'The prohibition is written against the access method for any purpose, so ' +
      'private research does not escape it. Refused in both modes and both capabilities.',
  },
  {
    id: 'FINRA_SHORT_VOLUME',
    label: 'FINRA short sale volume files',
    host: 'cdn.finra.org',
    display: { PRIVATE_RESEARCH: 'UNVERIFIED', PUBLIC_COMMERCIAL: 'UNVERIFIED' },
    persist: { PRIVATE_RESEARCH: 'UNVERIFIED', PUBLIC_COMMERCIAL: 'UNVERIFIED' },
    quotedRestriction:
      'data mining, scraping or harvesting tools (including robots)',
    termsUrl: 'https://www.finra.org/terms-and-conditions-use',
    termsReadAt: '2026-08-29',
    basis:
      'FINRA Terms of Use restriction (e) forbids scraping tools; restriction (m) ' +
      'separately forbids use in conjunction with machine learning or predictive ' +
      'analytics. Whether the terms published on finra.org reach the cdn.finra.org ' +
      'file host is not established. Open questions: does (m) prohibit training, ' +
      'inference, or both — and do the terms reach the CDN?',
  },
  {
    id: 'MARKETDATA_APP',
    label: 'MarketData.app options chains',
    host: 'api.marketdata.app',
    display: { PRIVATE_RESEARCH: 'PERMITTED', PUBLIC_COMMERCIAL: 'UNVERIFIED' },
    persist: { PRIVATE_RESEARCH: 'PERMITTED', PUBLIC_COMMERCIAL: 'UNVERIFIED' },
    termsUrl: 'https://www.marketdata.app/terms/',
    termsReadAt: '2026-08-29',
    basis:
      'Licensed API consumed under an account the operator registered for. ' +
      'Redistribution rights are plan-dependent and not established, so commercial ' +
      'is UNVERIFIED.',
  },
  {
    id: 'SCHWAB_API',
    label: 'Schwab Developer market data',
    host: 'api.schwabapi.com',
    display: { PRIVATE_RESEARCH: 'PERMITTED', PUBLIC_COMMERCIAL: 'UNVERIFIED' },
    persist: { PRIVATE_RESEARCH: 'PERMITTED', PUBLIC_COMMERCIAL: 'UNVERIFIED' },
    termsUrl: 'https://developer.schwab.com/termsandconditions',
    termsReadAt: '2026-08-29',
    basis:
      'Broker API consumed under the account holder\'s own agreement. Personal, ' +
      'non-display research use is covered; redistribution is a separate agreement.',
  },
  {
    id: 'TASTYTRADE_API',
    label: 'Tastytrade market data',
    host: 'api.tastytrade.com',
    display: { PRIVATE_RESEARCH: 'PERMITTED', PUBLIC_COMMERCIAL: 'UNVERIFIED' },
    persist: { PRIVATE_RESEARCH: 'PERMITTED', PUBLIC_COMMERCIAL: 'UNVERIFIED' },
    termsUrl: 'https://developer.tastytrade.com/',
    termsReadAt: '2026-08-29',
    basis:
      'Broker API consumed under the account holder\'s own agreement. Same shape as ' +
      'Schwab: personal research covered, redistribution not established.',
  },
  {
    id: 'SIMULATION',
    label: 'Synthetic print generator',
    host: '(local)',
    display: { PRIVATE_RESEARCH: 'PERMITTED', PUBLIC_COMMERCIAL: 'PERMITTED' },
    // Deliberately PERMITTED, not PROHIBITED. Synthetic data raises no rights
    // question at all — it is our own output. It is kept out of the research
    // record by the synthetic policy in `persistence/`, which is a *research
    // validity* control, not a rights one. Conflating the two would make the
    // rights layer mean two different things.
    persist: { PRIVATE_RESEARCH: 'PERMITTED', PUBLIC_COMMERCIAL: 'PERMITTED' },
    termsUrl: '(none — locally generated)',
    termsReadAt: '2026-08-29',
    basis:
      'Locally generated data. No third-party rights attach. Excluded from the ' +
      'track record by the synthetic policy, which is a separate control.',
  },
] as const;

const BY_ID = new Map<string, DatasetRights>(DATASETS.map((d) => [d.id, d]));

/**
 * Connector `source` strings, as they appear on a RawPrint, mapped to dataset
 * ids. A source with no mapping is unknown to the registry and is refused for
 * PERSIST by `classify`.
 */
const SOURCE_TO_DATASET: Readonly<Record<string, string>> = {
  tradier: 'TRADIER_STREAM',
  polygon: 'POLYGON_OPTIONS',
  cboe: 'CBOE_CDN_DELAYED_CHAIN',
  cboe_options: 'CBOE_CDN_DELAYED_CHAIN',
  cboeOptions: 'CBOE_CDN_DELAYED_CHAIN',
  occ: 'OCC_VOLUME_TOTALS',
  yahoo: 'YAHOO_QUOTES',
  finra: 'FINRA_SHORT_VOLUME',
  marketdata: 'MARKETDATA_APP',
  schwab: 'SCHWAB_API',
  tastytrade: 'TASTYTRADE_API',
  simulation: 'SIMULATION',
  // `seed` is the same generator as `simulation`, backdated to populate the
  // ring buffer at boot. `finnhub` streams EQUITY trades, not options tape, so
  // its option "prints" are produced by `simulatePrints` from a real spot
  // price — the emitted print is our own construction, not Finnhub's data, and
  // it is flagged synthetic. Both are therefore the simulator, not a vendor
  // dataset, and classifying them anywhere else would misattribute output we
  // generated to a third party.
  seed: 'SIMULATION',
  finnhub: 'SIMULATION',
};

export function datasetIdForSource(source: string): string | undefined {
  return SOURCE_TO_DATASET[source];
}

export function getDataset(id: string): DatasetRights | undefined {
  return BY_ID.get(id);
}

export function listDatasets(): readonly DatasetRights[] {
  return DATASETS;
}

// ─── Decisions ──────────────────────────────────────────────────────────────

export interface RightsDecision {
  allowed: boolean;
  datasetId: string;
  capability: Capability;
  mode: BusinessMode;
  rightsClass: RightsClass | 'UNKNOWN_DATASET';
  /** Operator-facing explanation. Quotes the terms when there are terms. */
  reason: string;
}

/**
 * Classify one (dataset, capability, mode) triple without throwing.
 *
 * Use this where a refusal is a normal outcome to be labelled and reported —
 * the health endpoint, the persistence path's skip counter. Use `assertRights`
 * where a refusal should stop the call.
 */
export function classify(
  datasetId: string,
  capability: Capability,
  mode: BusinessMode = resolveBusinessMode(),
): RightsDecision {
  const ds = BY_ID.get(datasetId);
  if (!ds) {
    return {
      allowed: false,
      datasetId,
      capability,
      mode,
      rightsClass: 'UNKNOWN_DATASET',
      reason:
        `Dataset "${datasetId}" is not in the rights registry. An unregistered ` +
        `source is refused rather than defaulted — add it to DATASETS with its ` +
        `terms before using it.`,
    };
  }

  const cls = capability === 'DISPLAY' ? ds.display[mode] : ds.persist[mode];
  if (cls === 'PERMITTED') {
    return {
      allowed: true, datasetId, capability, mode, rightsClass: cls,
      reason: `${ds.label}: permitted for ${capability} in ${mode}. ${ds.basis}`,
    };
  }

  const quote = ds.quotedRestriction
    ? ` Publisher's terms state: "${ds.quotedRestriction}"`
    : '';

  return {
    allowed: false,
    datasetId,
    capability,
    mode,
    rightsClass: cls,
    reason:
      cls === 'PROHIBITED'
        ? `${ds.label}: ${capability} is prohibited in ${mode}.${quote} ` +
          `Terms: ${ds.termsUrl} (read ${ds.termsReadAt}). ${ds.basis}`
        : `${ds.label}: rights for ${capability} in ${mode} are UNVERIFIED, which ` +
          `is refused — uncertainty resolves to refusal, not to permission.${quote} ` +
          `Terms: ${ds.termsUrl} (read ${ds.termsReadAt}). ${ds.basis}`,
  };
}

export class RightsViolationError extends Error {
  readonly decision: RightsDecision;
  constructor(decision: RightsDecision) {
    super(decision.reason);
    this.name = 'RightsViolationError';
    this.decision = decision;
  }
}

/** Throwing form of `classify`. The message carries the quoted restriction. */
export function assertRights(
  datasetId: string,
  capability: Capability,
  mode: BusinessMode = resolveBusinessMode(),
): void {
  const d = classify(datasetId, capability, mode);
  if (!d.allowed) throw new RightsViolationError(d);
}

/** Convenience for the ingestion path, which knows a connector name. */
export function classifySource(
  source: string,
  capability: Capability,
  mode: BusinessMode = resolveBusinessMode(),
): RightsDecision {
  const id = datasetIdForSource(source);
  if (!id) {
    return {
      allowed: false,
      datasetId: `source:${source}`,
      capability,
      mode,
      rightsClass: 'UNKNOWN_DATASET',
      reason:
        `Connector source "${source}" has no entry in SOURCE_TO_DATASET, so its ` +
        `rights are unknown and ${capability} is refused. Map it to a dataset in ` +
        `provenance/rights.ts before using it.`,
    };
  }
  return classify(id, capability, mode);
}

/**
 * Snapshot for /api/health. Reports what the running process will actually do,
 * so the operator can see the mode in force and every refusal it implies
 * without reading the code.
 */
export function rightsSnapshot(mode: BusinessMode = resolveBusinessMode()) {
  return {
    mode,
    default: DEFAULT_BUSINESS_MODE,
    datasets: DATASETS.map((d) => ({
      id: d.id,
      label: d.label,
      host: d.host,
      display: d.display[mode],
      persist: d.persist[mode],
      termsUrl: d.termsUrl,
      termsReadAt: d.termsReadAt,
      ...(d.quotedRestriction ? { quotedRestriction: d.quotedRestriction } : {}),
    })),
  };
}
