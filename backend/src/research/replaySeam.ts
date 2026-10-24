/**
 * A V2 tape replayed through the production seam, in a pipeline of its own.
 *
 * `events/detector.ts` decides which V2 events a real-time detector would
 * have seen and translates each into the `RawPrint` the seam receives; the
 * signals then come from `ingestPrint`, the same function every live connector
 * calls (directive §22: research receives what live would have, no cleaner).
 * Until instances existed, "the same function" meant "the same engine": a
 * replay wrote historical quotes into the live NBBO book, counted historical
 * signals as today's repeats, and offered every replayed signal to the live
 * observers — the recorder among them. `createIngestor` gives a replay the
 * seam and none of that state.
 *
 * H-001-v2 §I declares staleness bounds of 1 s and 5 s as sensitivities. One
 * reading, open to challenge before any data is read:
 *
 *   S3  The bound is §H's — how old a causal quote may be and still decide a
 *       trade's side — not §C's age limit on the SPY entry mark. §I is titled
 *       "Classification robustness", and the side is what it classifies. The
 *       bound is applied in BOTH places §H applies it: `causalQuoteFor`'s
 *       selection and the engine's `nbboMaxAgeMs`. Applying it to one alone
 *       would leave the other at 2 s, and a 5 s re-run would then attach no
 *       quote older than 2 s — the same signals as the primary, reported as a
 *       sensitivity that was never run.
 *
 * The replay forms signals. Turning them into H-001 candidates — evidence
 * events, the final-tape revision, the manifest — is the study's step, done
 * the same way for the primary and each re-run.
 */
import { createIngestor } from '../ingestion/flowEngineAdapter';
import type { SignalOrigin, WireFlowEvent } from '../ingestion/flowEngineAdapter';
import type { ClassifiedSignal } from '../flow-engine/types';
import { DEFAULT_CONFIG } from '../flow-engine/types';
import { detectorAdmission, toRawPrint } from '../events/detector';
import { causalQuoteFor } from '../events/causalQuote';
import type { CausalQuote } from '../events/causalQuote';
import type { Emission } from '../events/reorder';
import type { QuoteEvent } from '../events/types';

/** §I's declared bounds. Nothing else is a sensitivity: an undeclared one is a forking path. */
export const H001_STALENESS_BOUNDS_MS = [1_000, 5_000] as const;
export type H001StalenessBound = (typeof H001_STALENESS_BOUNDS_MS)[number];

export interface SeamReplay {
  /** The bound applied to quote selection and to the engine alike (S3). */
  boundMs: number;
  /** Engine-native signals with their resolved origin, in emission order. */
  signals: Array<{ signal: ClassifiedSignal; origin: SignalOrigin }>;
  /** The same signals on the wire shape the terminal reads. */
  wire: WireFlowEvent[];
  admitted: string[];
  refused: Array<{ eventId: string; reason: string }>;
  /** How each admitted trade's quote was resolved — where the bound bites. */
  quoteStatus: Partial<Record<CausalQuote['status'], number>>;
}

export interface SeamReplayOptions {
  boundMs: number;
  /**
   * The pipeline's clock. Required: a replay stamped by the wall clock gives
   * two runs of one tape two different `emittedAt`s, and `decisionAt` takes
   * the maximum of the clocks, so today's date would reach a historical signal.
   */
  now: () => number;
}

export function replayThroughSeam(
  emissions: readonly Emission[],
  quotes: readonly QuoteEvent[],
  opts: SeamReplayOptions,
): SeamReplay {
  if (!(Number.isFinite(opts.boundMs) && opts.boundMs > 0)) {
    throw new RangeError(`boundMs must be a positive number of milliseconds, got ${opts.boundMs}`);
  }
  const ingestor = createIngestor({ engineConfig: { nbboMaxAgeMs: opts.boundMs }, now: opts.now });
  const signals: SeamReplay['signals'] = [];
  ingestor.onSignal((signal, origin) => signals.push({ signal, origin }));

  const out: SeamReplay = { boundMs: opts.boundMs, signals, wire: [], admitted: [], refused: [], quoteStatus: {} };
  for (const em of emissions) {
    const a = detectorAdmission(em);
    if (!a.admit) { out.refused.push({ eventId: em.event.eventId, reason: a.reason }); continue; }
    out.admitted.push(a.event.eventId);
    // The causal quote is chosen per trade, against what was known when it was.
    const q = causalQuoteFor(a.event, quotes, opts.boundMs);
    out.quoteStatus[q.status] = (out.quoteStatus[q.status] ?? 0) + 1;
    out.wire.push(...ingestor.ingestPrint(toRawPrint(a.event, q)));
  }
  // The tape has ended; nothing later will advance the watermark.
  out.wire.push(...ingestor.flush());
  return out;
}

/** The primary (the engine's own bound) and §I's two re-runs, each in its own pipeline. */
export function h001StalenessReplays(
  emissions: readonly Emission[],
  quotes: readonly QuoteEvent[],
  now: () => number,
): { primary: SeamReplay; reruns: Record<H001StalenessBound, SeamReplay> } {
  const run = (boundMs: number) => replayThroughSeam(emissions, quotes, { boundMs, now });
  return {
    primary: run(DEFAULT_CONFIG.nbboMaxAgeMs),
    reruns: { 1000: run(1_000), 5000: run(5_000) },
  };
}
