/**
 * One cycle of a poller at a time.
 *
 * An interval timer starts a new cycle every period whether or not the last
 * one has finished, so a vendor that answers slowly gets two cycles running at
 * once. Two pollers here can overlap on their own arithmetic, with no vendor
 * misbehaving beyond its own timeout: Schwab walks seven symbols at up to 8s a
 * request plus a 1.5s pause, 66.5s against a 60s interval; and the Cboe chain
 * tick allows a 20s request on a 20s interval, then parses up to ~13MB of JSON.
 * The overlapping cycle is not harmless:
 *
 * - a chain connector's second cycle publishes the same aggregate volume again,
 *   so the engine sees each contract twice and counts the duplicate as repeat
 *   activity;
 * - a slow first cycle that fails after a faster second one succeeded writes a
 *   stale `error` over a current `connected`;
 * - two chain parses at once is two copies of the largest payload this process
 *   handles, on a host with 512MB.
 *
 * A skipped cycle is counted per poller and published on `/api/health`, so a
 * vendor slow enough to cause skips is visible rather than merely survived.
 *
 * A cycle that rejects is logged and does not reach the event loop as an
 * unhandled rejection, which on Node 15+ ends the process. Most pollers catch
 * their own errors; this is the backstop for the ones that do not.
 */

interface PollerState {
  skipped: number;
  failed: number;
  inFlightSince: number | null;
}

const pollers: Record<string, PollerState> = {};

export function singleFlight(
  name: string,
  cycle: () => Promise<unknown>,
  now: () => number = Date.now,
): () => Promise<void> {
  const state: PollerState = (pollers[name] ??= { skipped: 0, failed: 0, inFlightSince: null });
  return async () => {
    if (state.inFlightSince !== null) {
      state.skipped++;
      if (state.skipped === 1 || state.skipped % 100 === 0) {
        console.warn(
          `[${name}] cycle skipped: the previous one has run ` +
          `${Math.round((now() - state.inFlightSince) / 1000)}s (${state.skipped} skipped so far)`,
        );
      }
      return;
    }
    state.inFlightSince = now();
    try {
      await cycle();
    } catch (err: any) {
      state.failed++;
      console.error(`[${name}] cycle failed:`, err?.message ?? err);
    } finally {
      state.inFlightSince = null;
    }
  };
}

export interface PollerReport {
  skipped: number;
  failed: number;
  inFlightSince: string | null;
}

/** Pollers that have skipped or failed a cycle, or are mid-cycle. */
export function pollerHealth(): Record<string, PollerReport> {
  const out: Record<string, PollerReport> = {};
  for (const [name, s] of Object.entries(pollers)) {
    if (s.skipped === 0 && s.failed === 0) continue;
    out[name] = {
      skipped: s.skipped,
      failed: s.failed,
      inFlightSince: s.inFlightSince === null ? null : new Date(s.inFlightSince).toISOString(),
    };
  }
  return out;
}

/** Test seam. */
export function resetPollerHealth(): void {
  for (const k of Object.keys(pollers)) delete pollers[k];
}
