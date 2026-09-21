/**
 * QuantFlow Pro — persistence wiring
 *
 * Store selection is explicit and reported, never inferred silently. A
 * deployment that believes it is accumulating history while actually holding
 * it in a process that restarts every few minutes is the failure this module
 * exists to make impossible to have by accident.
 */
import { createClient } from '@supabase/supabase-js';
import { InMemorySignalStore } from './memoryStore';
import { SupabaseSignalStore } from './supabaseStore';
import { SignalRecorder } from './recorder';
import { resolveBusinessMode, type BusinessMode } from '../provenance/rights';
import type { SignalStore } from './types';
import { classifyServiceKey, type ServiceKeyVerdict } from './serviceKey';

export * from './types';
export * from './identity';
export { InMemorySignalStore } from './memoryStore';
export { SupabaseSignalStore } from './supabaseStore';
export { SignalRecorder, type RecorderStats } from './recorder';
export { SignalGrader, recoverEntryMark, type GraderStats, type SpotLookup,
  type Mark, type MarkLookup, type RecoveryReport, type ResumedState } from './grader';
export { classifyServiceKey, projectRefFromUrl,
  type ServiceKeyShape, type ServiceKeyVerdict } from './serviceKey';

let store: SignalStore | undefined;
let recorder: SignalRecorder | undefined;
let mode: BusinessMode | undefined;
let serviceKey: ServiceKeyVerdict | undefined;
let selection = {
  kind: 'none' as 'memory' | 'supabase' | 'none',
  durable: false,
  reason: 'not initialised',
};

/**
 * Build the store once, from the environment.
 *
 * Falls back to memory when Supabase is unconfigured — but says so in
 * `describePersistence()` and on `/api/health`, with the consequence spelled
 * out. A silent fallback here would mean the operator learns their history was
 * never durable at the moment they first go looking for it.
 */
export function initPersistence(env: NodeJS.ProcessEnv = process.env): {
  store: SignalStore;
  recorder: SignalRecorder;
} {
  if (store && recorder) return { store, recorder };

  mode = resolveBusinessMode(env);

  const url = env.SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_KEY;

  if (url && key) {
    // The store is still built from what the operator configured — falling back
    // to memory on a key this module merely *distrusts* would be a silent
    // substitution, and silent substitution is what this file exists to
    // prevent. What changes is the claim made about it.
    store = new SupabaseSignalStore(createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    }));
    // `durable: true` used to follow from two non-empty strings, with the
    // reason "history survives restarts" — a capability read off configuration,
    // the same defect 1.1a removed from the doctor's check 2. The anon key and
    // the service key are adjacent in the Supabase dashboard and pasting the
    // wrong one is silent: the client constructs, every insert is refused by
    // RLS, and this field said the history was durable behind a store that had
    // never kept a row.
    serviceKey = classifyServiceKey(url, key);
    selection = {
      kind: 'supabase',
      durable: serviceKey.usable,
      reason: serviceKey.usable
        ? `${serviceKey.reason} History survives restarts if it does.`
        : `${serviceKey.reason} Until that is fixed the store is configured but ` +
          `records nothing, which is worse than in-memory: it looks durable.`,
    };
  } else {
    store = new InMemorySignalStore();
    selection = {
      kind: 'memory',
      durable: false,
      reason:
        'SUPABASE_URL / SUPABASE_SERVICE_KEY are not set, so the signal history is ' +
        'in-memory and is LOST on every restart. On a free-tier host that spins down ' +
        'when idle, that is close to permanent amnesia: no track record can ever ' +
        'accumulate. Set both to make collection durable.',
    };
  }

  recorder = new SignalRecorder(store, mode);
  return { store, recorder };
}

export function getStore(): SignalStore | undefined { return store; }
export function getRecorder(): SignalRecorder | undefined { return recorder; }

/** Shape rendered into /api/health. */
export function describePersistence() {
  return {
    store: selection.kind,
    durable: selection.durable,
    reason: selection.reason,
    /**
     * What the configured credential is, as far as its shape says — never the
     * credential. `null` when no Supabase store was built.
     *
     * Published because "durable: false" on its own sends an operator to check
     * whether the variables are set, and they are; the fault is *which* key is
     * in one of them.
     */
    serviceKey: serviceKey
      ? { shape: serviceKey.shape, usable: serviceKey.usable, basis: serviceKey.basis }
      : null,
    businessMode: mode ?? '(uninitialised)',
    recorder: recorder?.getStats() ?? null,
  };
}

/** Test seam: drop the singletons so a test can build a fresh pair. */
export function __resetPersistenceForTests(): void {
  store = undefined;
  recorder = undefined;
  mode = undefined;
  selection = { kind: 'none', durable: false, reason: 'not initialised' };
}
export {
  CoverageRecorder, classifyWindow, summariseCoverage,
  type CoverageSample, type WindowVerdict,
} from './coverage';
