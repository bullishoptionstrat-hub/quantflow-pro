/**
 * Would a signal recorded right now ever be graded?
 *
 * `/api/track-record` currently reports `total: 78, synthetic: 78, real: 0`
 * and a grader that has tracked nothing. That is the correct output — it says
 * so, in its own notes — but it does not say *why*, and the why is six
 * independent conditions that must all hold before a single outcome exists.
 * Three of them are invisible from the code and one is invisible from the
 * codebase entirely (the host sleeping). An operator reading "0 real" cannot
 * tell whether they are one API key away or five.
 *
 * The evidence apparatus is complete and correct — the rights gate, decision
 * time, content-hash identity, the M15/H1/D1 grader, the n>=30 refusal — and
 * `test/historyIntegration.test.ts` already proves the loop closes end to end
 * in memory. Nothing here is about the code being wrong. It is about a
 * deployment being silently unable to accumulate the one thing the product
 * exists to accumulate.
 *
 *   npx tsx tools/collection/doctor.ts                     # config only
 *   npx tsx tools/collection/doctor.ts --url http://localhost:3001
 *
 * With `--url` it also reads a running backend's `/api/health`, which is the
 * only way to know what is actually connected rather than what could be.
 */
import {
  classifySource, resolveBusinessMode, BusinessModeError,
  datasetIdForSource, type BusinessMode,
} from '../../src/provenance/rights';
import { CONNECTOR_CREDENTIALS } from '../../src/ingestion/index';
import { HORIZON_OFFSETS_MS } from '../../src/persistence/grader';

export type Status = 'ok' | 'blocked' | 'warn';

export interface Check {
  name: string;
  status: Status;
  /** What is true right now. */
  detail: string;
  /** What to do about it. Absent when nothing needs doing. */
  fix?: string;
}

/**
 * The grader's only source of an underlying mark.
 *
 * `startSignalHistory` passes it `getSpotPrice`, which reads Twelve Data's
 * cache and nothing else. Two other spot sources exist and neither may stand
 * in: Yahoo prohibits automated access outright, and Finnhub — which does fill
 * the *display* board — forbids sharing "data or derived results" with a third
 * party, which is what a published track record is. Adding either as a
 * fallback would route around a quoted restriction.
 *
 * So without this key every outcome comes back UNGRADED with "No usable entry
 * mark", which is honest and completely opaque if you do not know where the
 * mark comes from.
 */
const SPOT_SOURCE_VAR = 'TWELVE_DATA_API_KEY';

/**
 * The rights question the doctor reports and does not enforce.
 *
 * `TWELVEDATA_QUOTES` is UNVERIFIED for PERSIST: its terms cap retention at
 * "duration permitted by subscription", and what this deployment's
 * subscription permits is not established. Every persisted outcome derives
 * from that source, so the whole track record rests on it.
 *
 * It is reported rather than refused because the connector gate deliberately
 * refuses PROHIBITED only — widening it to UNVERIFIED would collapse DISPLAY
 * and PERSIST into one decision, which `connectorGate.test.ts` keeps a canary
 * against. An operator can answer this; the code cannot.
 */
const MARK_SOURCE_RIGHTS_NOTE =
  'Twelve Data is UNVERIFIED for PERSIST: retention is capped at "duration ' +
  'permitted by subscription" (terms read 2026-09-03), and this deployment\'s ' +
  'subscription is not established here. Every graded outcome derives from it. ' +
  'Establish what your plan permits before publishing a track record.';

/** Connector source strings that could ever be recorded, per the registry. */
const RECORDABLE_SOURCES = [
  'tradier', 'polygon', 'marketdata', 'schwab', 'tastytrade',
] as const;

/** Which env vars a recordable source needs, from the credentials table. */
function credentialsFor(source: string): readonly string[] {
  return CONNECTOR_CREDENTIALS[source] ?? [];
}

function has(env: NodeJS.ProcessEnv, keys: readonly string[]): boolean {
  return keys.length > 0 && keys.every((k) => (env[k] ?? '').trim().length > 0);
}

export function runChecks(env: NodeJS.ProcessEnv = process.env): Check[] {
  const checks: Check[] = [];

  // ── 1. The mode every rights decision is made in ──────────────────────────
  let mode: BusinessMode | null = null;
  try {
    mode = resolveBusinessMode(env);
    checks.push({
      name: 'Business mode',
      status: 'ok',
      detail: `${mode}${env.BUSINESS_MODE ? '' : ' (default — BUSINESS_MODE is unset)'}`,
    });
  } catch (err) {
    checks.push({
      name: 'Business mode',
      status: 'blocked',
      detail: err instanceof BusinessModeError ? err.message : String(err),
      fix: 'Set BUSINESS_MODE to PRIVATE_RESEARCH or PUBLIC_COMMERCIAL, or unset it.',
    });
    // Everything downstream is a rights decision, so there is nothing further
    // to say that would be true.
    return checks;
  }

  // ── 2. A source whose data may be kept ────────────────────────────────────
  const permitted = RECORDABLE_SOURCES.filter(
    (s) => classifySource(s, 'PERSIST', mode!).allowed,
  );
  const configured = permitted.filter((s) => has(env, credentialsFor(s)));

  if (permitted.length === 0) {
    checks.push({
      name: 'A source permitted to persist',
      status: 'blocked',
      detail: `No source is PERMITTED for PERSIST in ${mode}.`,
      fix: `In ${mode} every candidate is UNVERIFIED or PROHIBITED. PRIVATE_RESEARCH ` +
           `permits the broker and licensed APIs; PUBLIC_COMMERCIAL permits none of ` +
           `them until their redistribution terms are established.`,
    });
  } else if (configured.length === 0) {
    checks.push({
      name: 'A source permitted to persist',
      status: 'blocked',
      detail: `${permitted.length} source(s) may be persisted in ${mode} ` +
              `(${permitted.join(', ')}) and none has credentials.`,
      fix: `Set the variables for one of them: ` +
           permitted.map((s) => `${s} → ${credentialsFor(s).join(' + ') || '(none listed)'}`).join('; ') + '.',
    });
  } else {
    checks.push({
      name: 'A source permitted to persist',
      status: 'ok',
      detail: `${configured.join(', ')} — permitted for PERSIST in ${mode} and credentialed.`,
    });
  }

  // ── 3. Somewhere for it to go ─────────────────────────────────────────────
  const durable = has(env, ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY']);
  checks.push(durable ? {
    name: 'Durable storage',
    status: 'ok',
    detail: 'SUPABASE_URL and SUPABASE_SERVICE_KEY are set — records survive a restart.',
  } : {
    name: 'Durable storage',
    status: 'blocked',
    detail: 'The signal history is in memory and is lost on every restart.',
    fix: 'Set SUPABASE_URL and SUPABASE_SERVICE_KEY. Until then nothing accumulates, ' +
         'however long the process runs.',
  });

  // ── 4. A mark to grade against ────────────────────────────────────────────
  const spot = has(env, [SPOT_SOURCE_VAR]);
  checks.push(spot ? {
    name: 'Underlying marks for grading',
    status: 'ok',
    detail: `${SPOT_SOURCE_VAR} is set — the grader can price an underlying.`,
  } : {
    name: 'Underlying marks for grading',
    status: 'blocked',
    detail: `${SPOT_SOURCE_VAR} is unset, and TwelveData's cache is the grader's only ` +
            `price source. Every outcome returns UNGRADED ("No usable entry mark").`,
    fix: `Set ${SPOT_SOURCE_VAR}. This one is easy to miss: a deployment can have a ` +
         `licensed options feed and durable storage and still grade nothing, because ` +
         `the mark comes from a different connector entirely.`,
  });

  // ── 4b. Whether the mark source may be kept at all ────────────────────────
  //
  // Not a blocker: it is a question only the operator can answer, and the code
  // deliberately does not refuse on it. But a track record published from a
  // source whose retention terms are unestablished is the kind of thing this
  // tool exists to surface before it matters.
  checks.push({
    name: 'Mark source retention rights',
    status: 'warn',
    detail: MARK_SOURCE_RIGHTS_NOTE,
    fix: 'Check your Twelve Data plan against Section 16.1 (Retention Limits) at ' +
         'https://twelvedata.com/terms. If it does not permit indefinite retention, ' +
         'the outcomes table needs a retention policy — the code has none.',
  });

  // ── 5. Long enough to see the shortest horizon ────────────────────────────
  const shortest = Math.min(...Object.values(HORIZON_OFFSETS_MS));
  checks.push({
    name: 'Process longevity',
    status: 'warn',
    detail: `The shortest horizon is ${Math.round(shortest / 60_000)} minutes from ` +
            `decisionAt, and Render's free tier sleeps a service after 15 minutes idle.`,
    fix: 'A sleeping process misses its own checkpoints, and the grader refuses to ' +
         'grade one that arrives late rather than measuring a 15-minute label against ' +
         'a six-hour move. Either keep the service warm or expect M15 to stay ' +
         'UNGRADED on the free tier. This is a hosting fact, not a setting.',
  });

  return checks;
}

// ─── Live state, when a backend is reachable ────────────────────────────────

export interface LiveState {
  connectedRecordable: string[];
  storeKind: string;
  durable: boolean;
  recorded: number;
  syntheticRecorded: number;
  graded: number;
}

export async function readLive(base: string): Promise<LiveState> {
  const res = await fetch(`${base.replace(/\/+$/, '')}/api/health`, {
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`/api/health returned ${res.status}`);
  const h: any = await res.json();

  const sources: Record<string, string> = h?.ingestion?.sources ?? {};
  return {
    connectedRecordable: RECORDABLE_SOURCES.filter((s) => sources[s] === 'connected'),
    storeKind: h?.history?.store ?? 'unknown',
    durable: Boolean(h?.history?.durable),
    recorded: h?.history?.recorder?.recorded ?? 0,
    syntheticRecorded: h?.history?.recorder?.syntheticRecorded ?? 0,
    graded: h?.history?.grader?.graded ?? 0,
  };
}

// ─── Reporting ──────────────────────────────────────────────────────────────

const MARK: Record<Status, string> = { ok: '  ok  ', 'blocked': 'BLOCKED', warn: ' warn ' };

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const checks = runChecks();

  console.log('\nCan this deployment accumulate a track record?\n');
  for (const c of checks) {
    console.log(`[${MARK[c.status]}] ${c.name}`);
    console.log(`          ${c.detail}`);
    if (c.fix) console.log(`          → ${c.fix}`);
    console.log();
  }

  const url = arg('--url');
  if (url) {
    try {
      const live = await readLive(url);
      console.log('Live, from /api/health:');
      console.log(`  recordable sources connected: ${live.connectedRecordable.join(', ') || 'none'}`);
      console.log(`  store: ${live.storeKind} (durable: ${live.durable})`);
      console.log(`  recorded: ${live.recorded}, of which synthetic: ${live.syntheticRecorded}`);
      console.log(`  graded outcomes: ${live.graded}`);
      // Recording synthetic signals is not progress toward a track record;
      // they are counted where a reader can see them and never enter a rate.
      if (live.recorded > 0 && live.recorded === live.syntheticRecorded) {
        console.log('  → everything recorded so far is synthetic, so no rate can be published.');
      }
      console.log();
    } catch (err: any) {
      console.log(`Live check failed: ${err?.message ?? err}\n`);
    }
  }

  const blocked = checks.filter((c) => c.status === 'blocked');
  if (blocked.length === 0) {
    console.log('Verdict: a real signal recorded now would reach a graded outcome.');
    console.log('         Watch the longevity warning above — it is the one that bites silently.\n');
  } else {
    console.log(`Verdict: no. ${blocked.length} of ${checks.length} conditions block collection:`);
    for (const c of blocked) console.log(`         - ${c.name}`);
    console.log('\n         Every one must hold. Fixing some of them changes nothing observable,');
    console.log('         which is why this reports all of them rather than the first.\n');
    process.exitCode = 1;
  }
}

if (require.main === module) void main();
