/**
 * What a provider's raw transaction code MEANS — and how sure we are.
 *
 * This table is data, not logic, because every row of it is a claim about a
 * document someone else publishes, and those claims have different standing.
 * The reducer in `eventLog.ts` acts on these mappings; every view it produces
 * reports the WEAKEST status among the rows it actually used, the same
 * weakest-class rule `rights_display` applies to datasets. A corrected tape
 * built on an unverified reading of "CNCL" says so on its face.
 *
 * **Nothing in this table is PRIMARY_VERIFIED, and that is the finding.** On
 * 2026-09-27 every primary source — the OPRA document library and CDN, the
 * webflow-hosted OPRA specification PDFs, Cboe, the Federal Register, SEC —
 * was refused by this environment's egress gateway (HTTP 403 on CONNECT). The
 * rows below come from two weaker places, and each row says which:
 *
 *   - SEARCH_ONLY: a search engine surfaced a fragment of the definition's
 *     wording from an OPRA specification. The fragment is quoted exactly as
 *     surfaced, truncation included. Even then the *association* between the
 *     fragment and the four-letter code was not surfaced — it is recalled — so
 *     those rows are still UNVERIFIED as mappings, with the fragment recorded
 *     as corroboration that such a definition exists.
 *   - UNVERIFIED: recalled from general knowledge of the OPRA Last Sale message
 *     types, or supplied by the operator's audit. Nothing was read.
 *
 * The practical consequence is deliberate: `research/` gates refuse to treat a
 * dataset as analysis-ready while any code it contains maps through a row
 * below PRIMARY_VERIFIED. The architecture is built now; the semantics are
 * upgraded by reading the specification, row by row, not by editing a status.
 */

/** How a technical or legal fact was established. Ordered weakest → strongest. */
export type SourceStatus =
  /** Recalled, or taken from someone's summary. Nothing was read. */
  | 'UNVERIFIED'
  /** Text surfaced by a search engine; the document itself was not read. */
  | 'SEARCH_ONLY'
  /** Read in a data vendor's own documentation, not the market's. */
  | 'PROVIDER_VERIFIED'
  /** Read in the primary document; text quoted; URL and read date recorded. */
  | 'PRIMARY_VERIFIED';

const STATUS_RANK: Record<SourceStatus, number> = {
  UNVERIFIED: 0,
  SEARCH_ONLY: 1,
  PROVIDER_VERIFIED: 2,
  PRIMARY_VERIFIED: 3,
};

/** The weakest of several statuses. An empty set is UNVERIFIED, never strong. */
export function weakestStatus(statuses: Iterable<SourceStatus>): SourceStatus {
  let weakest: SourceStatus | null = null;
  for (const s of statuses) {
    if (weakest === null || STATUS_RANK[s] < STATUS_RANK[weakest]) weakest = s;
  }
  // Nothing used means nothing established — not "vacuously verified". The
  // `rights_display` default had exactly this trap: an empty cluster reading
  // as PERMITTED passed every fixture until a mutation found it.
  return weakest ?? 'UNVERIFIED';
}

export function isAtLeast(s: SourceStatus, floor: SourceStatus): boolean {
  return STATUS_RANK[s] >= STATUS_RANK[floor];
}

/** What a trade REPORT says about its own place in the sequence. */
export type ReportLifecycle =
  | 'REGULAR'
  | 'LATE_IN_SEQUENCE'
  | 'LATE_OUT_OF_SEQUENCE'
  | 'OPENING_LATE_IN_SEQUENCE'
  | 'OPENING_LATE_OUT_OF_SEQUENCE'
  /** A code this table does not interpret. Kept, surfaced, never guessed. */
  | 'UNKNOWN';

/** Which earlier trade a CANCEL refers to. */
export type CancelScope =
  /** A previously reported trade other than the last or the opening. */
  | 'PREVIOUS'
  /** The last trade reported for the contract. */
  | 'LAST'
  /** The opening (first) trade reported that day for the contract. */
  | 'OPENING'
  /** The only trade reported that day for the contract. */
  | 'ONLY';

export type CodeMeaning =
  | { kind: 'REPORT'; lifecycle: Exclude<ReportLifecycle, 'UNKNOWN'>; iso?: boolean; complex?: boolean }
  | { kind: 'CANCEL'; scope: CancelScope }
  /**
   * A code that speaks to the trading session and to nothing else. It is read
   * by `session.ts` and removed before lifecycle interpretation, so an
   * extended-hours print is not also marked "uninterpreted".
   */
  | { kind: 'SESSION_QUALIFIER'; session: 'EXTENDED' }
  /** A trade qualifier whose meaning this table does not claim to know. */
  | { kind: 'QUALIFIER_UNINTERPRETED' };

export interface CodeRow {
  /** The OPRA Last Sale message-type mnemonic. */
  code: string;
  meaning: CodeMeaning;
  status: SourceStatus;
  /**
   * Verbatim wording surfaced for this definition, if any, and where the search
   * engine said it came from. The text is exactly as surfaced — a truncated
   * fragment stays truncated, because completing it would be writing the
   * specification from memory and quoting the result.
   */
  corroboration: { text: string; surfacedFrom: string; surfacedOn: string } | null;
  /** Why this row stands where it does. */
  note: string;
}

const OPRA_BINARY_SPEC_SURFACED =
  'https://uploads-ssl.webflow.com/5ba40927ac854d8c97bc92d7/5bf4197268f8b277dbb7c12d_opra_output_binary_dr_spec.pdf';

/**
 * OPRA Category 'a' (equity and index Last Sale) message types.
 *
 * The one structural fact search corroborated, verbatim: "The following Message
 * Types, all mutually exclusive, apply to Category a (Equity and Index Last
 * Sale) messages." Mutually exclusive means one code per message — so a report
 * cannot be both late and an ISO, and the table models it that way.
 */
export const OPRA_LAST_SALE_CODES: readonly CodeRow[] = [
  {
    code: 'REGULAR',
    meaning: { kind: 'REPORT', lifecycle: 'REGULAR' },
    status: 'UNVERIFIED',
    corroboration: null,
    note: 'The absence of a qualifying message type. Recalled, not read.',
  },
  {
    code: 'CANC',
    meaning: { kind: 'CANCEL', scope: 'PREVIOUS' },
    status: 'UNVERIFIED',
    corroboration: {
      text: 'Transaction previously reported (other than as the last or opening report for the particular option contract) is now to ...',
      surfacedFrom: OPRA_BINARY_SPEC_SURFACED,
      surfacedOn: '2026-09-27',
    },
    note:
      'A definition with this wording exists (SEARCH_ONLY fragment). Its association with ' +
      'the code CANC was not surfaced and is recalled, so the MAPPING is UNVERIFIED.',
  },
  {
    code: 'OSEQ',
    meaning: { kind: 'REPORT', lifecycle: 'LATE_OUT_OF_SEQUENCE' },
    status: 'UNVERIFIED',
    corroboration: {
      text: 'Transaction is being reported late and is out of sequence; i.e., later transactions have been reported for the particular ...',
      surfacedFrom: OPRA_BINARY_SPEC_SURFACED,
      surfacedOn: '2026-09-27',
    },
    note: 'Fragment corroborates the definition; the code association is recalled.',
  },
  {
    code: 'CNCL',
    meaning: { kind: 'CANCEL', scope: 'LAST' },
    status: 'UNVERIFIED',
    corroboration: {
      text: 'Transaction is the last reported for the particular option contract and is now cancelled.',
      surfacedFrom: OPRA_BINARY_SPEC_SURFACED,
      surfacedOn: '2026-09-27',
    },
    note: 'Fragment corroborates the definition; the code association is recalled.',
  },
  {
    code: 'LATE',
    meaning: { kind: 'REPORT', lifecycle: 'LATE_IN_SEQUENCE' },
    status: 'UNVERIFIED',
    corroboration: null,
    note: 'Recalled: reported late but in correct sequence.',
  },
  {
    code: 'CNCO',
    meaning: { kind: 'CANCEL', scope: 'OPENING' },
    status: 'UNVERIFIED',
    corroboration: null,
    note: 'Recalled: the opening report for the contract, cancelled after later reports.',
  },
  {
    code: 'OPEN',
    meaning: { kind: 'REPORT', lifecycle: 'OPENING_LATE_OUT_OF_SEQUENCE' },
    status: 'UNVERIFIED',
    corroboration: null,
    note: 'Recalled: a late report of the opening trade, out of sequence.',
  },
  {
    code: 'CNOL',
    meaning: { kind: 'CANCEL', scope: 'ONLY' },
    status: 'UNVERIFIED',
    corroboration: null,
    note: 'Recalled: the only report that day for the contract, cancelled.',
  },
  {
    code: 'OPNL',
    meaning: { kind: 'REPORT', lifecycle: 'OPENING_LATE_IN_SEQUENCE' },
    status: 'UNVERIFIED',
    corroboration: null,
    note: 'Recalled: a late report of the opening trade, in correct sequence.',
  },
  {
    code: 'ISOI',
    meaning: { kind: 'REPORT', lifecycle: 'REGULAR', iso: true },
    status: 'UNVERIFIED',
    corroboration: null,
    note:
      'Recalled: an intermarket sweep order execution. Matters to the engine, which ' +
      'reads ISO as sweep evidence; an unverified ISO flag is therefore surfaced, not trusted.',
  },
  // Complex-order families. H-001 admits only simple, non-complex prints, so
  // recognising these is a research-eligibility question, not a detail: a leg
  // of a spread is not a standalone directional print.
  ...(['SPRD', 'STDL', 'STPD', 'CSTP', 'BWRT', 'CMBO'] as const).map((code): CodeRow => ({
    code,
    meaning: { kind: 'REPORT', lifecycle: 'REGULAR', complex: true },
    status: 'UNVERIFIED',
    corroboration: null,
    note:
      'Recalled as a complex/multi-leg execution type (spread, straddle, stock-option, ' +
      'buy-write, combo families). Treated as COMPLEX for eligibility until verified.',
  })),
  // The legacy extended-hours marker. Case-sensitive on purpose: `v` and `V`
  // are different codes in alphabets that use both, and folding them is a guess.
  {
    code: 'v',
    meaning: { kind: 'SESSION_QUALIFIER', session: 'EXTENDED' },
    status: 'UNVERIFIED',
    corroboration: null,
    note:
      'Supplied by the operator audit of 2026-09-27 as the legacy extended-hours sale ' +
      'condition, used by participants not yet migrated to the Trading Session Identifier. ' +
      'Not read in any document; a search on 2026-09-27 surfaced no text for it.',
  },
  // Qualifiers recalled as existing whose meaning this table will not assert.
  ...(['AUTO', 'REOP', 'AJST', 'SPIM', 'BNMT', 'XMPT'] as const).map((code): CodeRow => ({
    code,
    meaning: { kind: 'QUALIFIER_UNINTERPRETED' },
    status: 'UNVERIFIED',
    corroboration: null,
    note:
      'Recalled as a message type; meaning not asserted. A report carrying it keeps the ' +
      'code and is marked uninterpreted rather than silently treated as regular.',
  })),
];

/** A provider's code table, looked up by exact code. */
export type CodeTable = ReadonlyMap<string, CodeRow>;

export function codeTableOf(rows: readonly CodeRow[]): CodeTable {
  const table = new Map<string, CodeRow>();
  for (const r of rows) {
    // Two rows for one code would make the table's answer depend on order.
    if (table.has(r.code)) throw new Error(`duplicate code row: ${r.code}`);
    table.set(r.code, r);
  }
  return table;
}

export const OPRA_CODE_TABLE: CodeTable = codeTableOf(OPRA_LAST_SALE_CODES);

/**
 * How a provider encodes its trading-session field. Data, like the code table,
 * because it is a claim about someone else's specification — and because two
 * providers carrying OPRA's identifier may still deliver it differently.
 */
export interface SessionEncoding {
  values: Readonly<Record<string, 'REGULAR' | 'EXTENDED'>>;
  status: SourceStatus;
  source: string;
}

/**
 * OPRA's Trading Session Identifier, as supplied by the operator audit of
 * 2026-09-27 — not read. The notice was behind the egress policy, and a
 * search the same day confirmed OPRA carries extended-hours data but surfaced
 * nothing about the identifier's values.
 */
export const OPRA_SESSION_ENCODING: SessionEncoding = {
  values: { '0': 'REGULAR', '1': 'EXTENDED' },
  status: 'UNVERIFIED',
  source: 'OPRA Trading Session Identifier notice, as quoted by the operator audit of 2026-09-27 (not read)',
};

/** Everything needed to read one provider's raw records. */
export interface ProviderSemantics {
  codes: CodeTable;
  session: SessionEncoding;
}

export const OPRA_SEMANTICS: ProviderSemantics = { codes: OPRA_CODE_TABLE, session: OPRA_SESSION_ENCODING };

export function lookupOpraCode(code: string): CodeRow | undefined {
  return OPRA_CODE_TABLE.get(code);
}
