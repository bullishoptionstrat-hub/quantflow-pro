/**
 * The rights a research dataset carries with it (directive §21).
 *
 * `rights.ts` answers DISPLAY and PERSIST for the connectors this service runs.
 * A research corpus needs more axes than that, because a historical file is
 * used in more ways than a live panel: it is fetched, kept raw, kept
 * normalised, analysed, possibly trained on, possibly exported, and it has a
 * retention limit. Each is a separate permission and each can be refused
 * while the others are granted — so each is recorded separately, with the
 * words that establish it.
 *
 * Three rules, enforced by `manifestProblems`:
 *
 *   1. **Unknown is UNVERIFIED.** A manifest is written before anything is
 *      purchased, and every axis starts there.
 *   2. **PERMITTED needs its own words.** A verbatim quote, the document it
 *      came from, and the date it was read — and evidence at least
 *      PROVIDER_VERIFIED. A search snippet is not a licence.
 *   3. **A successful download is not a permission** (INV-RIGHTS-001). There is
 *      no field here that a fetch can set, and `importPermitted` reads only
 *      what the manifest says.
 *
 * `quote` is verbatim or null. A paraphrase belongs in `note`, attributed —
 * the rule `rights.ts` adopted after a summariser's wording nearly landed in a
 * field documented as a quotation.
 */
import type { BusinessMode } from './rights';
import type { SourceStatus } from '../events/semantics';
import { isAtLeast } from '../events/semantics';

export type ManifestStatus =
  | 'PERMITTED'
  | 'PROHIBITED'
  | 'UNVERIFIED'
  /** The text is read, and what it means for this use is a legal question. */
  | 'LEGAL_INTERPRETATION_REQUIRED';

export interface RightsFact {
  status: ManifestStatus;
  /** The document's own words, or null. Never a paraphrase. */
  quote: string | null;
  /** URL or exact title of the document the quote is from. */
  document: string | null;
  /** ISO date the document was read. */
  readAt: string | null;
  /** How the fact was established. */
  evidence: SourceStatus;
  note: string;
}

export const RIGHTS_AXES = [
  'fetch', 'persistRaw', 'persistNormalized', 'researchUse',
  'modelTraining', 'export', 'redistribution', 'retention',
] as const;
export type RightsAxis = (typeof RIGHTS_AXES)[number];

export interface DatasetRightsManifest {
  schema: 'quantflow-dataset-rights-v1';
  provider: string;
  dataset: string;
  /** Null until something has been purchased. */
  subscriptionTier: string | null;
  intendedDeploymentMode: BusinessMode;
  rights: Record<RightsAxis, RightsFact>;
  sourceDocuments: string[];
  /** When the manifest as a whole was last checked against its documents. */
  verifiedAt: string | null;
}

/**
 * A calendar date that exists, on or before `today`. The shape alone is not
 * enough: `2026-02-31` matches `\d{4}-\d{2}-\d{2}` and is before any real
 * today, so a regex waved it through as the date a document was read.
 */
function isRealPastDate(d: string, today: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
  if (m === null) return false;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return new Date(t).toISOString().slice(0, 10) === d && d <= today;
}

/** Everything wrong with a manifest, rather than the first thing. */
export function manifestProblems(m: DatasetRightsManifest, today: string): string[] {
  const out: string[] = [];
  if (m.schema !== 'quantflow-dataset-rights-v1') out.push(`unknown manifest schema ${String(m.schema)}`);
  for (const axis of RIGHTS_AXES) {
    const f = m.rights[axis];
    if (f === undefined) {
      out.push(`${axis}: missing — an absent axis is not a permission`);
      continue;
    }
    if (f.quote !== null && (f.document === null || f.readAt === null)) {
      out.push(`${axis}: a quote with no document or read date is not evidence`);
    }
    if (f.readAt !== null && !isRealPastDate(f.readAt, today)) {
      out.push(`${axis}: read date ${f.readAt} is not a real date on or before ${today}`);
    }
    if (f.status === 'PERMITTED') {
      if (f.quote === null || f.document === null || f.readAt === null) {
        out.push(`${axis}: PERMITTED needs the words that permit it, where they are, and when they were read`);
      }
      if (!isAtLeast(f.evidence, 'PROVIDER_VERIFIED')) {
        out.push(`${axis}: PERMITTED on ${f.evidence} evidence — technical accessibility does not promote a rights classification`);
      }
    }
  }
  const anyPermitted = RIGHTS_AXES.some((a) => m.rights[a]?.status === 'PERMITTED');
  if (anyPermitted && m.verifiedAt === null) out.push('a manifest granting anything must say when it was verified');
  if (m.verifiedAt !== null && !isRealPastDate(m.verifiedAt, today)) {
    out.push(`verified date ${m.verifiedAt} is not a real date on or before ${today}`);
  }
  return out;
}

/** The axes an import needs. Training, export and redistribution are separate decisions. */
const IMPORT_AXES: readonly RightsAxis[] = ['fetch', 'persistRaw', 'persistNormalized', 'researchUse', 'retention'];

/**
 * `mode` is the business mode the import would run under, and it is required:
 * a manifest's permissions were read for its `intendedDeploymentMode`, and the
 * same words can permit private research and refuse a commercial product —
 * `rights.ts` already classifies Finnhub differently in the two. An optional
 * parameter would let a caller that forgot it inherit the manifest's own
 * answer for a mode nobody read the terms for.
 */
export function importPermitted(
  m: DatasetRightsManifest | null,
  today: string,
  mode: BusinessMode,
): { allowed: boolean; why: string[] } {
  if (m === null) return { allowed: false, why: ['no rights manifest for this dataset'] };
  const why = manifestProblems(m, today);
  if (m.intendedDeploymentMode !== mode) {
    why.push(`the manifest was read for ${m.intendedDeploymentMode}, and this import runs under ${mode}`);
  }
  for (const axis of IMPORT_AXES) {
    const f = m.rights[axis];
    if (f !== undefined && f.status !== 'PERMITTED') why.push(`${axis}: ${f.status}`);
  }
  return { allowed: why.length === 0, why };
}
