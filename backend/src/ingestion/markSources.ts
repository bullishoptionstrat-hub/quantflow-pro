/**
 * Where the grader's underlying price comes from.
 *
 * `getSpotPrice` used to be the answer, singular and hard-wired: the grader was
 * constructed as `new SignalGrader(store, (u) => getSpotPrice(u) ?? undefined)`
 * and `getSpotPrice` reads Twelve Data's cache and nothing else. Two
 * consequences followed, and only the first was ever written down.
 *
 *   1. **An unrelated missing key blocked every grade.** A deployment could
 *      hold a licensed options feed and durable storage and still return
 *      `UNGRADED — no usable entry mark` on everything, because the mark came
 *      from a different vendor. `tools/collection/doctor.ts` exists largely to
 *      say that out loud.
 *   2. **No graded outcome recorded where its price came from.** With one
 *      possible source that was recoverable by knowing the deployment; with
 *      more than one it would not be, and a track record that cannot say which
 *      vendor priced a row cannot be audited later. `Mark` carries the source
 *      so the answer is structural rather than remembered.
 *
 * **The registry is one entry long today, and that is the honest state.** Of
 * the sources this codebase can actually price an underlying from, Finnhub is
 * `PROHIBITED` for PERSIST by its own quoted redistribution clause, Yahoo is
 * `PROHIBITED` for DISPLAY before the question even arises, Polygon's plan here
 * is entitled to end-of-day aggregates only — which cannot mark an M15
 * checkpoint — and Tradier has no token in this deployment and no REST quote
 * helper written. A vendor path that has never returned a price is not a
 * fallback; it is a check with nothing to check. So the *mechanism* is ranked
 * and the *registry* is short, and those are different claims.
 *
 * Register Tradier here when a token exists — it is `PERMITTED` for PERSIST in
 * `PRIVATE_RESEARCH` and would rank above Twelve Data automatically.
 */
import {
  classifySource, resolveBusinessMode, type BusinessMode, type RightsClass,
} from '../provenance/rights';
import { getSpotMark } from './connectors/twelveData';
import type { Mark } from '../persistence/grader';

interface MarkSource {
  /** Connector source string, as `SOURCE_TO_DATASET` knows it. */
  source: string;
  /**
   * The cached price *and its vendor stamp*, or null when this source has
   * nothing for that symbol.
   *
   * The stamp is part of the return rather than a second call, so a source
   * cannot supply a price this registry is unable to date — the same
   * structural argument that put `source` on `Mark`.
   */
  lookup(underlying: string): { price: number; asOf: number } | null;
  /**
   * The env vars its connector needs.
   *
   * Duplicated from `CONNECTOR_CREDENTIALS` rather than imported, because
   * `ingestion/index.ts` imports this module and the reverse would be a cycle.
   * `markSources.test.ts` holds the two in agreement, the way
   * `vendorMirror.test.ts` holds the vendored flow-engine to its source — a
   * duplication with a guard beats a cycle, and beats an undeclared drift.
   */
  needs: readonly string[];
  /** Why this source can serve a mark at all. */
  note: string;
}

const SOURCES: readonly MarkSource[] = [
  {
    source: 'twelvedata',
    lookup: getSpotMark,
    needs: ['TWELVE_DATA_API_KEY'],
    note:
      'The spot cache, filled by two paths with different reach: measured ' +
      '2026-09-17, the WebSocket plan accepts only QQQ and AAPL of the ten ' +
      'watched symbols, so the other eight — SPY included — are priced by ' +
      'REST alone, on a rotation the free tier\'s 800 credits/day paces at ' +
      'roughly 19 minutes. That is longer than the M15 horizon. UNVERIFIED ' +
      'for PERSIST — Section 16.1 caps retention at the subscription\'s ' +
      'permitted duration and this deployment\'s subscription is not ' +
      'established — so it is used, ranked last, and recorded as UNVERIFIED ' +
      'on every outcome it prices.',
  },
];

/**
 * Preference order. Lower sorts first.
 *
 * Deliberately **not** `classifySource(...).allowed`, which is false for
 * anything short of affirmatively PERMITTED. Filtering on that would drop
 * Twelve Data and leave the grader with no mark source at all — silently
 * turning the only working path off. The established decision for PERSIST
 * marks is the doctor's check 4b: *report the uncertainty, do not refuse it*,
 * mirroring the connector gate, which refuses `PROHIBITED` only.
 *
 * So: `PERMITTED` beats `UNVERIFIED`, `PROHIBITED` is never used, and the class
 * that was in force travels onto the row.
 */
const RANK: Record<string, number> = { PERMITTED: 0, UNVERIFIED: 1 };

function rankOf(rightsClass: string): number | null {
  return rightsClass in RANK ? RANK[rightsClass]! : null;
}

export interface MarkSourceStanding {
  source: string;
  rightsClass: RightsClass | 'UNKNOWN_DATASET';
  /** Its rights standing permits pricing a mark in this mode. */
  rightsOk: boolean;
  /** Its connector's variables are set. */
  credentialed: boolean;
  /** Variables it needs, so "not credentialed" names something actionable. */
  needs: readonly string[];
  /** Both halves hold: this source could price a mark right now. */
  usable: boolean;
  /** The registry's note, or the rights reason when it is refused. */
  reason: string;
}

/**
 * Every registered source and where it stands, usable or not.
 *
 * Exported for the doctor and for `/api/health`: "no mark source" should be
 * answerable with *which candidates exist and why each is in or out*, not with
 * the name of one environment variable.
 */
export function markSourceStandings(
  env: NodeJS.ProcessEnv = process.env,
  mode?: BusinessMode,
): MarkSourceStanding[] {
  let m: BusinessMode;
  try {
    // `resolveBusinessMode(env)`, not `resolveBusinessMode()` — the no-argument
    // form reads `process.env` and would quietly ignore the environment this
    // function was handed, which is the whole point of taking one. Caught by
    // `an unresolvable business mode prices nothing`, which passed a bad mode
    // in `env` and watched the real process environment answer instead.
    m = mode ?? resolveBusinessMode(env);
  } catch {
    // A mode we cannot resolve is a rights decision we cannot make. Nothing is
    // usable, and saying so beats guessing at the permissive answer.
    return SOURCES.map((s) => ({
      source: s.source,
      rightsClass: 'UNKNOWN_DATASET' as const,
      rightsOk: false,
      credentialed: false,
      needs: s.needs,
      usable: false,
      reason: 'BUSINESS_MODE is set to an unrecognised value, so no rights ' +
              'decision can be made and no source may price a mark.',
    }));
  }

  return SOURCES.map((s) => {
    const d = classifySource(s.source, 'PERSIST', m);
    const rightsOk = rankOf(d.rightsClass) !== null;
    const credentialed = s.needs.every((k) => (env[k] ?? '').trim().length > 0);
    return {
      source: s.source,
      rightsClass: d.rightsClass,
      rightsOk,
      credentialed,
      needs: s.needs,
      // Both halves, reported separately above so the failing one is named.
      // "No mark source" is a useless answer; "twelvedata is permitted enough
      // and has no key" is one an operator can act on.
      usable: rightsOk && credentialed,
      reason: rightsOk
        ? (credentialed ? s.note
          : `${s.note} Not usable now: ${s.needs.join(', ')} unset.`)
        : d.reason,
    };
  }).sort((a, b) => {
    const ra = rankOf(a.rightsClass) ?? Number.MAX_SAFE_INTEGER;
    const rb = rankOf(b.rightsClass) ?? Number.MAX_SAFE_INTEGER;
    return ra - rb;
  });
}

/** The usable sources, best rights standing first. */
function orderedUsable(mode: BusinessMode): Array<MarkSource & { rightsClass: string }> {
  return SOURCES
    .map((s) => ({ ...s, rightsClass: classifySource(s.source, 'PERSIST', mode).rightsClass }))
    .filter((s) => rankOf(s.rightsClass) !== null)
    .sort((a, b) => rankOf(a.rightsClass)! - rankOf(b.rightsClass)!);
}

/**
 * The grader's mark lookup: first usable source with a price for this symbol.
 *
 * A source with no price for a symbol is skipped rather than failing the
 * lookup — that is the point of a list. A price of zero or less is not a
 * price: `missingIsNotZero` is a rule this file inherits rather than restates,
 * and a mark of `0` would produce an excursion of -100% against a live entry.
 */
export function resolveMark(underlying: string, mode?: BusinessMode): Mark | undefined {
  let m: BusinessMode;
  try {
    m = mode ?? resolveBusinessMode();
  } catch {
    return undefined;
  }

  // No credential check here, deliberately: a source with no key has an empty
  // cache and returns `null`, so it is skipped by the same branch that skips a
  // source with no price for this symbol. Testing the key as well would put the
  // same fact in two places and invite them to disagree.
  for (const s of orderedUsable(m)) {
    const hit = s.lookup(underlying);
    if (hit === null || !(hit.price > 0)) continue;
    // A mark this registry cannot date is not a usable mark. Defaulting the
    // stamp — to now, or to zero — is the `?? 0` move with a clock instead of
    // a price, and it would defeat the grader's staleness refusals by handing
    // them a number they cannot doubt.
    if (!Number.isFinite(hit.asOf) || hit.asOf <= 0) continue;
    return { price: hit.price, source: s.source, rightsClass: s.rightsClass, asOf: hit.asOf };
  }
  return undefined;
}

/**
 * The PERSIST rights class in force for a registered mark source, or
 * `undefined` when this registry does not know that source.
 *
 * Exists for restart recovery, which rebuilds an entry `Mark` from an outcome
 * row. The row persists the mark's price, source and stamp but not its rights
 * class, so the class has to be resolved here — and `undefined` for an
 * unregistered source is the load-bearing half: the recovery path refuses such
 * a mark rather than labelling it with a placeholder.
 *
 * It is the class in force **now**, not necessarily the one in force when the
 * mark was taken. A vendor's standing can change between a checkpoint and a
 * restart; that is why it is resolved rather than assumed, and why the row
 * records the source in the first place.
 */
export function markRightsClass(
  markSource: string,
  mode?: BusinessMode,
): string | undefined {
  let m: BusinessMode;
  try {
    m = mode ?? resolveBusinessMode();
  } catch {
    return undefined;
  }
  const standing = markSourceStandings(process.env, m)
    .find((x) => x.source === markSource);
  if (!standing) return undefined;
  // An unregistered dataset has no established standing to report, and a mark
  // priced by a source refused for PERSIST must not be resumed as though it
  // were permitted.
  if (standing.rightsClass === 'UNKNOWN_DATASET') return undefined;
  if (!standing.rightsOk) return undefined;
  return standing.rightsClass;
}

/** Source ids in the registry, regardless of standing. For guards. */
export function registeredMarkSources(): string[] {
  return SOURCES.map((s) => s.source);
}

/** What each registered source needs, for the guard that mirrors the table. */
export function markSourceCredentials(): Record<string, readonly string[]> {
  return Object.fromEntries(SOURCES.map((s) => [s.source, s.needs]));
}
