/**
 * Whether a WebSocket is still alive, judged by whether anything arrives.
 *
 * A socket whose network path dies without a FIN — a NAT entry expiring, a
 * dropped route — raises no `close` and no `error`. It stays open forever,
 * the source keeps reading `connected`, and the reconnect logic, which runs
 * on `close`, never fires. The terminal then reports a live stream that is
 * delivering nothing, which is F-23's shape arrived at through the network.
 *
 * The check: send a ping on an interval and count any message or pong as
 * evidence of life. If nothing has been heard for `deadAfterMs`, the socket is
 * declared dead and the caller terminates it, which raises `close` and so
 * runs the reconnect path that already exists. Answering a ping is required of
 * every WebSocket server by RFC 6455; whether a given vendor's server does is
 * not measured here.
 */
export interface LivenessOptions {
  pingEveryMs: number;
  deadAfterMs: number;
}

export const DEFAULT_LIVENESS: LivenessOptions = { pingEveryMs: 30_000, deadAfterMs: 75_000 };

export class Liveness {
  private lastHeardAt: number;
  private dead = false;

  constructor(private readonly opts: LivenessOptions, now: number) {
    if (!(opts.deadAfterMs > opts.pingEveryMs)) {
      throw new Error('deadAfterMs must exceed pingEveryMs, or a healthy socket is declared dead between pings');
    }
    this.lastHeardAt = now;
  }

  /** A message or a pong arrived. */
  heard(now: number): void {
    this.lastHeardAt = now;
  }

  /**
   * Called on each ping interval. Returns 'ping' while the socket is alive and
   * 'dead' once, the first time nothing has been heard for `deadAfterMs`.
   */
  tick(now: number): 'ping' | 'dead' | 'done' {
    if (this.dead) return 'done';
    if (now - this.lastHeardAt > this.opts.deadAfterMs) {
      this.dead = true;
      return 'dead';
    }
    return 'ping';
  }

  silentForMs(now: number): number {
    return now - this.lastHeardAt;
  }
}

/** The minimum a socket must offer to be watched. `ws`'s WebSocket satisfies it. */
export interface PingableSocket {
  on(event: 'message' | 'pong' | 'close', fn: (...args: any[]) => void): unknown;
  ping(): void;
  terminate(): void;
}

/**
 * Watch `ws` until it closes. `onDead` runs once, before `terminate()`, with
 * how long the socket had been silent, so the caller can record why.
 */
export function watchLiveness(
  ws: PingableSocket,
  onDead: (silentMs: number) => void,
  opts: LivenessOptions = DEFAULT_LIVENESS,
  now: () => number = () => Date.now(),
): { stop(): void } {
  const live = new Liveness(opts, now());
  ws.on('message', () => live.heard(now()));
  ws.on('pong', () => live.heard(now()));
  const timer = setInterval(() => {
    const verdict = live.tick(now());
    if (verdict === 'ping') {
      try { ws.ping(); } catch { /* a closing socket throws; close will follow */ }
    } else if (verdict === 'dead') {
      clearInterval(timer);
      onDead(live.silentForMs(now()));
      ws.terminate();
    }
  }, opts.pingEveryMs).unref();
  const stop = () => clearInterval(timer);
  ws.on('close', stop);
  return { stop };
}
