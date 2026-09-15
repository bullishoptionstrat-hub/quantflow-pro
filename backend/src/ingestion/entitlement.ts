/**
 * Does the vendor honour the key we hold?
 *
 * Every credential check in this codebase asks whether a variable is set.
 * `CONNECTOR_CREDENTIALS` asks it, `missingCredentials()` asks it, and
 * `tools/collection/doctor.ts` asked it and then reported the answer as though
 * it were "is the feed available?" — so a free Polygon plan that returns
 * `403 NOT_AUTHORIZED` to every request the pipeline makes was reported as the
 * one source permitted for PERSIST **and credentialed**. `credentialed` is not
 * `entitled`, and the difference is not visible from anywhere in this tree:
 * the variable is set, the registry entry is right, the mode really does
 * permit the source. The only false thing is an assumption nobody wrote down,
 * that a vendor honours the key it issued.
 *
 * That assumption is only checkable by asking. This module asks.
 *
 * Three rules it inherits from mistakes already recorded in CLAUDE.md:
 *
 *   1. **A probe is a request, and a request is the act a publisher's terms
 *      govern.** `startConnector` runs the rights gate before `start()` for
 *      exactly this reason. Callers must probe only sources that clear
 *      `classifySource(source, 'PERSIST', mode).allowed` — this module does
 *      not gate, because it does not know the caller's mode, so the obligation
 *      is the caller's and is stated here rather than assumed.
 *
 *   2. **Status codes do not mean the same thing at every vendor.**
 *      `httpError.ts` already argues this: "a bare HTTP 403 does not
 *      distinguish 'wrong key' from 'your plan lacks this endpoint' from 'no
 *      data for that symbol', and guessing between them in code is how the
 *      health route ends up confidently wrong." So the status → state mapping
 *      is **per source**, declared next to the endpoint it describes, and says
 *      whether it was measured or read off the vendor's documentation. There
 *      is deliberately no shared `403 means refused` switch.
 *
 *   3. **A source with no probe is `unprobed`, never `entitled`.** Uncertainty
 *      resolves to "we do not know", the same way `UNVERIFIED` never resolves
 *      to permitted in `provenance/rights.ts`. Three of the five recordable
 *      sources have no probe here yet and must not inherit a pass.
 *
 * No function here reads `process.env` at module scope. The doctor's whole
 * first bug was a module doing that during an `import` (CLAUDE.md, twice), and
 * a diagnostic that cannot be handed a synthetic environment cannot be tested.
 */
import axios from 'axios';
import { describeHttpError } from './httpError';
import {
  mayOperateConnector, resolveBusinessMode, type BusinessMode,
} from '../provenance/rights';

/**
 * What asking the vendor established.
 *
 * `refused` and `rejected` are both "this key will not fetch that data", and
 * they are kept apart because the remedy is completely different: `refused` is
 * a plan to upgrade, `rejected` is a key to reissue. Collapsing them is how an
 * operator spends an afternoon rotating a credential that was always correct.
 */
export type EntitlementState =
  /** The vendor served the endpoint the pipeline actually uses. */
  | 'entitled'
  /** Credentials accepted, data withheld — a plan that does not cover it. */
  | 'refused'
  /** Credentials not accepted — wrong, revoked, or for another environment. */
  | 'rejected'
  /** No answer: DNS, timeout, reset. Says nothing either way about the plan. */
  | 'unreachable'
  /** An answer we have not established the meaning of at this vendor. */
  | 'unknown'
  /** No probe exists for this source. Not a pass. */
  | 'unprobed';

export interface EntitlementResult {
  source: string;
  state: EntitlementState;
  /**
   * What the vendor said, via `describeHttpError` — which carries the body
   * (a bare status cannot tell these states apart) and scrubs anything
   * key-shaped, because several probes here put the key in the query string
   * and some vendors echo the URL back.
   */
  detail: string;
}

interface EntitlementProbe {
  /** The env vars the probe needs, so a caller can skip rather than 401. */
  needs: readonly string[];
  /** Built per call from the caller's env — never captured at module load. */
  request(env: NodeJS.ProcessEnv): { url: string; headers?: Record<string, string> };
  /**
   * This vendor's status codes, and only this vendor's.
   *
   * `null` means no response arrived at all. `body` is passed because a status
   * code is not always the answer: Twelve Data is documented to return an
   * error *envelope* under HTTP 200 on some endpoints, so a probe that read
   * the status alone would report `entitled` on a refusal. Probes that do not
   * need it ignore it.
   */
  classify(status: number | null, body?: unknown): EntitlementState;
  /** Where the mapping came from. Measured beats documented beats guessed. */
  basis: string;
}

const PROBES: Readonly<Record<string, EntitlementProbe>> = {
  /**
   * The endpoint `startPolygonIngestion` actually polls, at `limit=1`.
   *
   * Probing a *different* endpoint would answer a different question: a plan
   * can be entitled to aggregates and not to trades, which is precisely the
   * case that produced this module. The probe asks for the thing the pipeline
   * needs, not for something adjacent that happens to be cheaper.
   */
  polygon: {
    needs: ['POLYGON_API_KEY'],
    request: (env) => ({
      url: `https://api.polygon.io/v3/trades/options?limit=1&apiKey=${
        encodeURIComponent(env.POLYGON_API_KEY ?? '')}`,
    }),
    classify: (status) => {
      if (status === null) return 'unreachable';
      if (status === 200) return 'entitled';
      // Measured against api.polygon.io on 2026-09-13, all three by hand:
      //   403 → {"status":"NOT_AUTHORIZED", "message":"You are not entitled
      //          to this data. Please upgrade your plan..."}
      //   401 → {"status":"ERROR","error":"Unknown API Key"}          (bad key)
      //   401 → {"status":"ERROR","error":"API Key was not provided"} (no key)
      // So at this vendor the split is clean and it is not inferred.
      if (status === 403) return 'refused';
      if (status === 401) return 'rejected';
      // 429 is a rate limit, which is not an answer about the plan. Anything
      // else is a shape we have not seen; neither becomes a verdict.
      return 'unknown';
    },
    basis:
      'Measured directly against api.polygon.io on 2026-09-13: 403 carries ' +
      'NOT_AUTHORIZED ("you are not entitled to this data"), 401 carries ' +
      '"Unknown API Key" or "API Key was not provided".',
  },

  /**
   * A market-data call, deliberately **not** `/v1/user/profile`.
   *
   * `probeTradierToken` in `ingestion/index.ts` uses the profile endpoint, and
   * the comment above it records why an entitlement conclusion must not be
   * drawn from it: an earlier version read a streaming 401 as "no market-data
   * entitlement" and pointed an operator at the wrong problem. A profile is an
   * account fact; entitlement is a market-data fact. What is generalised from
   * that probe is its *shape* — ask the vendor, split more than two ways,
   * never log the token — and not its target.
   */
  tradier: {
    needs: ['TRADIER_TOKEN'],
    request: (env) => ({
      url: 'https://api.tradier.com/v1/markets/quotes?symbols=SPY',
      headers: {
        Authorization: `Bearer ${env.TRADIER_TOKEN ?? ''}`,
        Accept: 'application/json',
      },
    }),
    classify: (status) => {
      if (status === null) return 'unreachable';
      if (status === 200) return 'entitled';
      // Tradier's documented convention, quoted in `probeTradierToken`:
      // entitlement failures are 403 and credential failures are 401. This
      // mapping is READ, not measured — no production token has been held
      // here to check it against. If it turns out to be wrong, it is wrong in
      // the direction of naming the wrong remedy, not of inventing a pass.
      if (status === 403) return 'refused';
      if (status === 401) return 'rejected';
      return 'unknown';
    },
    basis:
      'Tradier documents entitlement failures as 403 and credential failures ' +
      'as 401 (the convention quoted in probeTradierToken). Documented, not ' +
      'measured here — no production token has been available to confirm it.',
  },

  /**
   * The grader's mark source — probed on a different gate from the others.
   *
   * `twelvedata` is not in `RECORDABLE_SOURCES`, so `probeTargets` never
   * reaches it, and that is correct: it is not an options feed. But check 4 of
   * the doctor asserted "TWELVE_DATA_API_KEY is set — the grader **can** price
   * an underlying" off the same string-emptiness test that produced the
   * finding this module exists for, twenty lines away in the same function. A
   * capability claim from a set variable is the identical defect whichever
   * check makes it.
   *
   * `/price` is what `getSpotPrice`'s cache is filled from, so this asks for
   * the thing the grader needs, and it asks for **SPY** because that is
   * `WATCHED[0]` in `connectors/twelveData.ts` — the probe should want a symbol
   * the connector really subscribes to, not an arbitrary liquid one.
   *
   * The caveat that comes with picking any single symbol: a plan scoped *by
   * symbol* rather than by capability will read as a blanket refusal here.
   * Observed while testing this, against Twelve Data's public `demo` key —
   * which serves AAPL and refuses SPY. That is the probe reporting the vendor
   * accurately (this deployment's grader does need SPY), but a `refused` here
   * means "not for the symbol asked", not necessarily "not for anything".
   */
  twelvedata: {
    needs: ['TWELVE_DATA_API_KEY'],
    request: (env) => ({
      url: `https://api.twelvedata.com/price?symbol=SPY&apikey=${
        encodeURIComponent(env.TWELVE_DATA_API_KEY ?? '')}`,
    }),
    classify: (status, body) => {
      if (status === null) return 'unreachable';
      // The envelope check comes first, and it is the reason `classify` takes
      // a body at all. Twelve Data returns `{"code":401,"status":"error",...}`
      // and is documented to do so under HTTP 200 on some endpoints. Reading
      // the status alone would call that `entitled`.
      const code = errorEnvelopeCode(body);
      if (code !== null) {
        if (code === 403) return 'refused';
        if (code === 401) return 'rejected';
        return 'unknown';
      }
      if (status === 200) return 'entitled';
      if (status === 403) return 'refused';
      if (status === 401) return 'rejected';
      return 'unknown';
    },
    basis:
      'Measured against api.twelvedata.com on 2026-09-14: a good key returns ' +
      'HTTP 200 {"price":"..."}, a wrong or absent key returns HTTP 401 with ' +
      '{"code":401,"status":"error"}. The HTTP-200-with-error-envelope branch ' +
      'is defensive — Twelve Data is documented to answer that way on some ' +
      'endpoints and it was not observed on /price here. The probe asks for one ' +
      'symbol (SPY), so a symbol-scoped plan reads as a blanket refusal.',
  },
};

/**
 * Sources that could be recorded but cannot be asked yet, and why.
 *
 * Written down rather than left as an absence, so the coverage guard can tell
 * "nobody has got to this one" apart from "someone deleted a probe".
 */
export const UNPROBED_REASONS: Readonly<Record<string, string>> = {
  marketdata:
    'No probe yet — MarketData.app metering means a probe spends a credit ' +
    'from the same daily budget the connector needs.',
  schwab:
    'No probe yet — Schwab is OAuth2 and a probe must first refresh an access ' +
    'token from three variables, which is a token exchange rather than a read.',
  tastytrade:
    'No probe yet — Tastytrade issues a session from a username and password, ' +
    'so a probe is a login and not a cheap idempotent request.',
};

export function hasProbe(source: string): boolean {
  return Object.prototype.hasOwnProperty.call(PROBES, source);
}

/** Every source this module knows how to ask, gate and credentials aside. */
export function probeableSourceIds(): string[] {
  return Object.keys(PROBES);
}

/**
 * The sources that may actually be asked, in this environment, right now.
 *
 * This is the one place the three conditions live, so the doctor and the
 * running server cannot drift into asking different questions:
 *
 *   1. a probe exists for it,
 *   2. the connector gate permits the request — `mayOperateConnector`, the same
 *      gate `startConnector` runs before `start()`, because **a probe is a
 *      request and a request is the act a publisher's terms govern**, and
 *   3. the credentials it needs are set, so nothing manufactures a 401 by
 *      asking with an empty key and then reports it as a vendor verdict.
 *
 * Note this is deliberately *not* the PERSIST gate. `tools/collection/doctor.ts`
 * applies that on top for its own question ("may the answer be kept?"), which
 * is a different one from "is there an answer?" — and applying it here would
 * silently skip Twelve Data, which is UNVERIFIED for PERSIST and is the single
 * source every graded outcome derives from.
 */
export function probeableSources(
  env: NodeJS.ProcessEnv,
  mode?: BusinessMode,
): string[] {
  let m: BusinessMode;
  try {
    m = mode ?? resolveBusinessMode(env);
  } catch {
    // A mode we cannot resolve is a rights decision we cannot make. Asking
    // nobody is the only answer that cannot be wrong.
    return [];
  }
  return probeableSourceIds().filter((source) => {
    if (!mayOperateConnector(source, m).allowed) return false;
    const needs = PROBES[source]!.needs;
    return needs.every((k) => (env[k] ?? '').trim().length > 0);
  });
}

/** Ask everything askable, in parallel. Never rejects. */
export async function probeAll(
  env: NodeJS.ProcessEnv,
  mode?: BusinessMode,
): Promise<EntitlementResult[]> {
  return Promise.all(
    probeableSources(env, mode).map((source) => probeEntitlement(source, env)),
  );
}

/**
 * The status → state decision, without the network.
 *
 * Separated from `probeEntitlement` so the guard can drive every state for
 * every vendor without a server and without a key. A classifier that can only
 * be exercised by really being refused is a classifier that gets tested once.
 */
export function classifyProbeStatus(
  source: string, status: number | null, body?: unknown,
): EntitlementState {
  const probe = PROBES[source];
  if (!probe) return 'unprobed';
  return probe.classify(status, body);
}

/** Where this source's status mapping came from, for the report to cite. */
export function probeBasis(source: string): string | undefined {
  return PROBES[source]?.basis;
}

/**
 * Ask one vendor whether this deployment's key reaches the data.
 *
 * The caller is responsible for the rights gate (rule 1 at the top of this
 * file): do not call this for a source the running business mode refuses.
 */
export async function probeEntitlement(
  source: string,
  env: NodeJS.ProcessEnv,
): Promise<EntitlementResult> {
  const probe = PROBES[source];
  if (!probe) {
    return {
      source,
      state: 'unprobed',
      detail: UNPROBED_REASONS[source] ?? 'No entitlement probe is defined for this source.',
    };
  }

  const missing = probe.needs.filter((k) => (env[k] ?? '').trim().length === 0);
  if (missing.length > 0) {
    // Not `rejected`: nothing was asked, so the vendor has refused nothing.
    // Sending an empty key to find out would manufacture a 401 and report it
    // as a vendor verdict.
    return {
      source,
      state: 'unprobed',
      detail: `Not probed — ${missing.join(', ')} ${
        missing.length === 1 ? 'is' : 'are'} not set.`,
    };
  }

  const { url, headers } = probe.request(env);
  try {
    const res = await axios.get(url, {
      headers,
      timeout: 15_000,
      // Every status is data here, so none of them is an exception. Without
      // this, a 403 — the whole point of the probe — arrives as a throw and
      // the interesting body has to be dug back out of the error.
      validateStatus: () => true,
    });
    const state = probe.classify(res.status, res.data);
    return {
      source,
      state,
      detail: state === 'entitled'
        ? `HTTP 200 — the vendor served ${hostOf(url)}.`
        // Reuse the one place allowed to decide what a vendor failure may say
        // publicly, by handing it the axios-shaped object it expects.
        : describeHttpError({ response: { status: res.status, data: res.data } }),
    };
  } catch (err) {
    // No response at all. `describeHttpError` scrubs the message, which can
    // contain the URL, and the URL can contain the key.
    return { source, state: 'unreachable', detail: describeHttpError(err) };
  }
}

/**
 * `{"code":401,"status":"error"}` → 401, anything else → null.
 *
 * Deliberately narrow: it reads a code only when the payload also says it is
 * an error, so a successful body that happens to carry a `code` field is not
 * mistaken for a refusal.
 */
function errorEnvelopeCode(body: unknown): number | null {
  if (body === null || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  if (b.status !== 'error') return null;
  return typeof b.code === 'number' ? b.code : 0;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'the endpoint';
  }
}
