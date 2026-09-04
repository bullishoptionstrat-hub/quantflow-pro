/**
 * A daily budget that actually resets every day.
 *
 * Four connectors meter themselves against a free tier's daily quota, and all
 * four armed the reset the same way:
 *
 *     const msUntilMidnight = new Date(y, m, d + 1).getTime() - now.getTime();
 *     setTimeout(() => { counter = 0; }, msUntilMidnight);
 *
 * `setTimeout` is one-shot. The counter was therefore zeroed once, at the
 * first midnight after the process started, and never again — while the
 * counter itself only ever climbs. On day three the connector reaches its
 * limit and stops fetching for the rest of the process's life.
 *
 * That failure is silent by construction. Three of the four also *latch* the
 * counter to its limit on a 429/402 to stop for the day, so one rate-limit
 * response permanently ends the connector. And `startConnector` records what
 * `start()` returned once and never looks again, so all of it happens behind a
 * source still reporting `connected` — the Stooq finding, reached by a
 * different route.
 *
 * The timer is `unref`'d. A module-level timer that keeps the Node event loop
 * alive is the defect `missingIsNotZero.test.ts` closed for every connector's
 * `setInterval`; these were `setTimeout`, so its scan walked straight past
 * them, holding the loop open for up to 24 hours.
 */

/** Milliseconds from `now` to the next local midnight. Always positive. */
export function msUntilNextMidnight(now: number): number {
  const d = new Date(now);
  const midnight = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
  // A DST fall-back can put the computed midnight behind `now`; a negative
  // delay fires immediately and would spin. Never return less than a second.
  return Math.max(1000, midnight - now);
}

export interface DailyReset {
  cancel(): void;
}

/**
 * Run `reset` at every local midnight for as long as the process lives.
 *
 * Re-arms from inside the callback rather than using a fixed 24h interval, so
 * it stays pinned to midnight across DST rather than drifting an hour twice a
 * year.
 */
export function scheduleDailyReset(reset: () => void): DailyReset {
  let timer: NodeJS.Timeout;

  const arm = (): void => {
    timer = setTimeout(() => {
      try {
        reset();
      } finally {
        arm();
      }
    }, msUntilNextMidnight(Date.now()));
    timer.unref();
  };

  arm();
  return { cancel: () => clearTimeout(timer) };
}
