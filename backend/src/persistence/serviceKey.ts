/**
 * Is the configured Supabase credential the kind that can write?
 *
 * Two places decided "history is durable" from two non-empty strings:
 * `initPersistence` set `durable: true` with the reason *"history survives
 * restarts"*, and the doctor's check 3 said the same in a `warn`. Neither had
 * asked anything. That is the defect 1.1a removed from check 2 — a claim of
 * capability read off configuration — and it survives here because a Supabase
 * project is not something this repo could probe.
 *
 * It still cannot be probed from here: the success path is "this key writes
 * `signal_history`", and measuring that needs a `SUPABASE_SERVICE_KEY` in the
 * environment. So this module does the part that *can* be measured, entirely
 * offline, and makes no claim about the part that cannot.
 *
 * ## What this refuses, and how each refusal was established
 *
 * The anon key and the service key sit next to each other in the Supabase
 * dashboard, and pasting the wrong one is silent: the client constructs fine,
 * every insert is rejected by RLS, and `/api/health` reports `durable: true`
 * behind a store that has never kept a row. The four history tables
 * `force row level security` with no policies, so an `anon` credential cannot
 * write them. That is measured, not inferred from the migration file: on the
 * live project, all four tables report `relrowsecurity` and
 * `relforcerowsecurity` true with **zero** policies, and an `anon` SELECT
 * against `signal_history` answers `200 []` rather than a privilege error —
 * the signature of "the GRANT exists, the policy denies". Supabase grants anon
 * INSERT by default, so the privilege bit is true and means nothing; with RLS
 * forced and no policy, every row is refused.
 *
 * Deliberately asymmetric. This module **proves keys wrong**; it never
 * pronounces one right. A `service_role` claim means the *shape* is right and
 * nothing more — the key can still be revoked, rotated, or from a project that
 * was deleted, and saying otherwise would re-introduce exactly the
 * configuration-as-capability claim above one level up.
 *
 * ## Basis
 *
 * Measured 2026-09-16 against project `vitnwysywkmpuaoluqom`, which issues
 * both eras side by side:
 *
 *   legacy      `eyJ…` JWT, payload `{"iss":"supabase","ref":"<project-ref>",
 *               "role":"anon","iat":…,"exp":…}` — HS256, base64url
 *   modern      `sb_publishable_wf9_…`
 *
 * The modern secret form (`sb_secret_…`) was **not** measured: fetching one
 * would mean pulling a live service credential into a transcript, which is the
 * thing this file exists to keep an operator from doing by accident. Its prefix
 * is documented, it is treated as *opaque* rather than as proof of anything,
 * and the distinction is recorded on every result.
 */

/** What the credential in `SUPABASE_SERVICE_KEY` is, as far as its shape says. */
export type ServiceKeyShape =
  /** A legacy JWT whose `role` claim is `service_role`, or an `sb_secret_` key. */
  | 'service_role'
  /** Provably the wrong key: an `anon` JWT or an `sb_publishable_` key. */
  | 'public_key'
  /** A legacy JWT past its `exp`. */
  | 'expired'
  /** A legacy JWT issued for a different project than `SUPABASE_URL` names. */
  | 'project_mismatch'
  /** Present, but nothing about it is recognisable. Never treated as a pass. */
  | 'unrecognised'
  /** Not set at all. */
  | 'absent';

export interface ServiceKeyVerdict {
  shape: ServiceKeyShape;
  /**
   * Whether a write could possibly succeed. `true` means "not provably
   * broken", never "verified" — see the asymmetry note above.
   */
  usable: boolean;
  /** Operator-facing. Reaches `/api/health`, so it never carries the key. */
  reason: string;
  /** Where this branch's mapping came from. Measured beats documented. */
  basis: string;
}

const MEASURED =
  'Measured 2026-09-16 against a live Supabase project issuing both key eras, ' +
  'whose four history tables report RLS forced with zero policies.';
const DOCUMENTED =
  'Documented prefix; not measured here, because reading a live service ' +
  'credential to confirm a string prefix is a worse trade than saying so.';

/**
 * The project ref `SUPABASE_URL` names, or null.
 *
 * Only the managed `<ref>.supabase.co` form yields one. A custom domain or a
 * self-hosted URL yields null, and the mismatch check is *skipped* rather than
 * failed — refusing a working self-hosted deployment because its hostname does
 * not look like Supabase's would be this module inventing a fault.
 */
export function projectRefFromUrl(url: string | undefined): string | null {
  if (!url) return null;
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return null;
  }
  const m = /^([a-z0-9]{20})\.supabase\.(co|in|red)$/.exec(host);
  return m ? m[1]! : null;
}

/** The `role`/`ref`/`exp` claims of a Supabase legacy key, or null. */
function decodeLegacyClaims(key: string): { role?: string; ref?: string; exp?: number } | null {
  const parts = key.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8'));
    // `iss` is what says this is a Supabase key rather than any other JWT that
    // happens to have three segments. Without it the claims below mean nothing
    // and reading `role` off a stranger's token would be inventing a verdict.
    if (payload?.iss !== 'supabase') return null;
    return { role: payload.role, ref: payload.ref, exp: payload.exp };
  } catch {
    return null;
  }
}

/**
 * Classify the credential, offline.
 *
 * `now` is injected so the expiry branch is testable without waiting eight
 * years for the measured key to lapse.
 */
export function classifyServiceKey(
  url: string | undefined,
  key: string | undefined,
  now: number = Date.now(),
): ServiceKeyVerdict {
  const k = (key ?? '').trim();
  if (!k) {
    return {
      shape: 'absent', usable: false,
      reason: 'SUPABASE_SERVICE_KEY is not set.',
      basis: 'Not a classification — the variable is empty.',
    };
  }

  if (k.startsWith('sb_publishable_')) {
    return {
      shape: 'public_key', usable: false,
      reason:
        'SUPABASE_SERVICE_KEY holds a publishable key (sb_publishable_…), which is the ' +
        'browser-safe one. The four history tables force row level security with no ' +
        'policies, so every write will be rejected and nothing will ever accumulate.',
      basis: MEASURED,
    };
  }

  if (k.startsWith('sb_secret_')) {
    return {
      shape: 'service_role', usable: true,
      reason:
        'SUPABASE_SERVICE_KEY holds a secret key (sb_secret_…). The shape is right. ' +
        'Whether it reaches a project, and whether that project has the four history ' +
        'tables, is not checked here — a secret key carries no readable claims.',
      basis: DOCUMENTED,
    };
  }

  const claims = decodeLegacyClaims(k);
  if (!claims) {
    return {
      shape: 'unrecognised', usable: false,
      reason:
        'SUPABASE_SERVICE_KEY is set but is neither a Supabase JWT nor an sb_secret_ ' +
        'key. A credential this module cannot recognise is reported as such rather ' +
        'than assumed to work.',
      basis:
        'The safe default. An unreadable key must never classify as service_role: ' +
        'the failure direction that matters is a wrong key reading as correct.',
    };
  }

  if (claims.role !== 'service_role') {
    return {
      shape: 'public_key', usable: false,
      reason:
        `SUPABASE_SERVICE_KEY holds a key whose role claim is "${claims.role ?? 'unset'}", ` +
        'not "service_role" — the anon key sits next to the service key in the ' +
        'dashboard. The four history tables force row level security with no policies, ' +
        'so every write will be rejected and nothing will ever accumulate.',
      basis: MEASURED,
    };
  }

  // Expiry before project: a key that has lapsed is wrong whichever project it
  // names, and naming the recoverable fault first sends an operator to the
  // wrong dashboard page.
  if (typeof claims.exp === 'number' && claims.exp * 1000 <= now) {
    return {
      shape: 'expired', usable: false,
      reason:
        `SUPABASE_SERVICE_KEY expired on ${new Date(claims.exp * 1000).toISOString()}. ` +
        'Every write will be rejected until it is reissued.',
      basis: MEASURED,
    };
  }

  const urlRef = projectRefFromUrl(url);
  if (urlRef && claims.ref && claims.ref !== urlRef) {
    return {
      shape: 'project_mismatch', usable: false,
      reason:
        `SUPABASE_SERVICE_KEY was issued for project "${claims.ref}" but SUPABASE_URL ` +
        `points at "${urlRef}". One of the two is from another deployment.`,
      basis: MEASURED,
    };
  }

  return {
    shape: 'service_role', usable: true,
    reason:
      'SUPABASE_SERVICE_KEY holds a service_role key' +
      (urlRef ? ` for the project SUPABASE_URL names` : '') +
      '. The shape is right. Whether the key is still valid, and whether the project ' +
      'has the four history tables, is not checked here.',
    basis: MEASURED,
  };
}
