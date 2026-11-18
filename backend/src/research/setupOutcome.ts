/**
 * SETUP OUTCOME GRADING — what happened after an ACTIONABLE idea, read from the
 * same imported bars the replay ran on.
 *
 * Lives in `research/`, not `setups/`, on purpose: it decides nothing about
 * what the state machine flags, so it is not part of `SETUP_RULES_VERSION`,
 * and it reads bars the machine had not seen when it decided.
 *
 * **Rules.**
 * - Grading starts at the first bar whose `tOpen >= ` the ACTIONABLE
 *   transition's `knownAt`. The trigger bar itself is never read: its close is
 *   the entry, and its high/low happened before that close was known.
 * - Each later bar is checked for a touch of the target and of the
 *   invalidation (the stop). One touched first decides. A bar touching **both**
 *   is `AMBIGUOUS_SAME_BAR`: a 1-minute bar does not say which came first, and
 *   calling it a win is the flattering guess.
 * - Bars running out before either touch is `OPEN`, never a loss or a win.
 * - A gap in the bars inside the graded window is reported (`gapMinutes`), not
 *   bridged: a touch may have happened in the missing minutes.
 * - R is net of the round-trip cost, on the same basis the reward gate used:
 *   a target hit is `+netR`; a stop hit is `-1`, because the gate's risk
 *   already includes the cost. Slippage past the stop is not modelled.
 * - No hit rate or mean R is published below `MIN_PUBLISHABLE_SAMPLE` decided
 *   ideas (target + stop). Ambiguous and open ideas are counted, not dropped.
 */
import type { Bar } from '../market/bar';
import type { SetupIdea } from '../setups/sweepReclaim';
import { MIN_PUBLISHABLE_SAMPLE } from '../persistence/types';

export type OutcomeState = 'TARGET_FIRST' | 'STOP_FIRST' | 'AMBIGUOUS_SAME_BAR' | 'OPEN' | 'NOT_GRADED';

export interface IdeaOutcome {
  ideaId: string;
  state: OutcomeState;
  /** Net R realized: +netR at target, -1 at stop, null otherwise. */
  r: number | null;
  /** closedAt of the bar that decided it, or null. */
  decidedAt: number | null;
  /** Bars read after the trigger. */
  barsRead: number;
  /** Minutes missing between consecutive bars inside the graded window. */
  gapMinutes: number;
  detail: string;
}

const MINUTE = 60_000;

function actionableAt(idea: SetupIdea): number | null {
  const t = idea.history.find((h) => h.state === 'ACTIONABLE');
  return t === undefined ? null : t.knownAt;
}

export function gradeIdea(idea: SetupIdea, bars: readonly Bar[]): IdeaOutcome {
  const base = { ideaId: idea.ideaId, r: null, decidedAt: null, barsRead: 0, gapMinutes: 0 };
  const at = actionableAt(idea);
  if (at === null) return { ...base, state: 'NOT_GRADED', detail: 'the idea never became ACTIONABLE' };
  if (idea.entry === null || idea.target === null || idea.netR === null) {
    return { ...base, state: 'NOT_GRADED', detail: 'the idea has no entry, target or net R' };
  }
  const long = idea.side === 'LONG';
  const stop = idea.invalidation;
  const tgt = idea.target.price;
  let barsRead = 0;
  let gapMinutes = 0;
  let prev: Bar | null = null;
  for (const b of bars) {
    if (b.tOpen < at) continue;
    if (prev !== null) gapMinutes += Math.max(0, (b.tOpen - prev.tOpen) / MINUTE - 1);
    prev = b;
    barsRead++;
    const hitTarget = long ? b.h >= tgt : b.l <= tgt;
    const hitStop = long ? b.l <= stop : b.h >= stop;
    if (hitTarget && hitStop) {
      return { ideaId: idea.ideaId, state: 'AMBIGUOUS_SAME_BAR', r: null, decidedAt: b.closedAt, barsRead, gapMinutes,
        detail: 'one bar touched both the target and the stop; a 1-minute bar does not say which came first' };
    }
    if (hitTarget) return { ideaId: idea.ideaId, state: 'TARGET_FIRST', r: idea.netR, decidedAt: b.closedAt, barsRead, gapMinutes, detail: `reached ${idea.target.name} ${tgt}` };
    if (hitStop) return { ideaId: idea.ideaId, state: 'STOP_FIRST', r: -1, decidedAt: b.closedAt, barsRead, gapMinutes, detail: `reached the invalidation ${stop}` };
  }
  return { ideaId: idea.ideaId, state: 'OPEN', r: null, decidedAt: null, barsRead, gapMinutes, detail: 'the bars ended before either level was touched' };
}

export interface OutcomeSummary {
  byState: Record<OutcomeState, number>;
  decided: number;
  minSample: number;
  /** Null with a reason below the sample floor. */
  hitRate: number | null;
  meanR: number | null;
  suppressed: string | null;
}

export function summariseOutcomes(outcomes: readonly IdeaOutcome[]): OutcomeSummary {
  const byState: Record<OutcomeState, number> = { TARGET_FIRST: 0, STOP_FIRST: 0, AMBIGUOUS_SAME_BAR: 0, OPEN: 0, NOT_GRADED: 0 };
  for (const o of outcomes) byState[o.state]++;
  const decided = byState.TARGET_FIRST + byState.STOP_FIRST;
  if (decided < MIN_PUBLISHABLE_SAMPLE) {
    return { byState, decided, minSample: MIN_PUBLISHABLE_SAMPLE, hitRate: null, meanR: null,
      suppressed: `INSUFFICIENT_SAMPLE: ${decided} decided ideas, ${MIN_PUBLISHABLE_SAMPLE} required` };
  }
  let sum = 0;
  for (const o of outcomes) if (o.r !== null) sum += o.r;
  return { byState, decided, minSample: MIN_PUBLISHABLE_SAMPLE, hitRate: byState.TARGET_FIRST / decided, meanR: sum / decided, suppressed: null };
}
