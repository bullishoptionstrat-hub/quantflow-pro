export { FlowEngine } from "./engine";
export { NbboBook, sideBucket } from "./nbbo";
export { scoreSignal } from "./score";
export type { ScoreInput } from "./score";
export { replayPolygonDay } from "./adapters/polygon-replay";
export type { PolygonReplayOptions } from "./adapters/polygon-replay";
export * from "./types";
/**
 * The standalone outcome tracker.
 *
 * The backend that vendors this module does **not** use it: its production
 * recorder and grader are `backend/src/persistence/` — `recorder.ts`,
 * `grader.ts` and `identity.ts`, backed by Supabase and covered by
 * `historyIntegration.test.ts`. This is exported because the module ships its
 * own outcome API, and the vendored copy mirrors the module.
 *
 * Both derive the measurement origin the same way, and
 * `backend/test/outcomeDecision.test.ts` fails if they ever stop agreeing.
 */
export { OutcomeTracker, buildReport } from "./outcome/tracker";
export type { KindReport } from "./outcome/tracker";
export {
  InMemoryOutcomeStore,
  DEFAULT_OUTCOME_CONFIG,
  impliedDirectionOf,
} from "./outcome/types";
export type {
  TrackedSignal,
  OutcomeLabel,
  OutcomeStore,
  OutcomeTrackerConfig,
  PriceLookup,
  CheckpointResult,
  CheckpointKey,
  MarkSnapshot,
  ImpliedDirection,
} from "./outcome/types";
