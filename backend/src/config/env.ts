/**
 * Startup environment validation.
 *
 * Rule: in production the process must FAIL TO BOOT when a required secret is
 * missing or blank. A blank secret must never silently downgrade a guarded
 * surface into an unguarded one.
 *
 * This module never logs secret VALUES — only variable names and presence.
 */

export type NodeEnv = 'production' | 'development' | 'test';

export type EnvIssueCode =
  | 'missing_required_secret'
  | 'blank_required_secret'
  | 'invalid_data_mode'
  | 'partial_secret_group';

export interface EnvIssue {
  readonly code: EnvIssueCode;
  /** Variable name only. Never a value. */
  readonly variable: string;
  readonly detail: string;
}

export type EnvValidation =
  | { readonly ok: true; readonly warnings: readonly EnvIssue[] }
  | { readonly ok: false; readonly errors: readonly EnvIssue[]; readonly warnings: readonly EnvIssue[] };

/** Present AND non-blank. `""` and `"   "` are treated as absent. */
export function hasValue(raw: string | undefined): boolean {
  return typeof raw === 'string' && raw.trim().length > 0;
}

export function resolveNodeEnv(env: NodeJS.ProcessEnv = process.env): NodeEnv {
  const raw = (env.NODE_ENV ?? '').trim().toLowerCase();
  if (raw === 'production') return 'production';
  if (raw === 'test') return 'test';
  return 'development';
}

/**
 * Secrets that must be present and non-blank before the process may serve
 * traffic in production.
 *
 * SUPABASE_URL / SUPABASE_SERVICE_KEY gate `requireAuth`. If either is blank
 * the Supabase client is never constructed, so no bearer token can ever be
 * verified. `requireAuth` stays fail-closed (401 for everyone), but shipping a
 * build in that state is a misconfiguration we refuse to boot with rather than
 * discover in production.
 */
const PRODUCTION_REQUIRED_SECRETS = ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY'] as const;

/**
 * Groups where configuring some members but not all is a latent auth failure.
 * Enforced in every environment, because a half-configured provider is a bug
 * regardless of NODE_ENV.
 */
const SECRET_GROUPS: ReadonlyArray<{ name: string; variables: readonly string[] }> = [
  { name: 'supabase', variables: ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY'] },
  { name: 'schwab', variables: ['SCHWAB_APP_KEY', 'SCHWAB_APP_SECRET', 'SCHWAB_REFRESH_TOKEN'] },
  { name: 'tastytrade', variables: ['TASTYTRADE_USER', 'TASTYTRADE_PASS'] },
  { name: 'reddit', variables: ['REDDIT_CLIENT_ID', 'REDDIT_CLIENT_SECRET'] },
];

export function validateEnv(env: NodeJS.ProcessEnv = process.env): EnvValidation {
  const nodeEnv = resolveNodeEnv(env);
  const errors: EnvIssue[] = [];
  const warnings: EnvIssue[] = [];

  for (const variable of PRODUCTION_REQUIRED_SECRETS) {
    if (hasValue(env[variable])) continue;

    const issue: EnvIssue = {
      code: variable in env ? 'blank_required_secret' : 'missing_required_secret',
      variable,
      detail:
        variable in env
          ? `${variable} is set but blank. A blank secret is treated as absent and would leave auth unconfigured.`
          : `${variable} is not set. Auth verification cannot be configured without it.`,
    };

    if (nodeEnv === 'production') errors.push(issue);
    else warnings.push(issue);
  }

  for (const group of SECRET_GROUPS) {
    const present = group.variables.filter((v) => hasValue(env[v]));
    if (present.length === 0 || present.length === group.variables.length) continue;

    const missing = group.variables.filter((v) => !hasValue(env[v]));
    const issue: EnvIssue = {
      code: 'partial_secret_group',
      variable: missing.join(', '),
      detail: `Secret group "${group.name}" is partially configured. Missing or blank: ${missing.join(', ')}.`,
    };

    if (nodeEnv === 'production') errors.push(issue);
    else warnings.push(issue);
  }

  const rawDataMode = (env.DATA_MODE ?? '').trim().toLowerCase();
  if (rawDataMode !== '' && rawDataMode !== 'live' && rawDataMode !== 'demo') {
    errors.push({
      code: 'invalid_data_mode',
      variable: 'DATA_MODE',
      detail: `DATA_MODE must be "live" or "demo" (received an unrecognized value).`,
    });
  }

  if (errors.length > 0) return { ok: false, errors, warnings };
  return { ok: true, warnings };
}

/**
 * Validate and, on failure, terminate. Called once from server startup.
 * Prints variable names and reasons only — never values.
 */
export function assertEnvOrExit(
  env: NodeJS.ProcessEnv = process.env,
  exit: (code: number) => never = process.exit as (code: number) => never,
): void {
  const result = validateEnv(env);

  for (const warning of result.warnings) {
    console.warn(`[env] WARN ${warning.variable}: ${warning.detail}`);
  }

  if (result.ok) return;

  console.error('[env] FATAL — refusing to start with an invalid environment:');
  for (const error of result.errors) {
    console.error(`[env]   ${error.code} → ${error.variable}: ${error.detail}`);
  }
  console.error('[env] Set the variables above (values are never logged) and restart.');
  exit(1);
}
