import type { FlowEvent } from './types'

/**
 * How much of what has arrived is constructed rather than observed, or `null`
 * when none of it is, so a fully observed feed stays quiet.
 *
 * "CONSTRUCTED", not "SIMULATED". `synthetic` covers two different things: a
 * generated print, and a real vendor chain row turned into a print from the
 * day's aggregate volume (marketData, schwab, tastytrade, yahoo). A deployment
 * credentialed for only those sources is showing real Schwab data, and the
 * sidebar used to read "ALL SIGNALS SIMULATED" — telling an operator their paid
 * integration was fake. The row badge's own wording has been the accurate one
 * all along: "constructed from aggregate volume or generated". Demo mode has
 * its own all-or-nothing banner, so nothing is lost by not saying "simulated".
 *
 * One helper because two surfaces show it (the sidebar and the status strip),
 * and two copies of a wording rule is how one of them drifts back.
 */
export function syntheticShare(events: readonly Pick<FlowEvent, 'synthetic'>[]): string | null {
  const constructed = events.filter((e) => e.synthetic).length
  if (constructed === 0) return null
  return constructed === events.length
    ? 'ALL SIGNALS CONSTRUCTED'
    : `${constructed}/${events.length} CONSTRUCTED`
}
