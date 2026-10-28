/**
 * Shutdown that lets in-flight persistence finish, within a bound.
 *
 * Node exits on SIGTERM by default, and Render sends SIGTERM on every deploy
 * and on every free-tier sleep. A signal write cut off there is not retried by
 * anything: the signal is simply missing from the record. An outcome write cut
 * off after it committed is reconciled at the next boot by `recover()`, but one
 * cut off before it committed loses that checkpoint's exit mark for good.
 *
 * So on the first signal: stop accepting connections, wait for tracked writes
 * up to `timeoutMs`, then exit. The bound matters as much as the wait: a store
 * that never answers must not hold the process past the host's own kill. A
 * second signal exits at once.
 */
const pending = new Set<Promise<unknown>>();
let stopping = false;

/**
 * True once shutdown has begun. New recording and grading must not start
 * after that: work started during the drain extends it, and a process that
 * keeps producing writes never drains before the deadline.
 */
export function isShuttingDown(): boolean { return stopping; }

/** Test seam. */
export function resetLifecycleForTests(): void { stopping = false; pending.clear(); }

/** Register a write that shutdown should wait for. Returns it unchanged. */
export function trackWrite<T>(p: Promise<T>): Promise<T> {
  pending.add(p);
  const done = () => { pending.delete(p); };
  p.then(done, done);
  return p;
}

export function pendingWrites(): number { return pending.size; }

/** Resolves `true` once every tracked write settles, `false` at the deadline. */
export async function drainWrites(timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<false>((res) => { timer = setTimeout(() => res(false), timeoutMs); });
  try {
    while (pending.size > 0) {
      const settled = await Promise.race([Promise.allSettled([...pending]).then(() => true), deadline]);
      if (!settled) return false;
    }
    return true;
  } finally {
    clearTimeout(timer);
  }
}

export interface ShutdownDeps {
  closeServer: () => Promise<void>;
  drain: (timeoutMs: number) => Promise<boolean>;
  exit: (code: number) => void;
  log?: (msg: string) => void;
  timeoutMs?: number;
}

/** Returns the handler; calling it twice exits immediately the second time. */
export function makeShutdown(deps: ShutdownDeps): (signal: string) => Promise<void> {
  const log = deps.log ?? ((m: string) => console.log(m));
  const timeoutMs = deps.timeoutMs ?? 10_000;
  let started = false;
  return async (signal: string) => {
    if (started) { log(`[shutdown] second ${signal}; exiting now`); deps.exit(1); return; }
    started = true;
    stopping = true;
    log(`[shutdown] ${signal}: closing server, waiting up to ${timeoutMs}ms for writes`);
    try { await deps.closeServer(); } catch (err) { log(`[shutdown] server close failed: ${(err as Error).message}`); }
    let drained = false;
    try { drained = await deps.drain(timeoutMs); } catch (err) { log(`[shutdown] drain failed: ${(err as Error).message}`); }
    log(drained ? '[shutdown] writes settled' : `[shutdown] ${pendingWrites()} write(s) still pending at the deadline`);
    deps.exit(drained ? 0 : 1);
  };
}
