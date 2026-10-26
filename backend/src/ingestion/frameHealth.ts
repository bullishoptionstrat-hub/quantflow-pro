/**
 * Frames a streaming source sent that this process could not parse.
 *
 * WebSocket handlers that ended `} catch {}` dropped a bad frame with no
 * counter, no log and no health signal, so a vendor changing its envelope
 * produced a source that was `connected`, receiving bytes and emitting
 * nothing. The counter lived in `ingestion/index.ts`, which connectors cannot
 * import without a cycle, so Twelve Data's and Tastytrade's handlers kept
 * their bare catches. It lives here so every connector can reach it; the
 * counts reach `/api/health` through `sourceNotes`.
 */
const unparsedFrames: Record<string, number> = {};

export function noteUnparsedFrame(source: string): void {
  unparsedFrames[source] = (unparsedFrames[source] ?? 0) + 1;
  const n = unparsedFrames[source]!;
  // Log on the first and then sparsely: a vendor that changes its envelope
  // produces one per frame, and a log line per frame is its own outage.
  if (n === 1 || n % 500 === 0) {
    console.warn(`[${source}] ${n} stream frame(s) could not be parsed`);
  }
}

/** Per source: frames that could not be parsed since boot. */
export function unparsedFrameCounts(): Readonly<Record<string, number>> {
  return { ...unparsedFrames };
}
