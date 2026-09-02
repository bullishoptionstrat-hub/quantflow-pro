/**
 * Aggressor-side confidence vocabulary.
 *
 * Extracted from the Wave 4 adapter when `ingestion/flowEngineAdapter.ts`
 * became the single production translation path. That adapter classifies and
 * scores; this module says how much the resulting `side` may be trusted, and is
 * imported by it so the grade travels on every emitted signal.
 *
 * THE RULE THIS ENCODES: nothing in this pipeline is ever OBSERVED.
 *
 * An OBSERVED aggressor side requires the exchange to tell you which party
 * initiated. No feed wired into this repo supplies that flag — every side here
 * comes from comparing the trade price to the NBBO (the "quote rule"). A trade
 * at the offer is strong evidence of a buyer, not a record of one. Grading it
 * OBSERVED would be the difference between "we measured this" and "we worked
 * this out", which is exactly the distinction the product exists to keep.
 */

import type { InferredSide } from '../flow-engine/types';
import type { InferenceGrade } from '../config/provenance';

/**
 * How much to trust an aggressor-side call.
 *
 * A trade at or through the NBBO is as close to OBSERVED as options tape gets
 * without exchange-supplied aggressor flags — but it is still a quote-rule
 * inference, so it is graded STRONG_INFERENCE, never OBSERVED.
 */
export function gradeForSide(side: InferredSide): InferenceGrade {
  switch (side) {
    case 'BUY':
    case 'SELL':
      return 'STRONG_INFERENCE';
    case 'BUY_LEAN':
    case 'SELL_LEAN':
      return 'WEAK_INFERENCE';
    case 'AMBIGUOUS':
      return 'UNKNOWN';
  }
}

/**
 * Numeric confidence to accompany the grade. Never 1.0 — nothing here is
 * observed. AMBIGUOUS is 0, not a small positive number: we do not know the
 * side at all, and a nonzero value would invite downstream weighting of a
 * non-answer.
 */
export function confidenceForSide(side: InferredSide): number {
  switch (side) {
    case 'BUY':
    case 'SELL':
      return 0.8;
    case 'BUY_LEAN':
    case 'SELL_LEAN':
      return 0.55;
    case 'AMBIGUOUS':
      return 0;
  }
}

/** Human-readable method string recorded in provenance.inference_method. */
export function inferenceMethodFor(side: InferredSide): string {
  return `quote_rule:${side}`;
}
