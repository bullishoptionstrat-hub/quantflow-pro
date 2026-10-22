import type { AlertChannelFiring, FlowEvent, PowerAlert } from './types'

/**
 * ROADMAP 5.3 — alerting that names its own trigger.
 *
 * Ledger line 98 records the power-alerts page describing a trigger the code
 * did not implement and crediting a model that did not exist. The sentence was
 * corrected; the shape that allowed it was not. Three things fire on a signal —
 * the alert row, the spoken announcement and the desktop notification — and
 * only the first had a rule anyone could read, and only as prose on a page.
 * Speech (heat above 80) and the notification (heat above 85) were constants
 * inside a hook, and an alert that had been spoken aloud carried nothing saying
 * so, or why.
 *
 * Now every firing is recorded on the alert it belongs to:
 *
 *   - the alert's own rule is the backend's `alert_trigger`, carried verbatim —
 *     the threshold is never restated here, which `wireContract.test.ts`
 *     already enforces for `isPowerAlert`;
 *   - each out-of-band channel whose rule matched gets an entry with the rule
 *     and the value that met it, and whether it was actually delivered.
 *
 * **And a channel can no longer fire without an alert.** Speech and the
 * notification used to be checked beside the alert, not inside it, so they
 * held only because 80 and 85 are above the backend's 75. Raise
 * `UNUSUAL_SCORE` to 90 and the terminal would have spoken trades that raised
 * no alert and appeared on no row anywhere. Both now run only for a signal
 * that is an alert, so nothing reaches a speaker or the desktop without a row
 * naming the rule that sent it.
 */

/** Spoken aloud above this heat, when voice is on. */
export const SPEAK_ABOVE = 80
/** Pushed to the desktop above this heat. */
export const PUSH_ABOVE = 85

/** The speech channel's rule for one signal, or null when it does not match. */
export function speechRule(heat: number): string | null {
  return heat > SPEAK_ABOVE ? `heat_score ${heat} > ${SPEAK_ABOVE} (SPEAK_ABOVE)` : null
}

/** The desktop channel's rule for one signal, or null when it does not match. */
export function desktopRule(heat: number): string | null {
  return heat > PUSH_ABOVE ? `heat_score ${heat} > ${PUSH_ABOVE} (PUSH_ABOVE)` : null
}

/** How the alert row names its own trigger. */
export function triggerText(a: Pick<PowerAlert, 'trigger'>): string {
  if (a.trigger) return a.trigger.text
  // A backend older than `alert_trigger`. Saying "heat >= 75" here would be
  // the restated threshold this module exists to remove, so it says what is
  // known: the backend flagged it, and did not say by which rule.
  return 'is_unusual — this backend did not publish the rule'
}

/** One line per channel, for the row. */
export function channelText(c: AlertChannelFiring): string {
  const name = c.channel === 'SPEECH' ? 'SPOKEN' : 'DESKTOP'
  return c.delivered ? `${name}: ${c.rule}` : `NOT ${name}: ${c.rule}, but ${c.reason ?? 'not delivered'}`
}

/** The alert row for a signal, before any channel has been tried. */
export function alertFor(event: FlowEvent): PowerAlert {
  const premium = event.total_premium >= 1e6
    ? `${(event.total_premium / 1e6).toFixed(1)}M`
    : `${Math.round(event.total_premium / 1000)}K`
  return {
    id: `alert-${event.id}`,
    underlying: event.underlying,
    alert_type: event.order_type,
    message: `${event.underlying} ${event.option_type === 'C' ? 'CALL' : 'PUT'} ${event.order_type} — $${premium} premium`,
    heat_score: event.heat_score,
    created_at: event.created_at,
    flow_event_id: event.id,
    synthetic: event.synthetic,
    score_breakdown: event.score_breakdown,
    // `?? null`: a backend older than the field sends no key at all, and the
    // row then says the rule was not published rather than inventing one.
    trigger: event.alert_trigger ?? null,
    channels: [],
  }
}
