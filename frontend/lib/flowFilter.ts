import type { FlowEvent, FlowFilters } from './types'

/**
 * The one definition of "does this signal match the filters".
 *
 * There were two, written out identically: one in `useFlowFeed.passesFilters`
 * and one inline in `FlowFeed`. The duplication was not the damage — the
 * placement was. The ingest copy ran **before `addFlowEvent`**, so a signal
 * that did not match the filters in force at the moment it arrived was never
 * stored at all.
 *
 * The filters are a view control. Raising `minPremium` to $1M for a minute and
 * putting it back deleted every sub-$1M print from that minute, permanently,
 * while the control on screen said they were admitted again. The display copy
 * then re-filtered an already-filtered set, so it was a no-op for anything but
 * a narrowing — the second copy was dead code guarding against a loss the
 * first copy had already caused.
 *
 * Filtering now happens at display only. This module is the single predicate,
 * and `wireContract.test.ts` fails if a second one appears.
 */
export function matchesFilters(e: FlowEvent, f: FlowFilters): boolean {
  if (f.ticker && !e.underlying.includes(f.ticker.toUpperCase())) return false
  if (e.total_premium < f.minPremium) return false
  if (f.optionType !== 'ALL' && e.option_type !== f.optionType) return false
  if (f.orderType !== 'ALL' && e.order_type !== f.orderType) return false
  if (f.sentiment !== 'ALL' && e.sentiment !== f.sentiment) return false
  if (e.heat_score < f.minHeat) return false
  if (f.unusualOnly && !e.is_unusual) return false
  return true
}

/**
 * What raises a power alert, independent of what is on screen.
 *
 * This used to sit behind the display filter, so choosing to look at puts
 * stopped the terminal announcing a $10M call sweep, and a `$1M+` premium
 * filter stopped a heat-95 print at $800K from ever being spoken aloud or
 * pushed to the desktop. A view control with an invisible side effect on an
 * out-of-band channel is the same shape as the finding that got the seeded
 * feed deleted: neither `speakAlert` nor `pushNotification` reads `synthetic`,
 * so what reaches them cannot be qualified after the fact.
 */
export function isPowerAlert(e: FlowEvent): boolean {
  // `e.is_unusual && e.heat_score >= 75` was the condition, and the second
  // term is implied by the first: the backend sets `is_unusual` to exactly
  // `heat_score >= 75`. Restating the threshold here made one rule look like
  // two and gave it a second home to drift from. Read the field the backend
  // publishes; it decides where the line is.
  return e.is_unusual
}
