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

export * from './types';
export * from './identity';
export { InMemorySignalStore } from './memoryStore';
export { SupabaseSignalStore } from './supabaseStore';
export { SignalRecorder, type RecorderStats } from './recorder';
export { SignalGrader, type GraderStats, type SpotLookup } from './grader';

let store: SignalStore | undefined;
let recorder: SignalRecorder | undefined;
let mode: BusinessMode | undefined;
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
    store = new SupabaseSignalStore(createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    }));
    selection = {
      kind: 'supabase',
      durable: true,
      reason: 'SUPABASE_URL and SUPABASE_SERVICE_KEY are set — history survives restarts.',
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
