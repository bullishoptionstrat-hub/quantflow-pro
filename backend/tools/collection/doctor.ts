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
 *   npx tsx tools/collection/doctor.ts --probe               # + ask the vendors
 *   npx tsx tools/collection/doctor.ts --url http://localhost:3001
 *
 * With `--url` it also reads a running backend's `/api/health`, which is the
 * only way to know what is actually connected rather than what could be — and
 * that reading now reaches the verdict. It used to be printed below a verdict
 * computed without it, so a run could show `[  ok  ] ... and credentialed`
 * above `recordable sources connected: none` and conclude the first.
 *
 * With `--probe` it asks each permitted, credentialed vendor whether the key
 * actually fetches the endpoint this pipeline uses. A config-only run cannot
 * know that and no longer implies it: `credentialed` is a test of whether a
 * variable is set, and a free plan answering `403 NOT_AUTHORIZED` to every
 * request passes it.
 */
// Before the import graph, for the same reason `server.ts` does it on its
// first line: `src/ingestion/index` reads `process.env` at module scope, and
// with `module: commonjs` that read happens during the `import` below — before
// any statement in this file could have populated it. Without this, a
// developer with a fully configured `backend/.env` was told every persistable
// source lacked credentials, by the one tool whose job is answering that.
import 'dotenv/config';

import {
  classifySource, resolveBusinessMode, BusinessModeError,
  datasetIdForSource, type BusinessMode,
} from '../../src/provenance/rights';
import { CONNECTOR_CREDENTIALS } from '../../src/ingestion/index';
import { HORIZON_OFFSETS_MS } from '../../src/persistence/grader';
import {
  probeEntitlement, hasProbe, probeBasis, UNPROBED_REASONS,
  type EntitlementResult, type EntitlementState,
} from '../../src/ingestion/entitlement';
import { mayOperateConnector } from '../../src/provenance/rights';
import { markSourceStandings } from '../../src/ingestion/markSources';
import { classifyServiceKey } from '../../src/persistence/serviceKey';

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

/** The connector source string behind that variable, for the probe registry. */
const MARK_SOURCE = 'twelvedata';

/**
 * The rights question the doctor reports and does not enforce.
 *
 * `TWELVEDATA_QUOTES` is UNVERIFIED for PERSIST. Re-read 2026-09-21: the cap
 * in 16.1 is "duration permitted by subscription", 2.3 bars storing beyond the
 * timeframes "specified in the Documentation" — defined in Section 1 as the
 * guide at twelvedata.com/docs — and that guide names no retention timeframe
 * at all. So the clause resolves to nothing and no further reading will move
 * it. Every persisted outcome derives from that
 * source, so the whole track record rests on it.
 *
 * It is reported rather than refused because the connector gate deliberately
 * refuses PROHIBITED only — widening it to UNVERIFIED would collapse DISPLAY
 * and PERSIST into one decision, which `connectorGate.test.ts` keeps a canary
 * against. An operator can answer this; the code cannot.
 */
const MARK_SOURCE_RIGHTS_NOTE =
  'Twelve Data is UNVERIFIED for PERSIST, and as of the 2026-09-21 reading that ' +
  'is a measured verdict rather than an unread one. Storing is granted — 2.2(a) ' +
  'licenses storing Data for Internal Use. The duration is not: 16.1 caps ' +
  'retention at the subscription\'s permitted duration and 2.3 bars storing ' +
  'beyond the timeframes "specified in the Documentation" — a term Section 1 ' +
  'defines as the guide at twelvedata.com/docs, which names no retention ' +
  'timeframe at all. A cap pointing at a ' +
  'silent document is neither permission nor prohibition. Every graded outcome ' +
  'derives from this source, so the whole track record rests on it.';

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
    // Not `ok`, and this is the line the whole entitlement change exists for.
    //
    // What this branch establishes is that a variable is set. It was reported
    // as though it established that a feed is available, and a free Polygon
    // plan that answers `403 NOT_AUTHORIZED` to every request this pipeline
    // makes sat behind it reading "permitted for PERSIST and credentialed" —
    // in the one program an operator opens *because* they are already unsure
    // which keys are live. Three `BLOCKED` lines were true and the
    // reassurance was the part that was wrong.
    //
    // So a config-only run now says what it actually checked. `--probe` is
    // what converts this warn into an `ok`, or into the blocker it was hiding.
    checks.push({
      name: 'A source permitted to persist',
      status: 'warn',
      detail: `${configured.join(', ')} — permitted for PERSIST in ${mode} and ` +
              `credentialed. Entitlement has NOT been checked against the vendor: ` +
              `this is a test of whether the variable is set, not of whether the ` +
              `key fetches anything.`,
      fix: 'Re-run with --probe to ask each vendor directly. A key can be present, ' +
           'correct, and entitled to nothing this pipeline requests — that is a ' +
           'real finding from this deployment, not a hypothetical.',
    });
  }

  // ── 3. Somewhere for it to go ─────────────────────────────────────────────
  //
  // The third instance of the same shape, and still the one not closed by a
  // probe. "records survive a restart" was a capability claim built from two
  // set strings — checks 2 and 4 made exactly that move and this tool refuses
  // it there.
  //
  // It is *narrower* now without being probed. `classifyServiceKey` reads the
  // credential's own claims offline and can prove several configurations wrong
  // outright: a publishable or anon key in the service slot (the two sit
  // adjacent in the Supabase dashboard, and the history tables force RLS with
  // no policies, so that key writes nothing), a lapsed key, or a key issued for
  // a different project than SUPABASE_URL names. Each of those is now `blocked`
  // rather than a `warn` an operator would read past.
  //
  // What it still does **not** do is confirm the success path. That needs a
  // real `SUPABASE_SERVICE_KEY` to measure "this key writes signal_history"
  // against, and a key whose shape is right is not a key that works. So the
  // right-shape branch stays a `warn` with the same sentence it always had —
  // see ROADMAP 1.1c, which this narrows and does not close.
  const durable = has(env, ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY']);
  const keyVerdict = classifyServiceKey(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY);
  checks.push(!durable ? {
    name: 'Durable storage',
    status: 'blocked',
    detail: 'The signal history is in memory and is lost on every restart.',
    fix: 'Set SUPABASE_URL and SUPABASE_SERVICE_KEY. Until then nothing accumulates, ' +
         'however long the process runs.',
  } : !keyVerdict.usable ? {
    name: 'Durable storage',
    status: 'blocked',
    detail: `Both variables are set, and the credential in SUPABASE_SERVICE_KEY cannot ` +
            `write.\n          ${keyVerdict.reason}\n          Basis: ${keyVerdict.basis}`,
    fix: 'Copy the service_role key (Supabase dashboard → Project Settings → API → ' +
         'Service role, or an sb_secret_ key) into SUPABASE_SERVICE_KEY. This is the ' +
         'one failure here that looks exactly like success: the client constructs, ' +
         'every insert is refused by RLS, and nothing reports an error.',
  } : {
    name: 'Durable storage',
    status: 'warn',
    detail: `SUPABASE_URL and SUPABASE_SERVICE_KEY are set and the credential's shape ` +
            `is right (${keyVerdict.shape}). Whether they reach a project, and whether ` +
            `the key can write the four history tables, has not been checked here.`,
    fix: 'Watch `signal_write_incidents` and /api/health `history.durable` after the ' +
         'first real signal — a revoked key or a project missing the migrations passes ' +
         'this check and fails every write.',
  });

  // ── 4. A mark to grade against ────────────────────────────────────────────
  //
  // This used to test one variable and name it as the blocker, because the
  // grader took its price from one hard-wired vendor. It resolves from a ranked
  // registry now, so the question is "is any source able to price an
  // underlying?" and the useful answer lists the candidates and says why each
  // is in or out — "no mark source" on its own sends an operator looking for a
  // setting that may not be the one missing.
  const standings = markSourceStandings(env);
  const usableMarks = standings.filter((m) => m.usable);
  const describe = (m: (typeof standings)[number]) =>
    `${m.source} (${m.rightsClass}${m.usable ? '' : ', unusable'}) — ${m.reason}`;

  checks.push(usableMarks.length > 0 ? {
    // `warn`, not `ok`: a usable source is one whose rights permit it and whose
    // key is set. Whether that key fetches a price is a different question, and
    // asserting it from configuration is the defect this tool was rebuilt to
    // stop making — see check 2.
    name: 'Underlying marks for grading',
    status: 'warn',
    detail: `${usableMarks.length} of ${standings.length} mark source(s) could price an ` +
            `underlying: ${usableMarks.map((m) => m.source).join(', ')}. Whether any of ` +
            `them actually returns a price has not been asked.\n          ` +
            standings.map(describe).join('\n          '),
    fix: 'Re-run with --probe. The registry is short by design — a vendor path that ' +
         'has never returned a price is not a fallback — so a single refusal here ' +
         'still grades nothing.',
  } : {
    name: 'Underlying marks for grading',
    status: 'blocked',
    detail: `No registered mark source can price an underlying, so every outcome ` +
            `returns UNGRADED ("No usable entry mark").\n          ` +
            standings.map(describe).join('\n          '),
    fix: 'Each line above says whether the obstacle is rights or credentials. A ' +
         'source refused on rights will not start when a key is supplied — that is ' +
         'the distinction worth reading before setting anything.',
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
    // The previous fix text said "check Section 16.1". That has now been done,
    // and the answer is that it cannot be checked from the published terms —
    // so repeating the instruction would send an operator to read a page this
    // repo has already established is silent on the point. What is actionable
    // is narrower and is named here instead.
    fix: 'Two things, and only the first is yours to do. (1) Ask Twelve Data, in ' +
         'writing, what retention duration your plan permits — 16.1 defers to the ' +
         'subscription and 2.3 defers to the Documentation at ' +
         'twelvedata.com/docs, which states no retention timeframe, so the vendor is the only source of this answer. ' +
         'Their reply is what would move this entry to PERMITTED; nothing in the ' +
         'published terms can. (2) If the answer is a finite window, or if you ' +
         'ever terminate the subscription — 16.2 requires all Data deleted within ' +
         '30 days — the outcomes table needs a retention policy and the code has ' +
         'none. The shape is recorded in rights.ts: expire the raw entry/exit ' +
         'marks, which are the vendor\'s Data, and keep label and the directional ' +
         'return, which ' +
         'are Derived Data under 2.2(c). Note it collides with the append-only ' +
         'trigger on signal_outcomes — see docs/SYSTEM_INVARIANTS.md.',
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

/**
 * The persistable sources this environment could actually be asked about.
 *
 * Exported so `main()` probes exactly what check 2 counted, rather than
 * recomputing the rights decision with a second copy of the rule. It is also
 * the rights gate for the probe: **a probe is a request**, and `startConnector`
 * runs `mayOperateConnector` before `start()` precisely because the request
 * itself is the act a publisher's terms govern. Filtering on
 * `classifySource(s, 'PERSIST', mode).allowed` here is what keeps a refused
 * vendor from being contacted by the diagnostic that reports it as refused.
 */
export function probeTargets(env: NodeJS.ProcessEnv = process.env): string[] {
  let mode: BusinessMode;
  try {
    mode = resolveBusinessMode(env);
  } catch {
    // A mode we cannot resolve is a rights decision we cannot make, and
    // `runChecks` already stops the report there. Contacting nobody is right.
    return [];
  }
  return RECORDABLE_SOURCES.filter(
    (s) => classifySource(s, 'PERSIST', mode).allowed && has(env, credentialsFor(s)),
  );
}

/**
 * The grader's mark source, which is probed on a **different gate**.
 *
 * `probeTargets` filters on `classifySource(s, 'PERSIST', mode).allowed`, and
 * Twelve Data is `UNVERIFIED` for PERSIST in both modes — so that filter
 * correctly excludes it and would never probe the one source every graded
 * outcome derives from. The gate that governs whether the *request* may be
 * made is the connector gate, `mayOperateConnector`, which refuses `PROHIBITED`
 * only and is what `startConnector` runs before opening any socket. A probe
 * makes the same request the connector makes, so it passes the same gate.
 *
 * The PERSIST question is not dropped by doing this — it is check 4b, which
 * has always reported it and still does. This asks a different question: not
 * "may the answer be kept?" but "is there an answer?".
 */
export function markProbeTarget(env: NodeJS.ProcessEnv = process.env): string | null {
  let mode: BusinessMode;
  try {
    mode = resolveBusinessMode(env);
  } catch {
    return null;
  }
  // Read off the registry rather than a constant, so adding a mark source does
  // not leave the probe asking about the one that used to be hard-wired. Best
  // rights standing first — `markSourceStandings` is already in that order.
  const best = markSourceStandings(env, mode).find((m) => m.usable);
  if (!best) return null;
  if (!mayOperateConnector(best.source, mode).allowed) return null;
  return best.source;
}

/**
 * What the mark vendor said.
 *
 * No "one is enough" here, unlike the feed: `startSignalHistory` passes the
 * grader `getSpotPrice` and nothing else, so this is not one of several — it is
 * the only one. A refusal blocks every grade.
 */
export function markProbeCheck(result: EntitlementResult | null): Check[] {
  if (result === null) {
    return [{
      name: 'Mark source entitlement',
      status: 'warn',
      detail: `${MARK_SOURCE} was not probed — it is either uncredentialed or ` +
              `refused by the connector gate in this mode.`,
      fix: 'Check 4 above names the variable. Until it is set there is no key to ask ' +
           'about, and the grader has no price source at all.',
    }];
  }

  const line = `${result.source}: ${result.state} — ${result.detail}`;
  if (result.state === 'entitled') {
    return [{ name: 'Mark source entitlement', status: 'ok', detail: line }];
  }
  if (result.state === 'refused' || result.state === 'rejected') {
    return [{
      name: 'Mark source entitlement',
      status: 'blocked',
      detail: line,
      fix: 'The grader has exactly one price source, so this is not a degraded ' +
           'feed — it is every outcome returning UNGRADED ("No usable entry ' +
           'mark") while the options feed looks perfectly healthy. ' +
           (probeBasis(MARK_SOURCE) ?? ''),
    }];
  }
  return [{
    name: 'Mark source entitlement',
    status: 'warn',
    detail: line,
    fix: 'Not refused and not confirmed. An unreachable vendor is not evidence ' +
         'of a missing entitlement, so no conclusion is drawn from it. ' +
         (probeBasis(MARK_SOURCE) ?? ''),
  }];
}

/**
 * What the vendors said, as a check that counts.
 *
 * The state → status mapping is deliberately asymmetric:
 *
 *   - `entitled`     → ok. One working feed is all collection needs.
 *   - `refused`      → BLOCKED. The plan does not cover the data. This is the
 *                      state that was invisible, and it is the reason this
 *                      function exists.
 *   - `rejected`     → BLOCKED. The key is wrong or revoked. Different remedy
 *                      from `refused`, same consequence for collection.
 *   - everything else → warn, never blocked. **An unreachable vendor is not
 *                      evidence of no entitlement.** Promoting a timeout to a
 *                      blocker turns a flaky network — or an airport wifi
 *                      captive portal — into "this deployment cannot collect",
 *                      which is the same class of confidently-wrong answer the
 *                      probe was written to remove.
 */
export function probeChecks(results: readonly EntitlementResult[]): Check[] {
  if (results.length === 0) {
    return [{
      name: 'Vendor entitlement',
      status: 'warn',
      detail: 'No source was probed — none is both permitted for PERSIST and credentialed.',
      fix: 'Check 2 above says which variables would give this deployment a ' +
           'persistable source. Until one is set there is no vendor to ask.',
    }];
  }

  const line = (r: EntitlementResult) => `${r.source}: ${r.state} — ${r.detail}`;
  const by = (st: EntitlementState) => results.filter((r) => r.state === st);

  const entitled = by('entitled');
  const denied = [...by('refused'), ...by('rejected')];

  if (entitled.length > 0) {
    return [{
      name: 'Vendor entitlement',
      status: 'ok',
      detail: [...entitled, ...denied].map(line).join('\n          '),
    }];
  }

  if (denied.length > 0) {
    return [{
      name: 'Vendor entitlement',
      status: 'blocked',
      detail: results.map(line).join('\n          '),
      fix: 'A `refused` source has a plan that does not cover the endpoint this ' +
           'pipeline requests — upgrade it or use a different vendor. A `rejected` ' +
           'source has a key to reissue. The two are kept apart because rotating a ' +
           'credential that was always correct is an afternoon spent on the wrong ' +
           'problem. ' + citations(results),
    }];
  }

  return [{
    name: 'Vendor entitlement',
    status: 'warn',
    detail: results.map(line).join('\n          '),
    fix: 'Nothing here was refused, and nothing was confirmed either. An ' +
         'unreachable or unprobed source is not a failing one — it is one this ' +
         'run could not ask, so no conclusion about the plan is drawn from it. ' +
         citations(results),
  }];
}

/** Say where each mapping came from, so a reader can weigh the verdict. */
function citations(results: readonly EntitlementResult[]): string {
  const parts = results.map((r) => {
    if (!hasProbe(r.source)) {
      return `${r.source}: ${UNPROBED_REASONS[r.source] ?? 'no probe defined.'}`;
    }
    return `${r.source}: ${probeBasis(r.source)}`;
  });
  return `Basis — ${parts.join(' ')}`;
}

/**
 * The live board, as a check that counts.
 *
 * `readLive` has always fetched this and `main` has always printed it. It never
 * reached the verdict: `blocked` was computed from the config checks alone, so
 * a run could print `[  ok  ] ... and credentialed` and, a dozen lines below,
 * `recordable sources connected: none` — and still conclude that two of six
 * conditions were the problem. The tool fetched its own refutation and did not
 * count it. This is the counting.
 */
export function liveChecks(live: LiveState): Check[] {
  const checks: Check[] = [];

  checks.push(live.connectedRecordable.length > 0 ? {
    name: 'A source actually delivering',
    status: 'ok',
    detail: `${live.connectedRecordable.join(', ')} — connected, per /api/health.`,
  } : {
    name: 'A source actually delivering',
    status: 'blocked',
    detail: 'No recordable source reports `connected` on the running backend. ' +
            'Whatever the configuration says, nothing persistable is arriving.',
    fix: 'Read /api/health `sourceErrors` for the named reason per source — it ' +
         'carries the vendor\'s own words. A source can be `disabled` (no ' +
         'credentials), `refused` (the rights gate declined to make the request ' +
         'at all, which is not a fault), or `error` (the vendor answered, badly).',
  });

  // Not a separate condition — a restated one, with the number that proves it.
  // Synthetic rows are counted where a reader can see them and never enter a
  // published rate, so a recorder busily writing them is not progress.
  if (live.recorded > 0 && live.recorded === live.syntheticRecorded) {
    checks.push({
      name: 'Something real in the record',
      status: 'blocked',
      detail: `All ${live.recorded} recorded signals are synthetic, and ${live.graded} ` +
              `outcomes are graded. No rate can be published from this.`,
      fix: 'Synthetic covers simulated, replayed and chain-derived signals. The ' +
           'simulation feed runs whenever no live vendor feed does, so this number ' +
           'climbing is the sign of an empty pipeline, not a filling one.',
    });
  }

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
  // Gathered first, printed second. The old order printed the config checks,
  // then fetched the live state and printed it underneath — which is how a run
  // could show `[  ok  ] ... and credentialed` above `recordable sources
  // connected: none` and still report the verdict from the top half alone.
  // Everything that can block now lands in one list before anything is said.
  const checks = runChecks();

  const url = arg('--url');
  const wantsProbe = process.argv.includes('--probe');

  if (wantsProbe) {
    const targets = probeTargets();
    const results = await Promise.all(
      targets.map((source) => probeEntitlement(source, process.env)),
    );
    checks.push(...probeChecks(results));

    // The feed and the mark are two independent entitlements, and the second
    // is the one nobody guesses: a deployment can have a licensed options feed
    // and still grade nothing, because the mark comes from a different vendor.
    const mark = markProbeTarget();
    checks.push(...markProbeCheck(
      mark ? await probeEntitlement(mark, process.env) : null,
    ));
  }

  let live: LiveState | null = null;
  let liveFailure: string | null = null;
  if (url) {
    try {
      live = await readLive(url);
      checks.push(...liveChecks(live));
    } catch (err: any) {
      // A backend we could not reach is not a backend with no sources. This
      // stays out of `checks` for the same reason `unreachable` is never a
      // blocker: it is an absence of evidence, reported as one.
      liveFailure = err?.message ?? String(err);
    }
  }

  console.log('\nCan this deployment accumulate a track record?\n');
  for (const c of checks) {
    console.log(`[${MARK[c.status]}] ${c.name}`);
    console.log(`          ${c.detail}`);
    if (c.fix) console.log(`          → ${c.fix}`);
    console.log();
  }

  if (live) {
    console.log('Live, from /api/health:');
    console.log(`  recordable sources connected: ${live.connectedRecordable.join(', ') || 'none'}`);
    console.log(`  store: ${live.storeKind} (durable: ${live.durable})`);
    console.log(`  recorded: ${live.recorded}, of which synthetic: ${live.syntheticRecorded}`);
    console.log(`  graded outcomes: ${live.graded}`);
    console.log();
  } else if (liveFailure) {
    console.log(`Live check failed: ${liveFailure}`);
    console.log('  → no conclusion is drawn from this. An unreachable backend is not');
    console.log('    a backend with nothing connected.\n');
  }

  if (!wantsProbe) {
    console.log('No vendor was asked anything on this run. Add --probe to check that');
    console.log('a credentialed source is actually entitled to the data it requests.\n');
  }

  const blocked = checks.filter((c) => c.status === 'blocked');
  if (blocked.length === 0) {
    console.log('Verdict: a real signal recorded now would reach a graded outcome.');
    console.log('         Read the warnings above before trusting that. Longevity bites');
    console.log('         silently, and without --probe nothing here has asked a vendor');
    console.log('         whether the key it issued still fetches anything.\n');
  } else {
    console.log(`Verdict: no. ${blocked.length} of ${checks.length} conditions block collection:`);
    for (const c of blocked) console.log(`         - ${c.name}`);
    console.log('\n         Every one must hold. Fixing some of them changes nothing observable,');
    console.log('         which is why this reports all of them rather than the first.\n');
    process.exitCode = 1;
  }
}

if (require.main === module) void main();
