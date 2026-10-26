/**
 * A `fetch` that gives up after a fixed time, for the Supabase client.
 *
 * supabase-js uses plain `fetch`, which has no timeout. A request the network
 * swallows therefore never settles, and the grader awaits each write inside
 * `tick()`, which runs one at a time: one hung insert stopped all grading for
 * the life of the process, with nothing on `/api/health` but a
 * `tickInFlightSince` that kept getting older.
 *
 * A timeout turns that into an ordinary failed write, which the grader already
 * handles: the horizon stays pending, and if the write had in fact committed
 * the next attempt finds its row and reconciles it (`writesReconciled`). So a
 * timeout never loses a checkpoint and never records one twice.
 *
 * postgrest-js retries a failed GET up to three times (1s, 2s, 4s apart), so
 * the grader's follow-up lookup can take up to four of these limits plus 7s.
 * Writes are not retried there. Slow, but bounded, which a hung request was not.
 *
 * The signals are linked by hand rather than with `AbortSignal.any`, which is
 * missing from older Node versions, and Render's Node version is not pinned.
 */
export const STORE_REQUEST_TIMEOUT_MS = 15_000;

export function boundedFetch(
  timeoutMs: number = STORE_REQUEST_TIMEOUT_MS,
  inner: typeof fetch = fetch,
): typeof fetch {
  if (!(timeoutMs > 0)) throw new Error(`boundedFetch timeout must be positive, got ${timeoutMs}`);
  return (input, init = {}) => {
    const ctl = new AbortController();
    const timer = setTimeout(
      () => ctl.abort(new Error(`store request exceeded ${timeoutMs}ms and was abandoned`)),
      timeoutMs,
    );
    timer.unref?.();
    const caller = init.signal;
    const onCallerAbort = () => ctl.abort(caller?.reason);
    if (caller) {
      if (caller.aborted) ctl.abort(caller.reason);
      else caller.addEventListener('abort', onCallerAbort, { once: true });
    }
    return inner(input, { ...init, signal: ctl.signal }).finally(() => {
      clearTimeout(timer);
      caller?.removeEventListener('abort', onCallerAbort);
    });
  };
}
