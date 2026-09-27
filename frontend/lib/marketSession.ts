'use client'
import { useEffect, useState } from 'react'
import { loadPanel, type Panel } from './panel'

/**
 * The one place the terminal learns whether the EXCHANGE'S REGULAR SESSION is
 * in hours — and only that.
 *
 * This used to be labelled "the market", and printed as MARKET OPEN. The audit
 * of 2026-09-27 showed why that claim was never ours to make: the OPRA feed
 * window (07:30–17:00 from 2026-09-21), a product's own sessions (SPX trades in
 * a curb and an overnight global session), and a study's sample are separate
 * facts, and at 21:00 on a Sunday SPX is trading while every label here said
 * CLOSED. So every label now names the authority behind it: RTH, the exchange's
 * regular trading hours, which is all the backend's verdict establishes.
 *
 * It used to be `isRegularHours()` in `lib/utils.ts` — a weekday test and a
 * hardcoded 09:30–16:00 window, computed in the browser with no calendar behind
 * it. Its own docstring admitted the consequence: "Thanksgiving, Good Friday and
 * every other full closure read as open, and half-days read as open past the
 * 13:00 close." CLAUDE.md records that the function was *renamed* rather than
 * fixed because "a calendar is a thing to maintain".
 *
 * A calendar is now maintained, in the backend, and it publishes the verdict on
 * `/api/health`. That is the shape this repository settled for rights lineage and
 * for source health: **the backend knows, so the browser reads rather than
 * re-derives.** Copying the table here would be a second calendar to keep
 * correct, which is what cost the ticker tape seven tickers and the settings page
 * three hand-maintained lists.
 *
 * `/api/health` is unauthenticated, which is why this can run on `/login` too —
 * the sidebar mounts there.
 */

export type SessionState =
  | 'OPEN'
  | 'CLOSED_OUTSIDE_HOURS'
  | 'CLOSED_HOLIDAY'
  | 'CLOSED_WEEKEND'
  | 'UNKNOWN'

export interface MarketSession {
  /** Which session authority this is. Older backends omit it. */
  authority?: 'EXCHANGE_REGULAR_SESSION'
  state: SessionState
  date: string | null
  nowMinutesEt: number | null
  openMinutesEt: number | null
  closeMinutesEt: number | null
  basis: string
  source: string
  readAt: string
  coverage: { from: string; to: string }
}

/**
 * How often to re-ask.
 *
 * A minute, because the only thing that changes within a day is crossing the
 * open or the close, and being up to a minute late on that is invisible next to
 * a label that was wrong for whole days.
 */
export const POLL_MS = 60_000

/** `hh:mm` from minutes past midnight, or `—`. */
export function etClock(minutes: number | null): string {
  if (minutes === null || !Number.isFinite(minutes)) return '—'
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

/**
 * What to put on the board, and whether it is good news.
 *
 * `tone` has three values rather than two because the states do. A published
 * closure is not a fault and is not an achievement — it is Sunday — so painting
 * it the same red as `UNKNOWN` would tell a reader to go looking for a problem
 * that is a weekend. And `UNKNOWN` is deliberately not rendered as closed: the
 * calendar refusing to answer is the one case where the terminal genuinely does
 * not know, which is the rule `coverage.ts` follows for the same reason.
 */
export function describeSession(s: MarketSession | null): {
  label: string
  tone: 'open' | 'closed' | 'unknown'
  detail: string
} {
  if (!s) {
    return {
      label: 'SESSION UNKNOWN',
      tone: 'unknown',
      detail: 'The backend did not answer, so the session calendar could not be read.',
    }
  }
  const hours = s.openMinutesEt !== null && s.closeMinutesEt !== null
    ? `${etClock(s.openMinutesEt)}–${etClock(s.closeMinutesEt)} ET`
    : null
  // Every tooltip says what this is NOT, because the label is short and the
  // mistake it replaces was a short label read as a larger claim.
  const scope = 'Exchange regular trading hours only — not the OPRA feed window, ' +
    'not extended, curb or overnight product sessions, and not any study\'s sample. '
  const cite = `${s.basis} (${s.source}, read ${s.readAt})`
  switch (s.state) {
    case 'OPEN':
      return { label: hours === '09:30–13:00 ET' ? 'RTH OPEN · HALF DAY' : 'RTH OPEN',
        tone: 'open', detail: scope + cite }
    case 'CLOSED_OUTSIDE_HOURS':
      // Outside RTH is not "closed": extended and overnight sessions may be
      // trading, and this verdict cannot see them.
      return { label: hours ? `OUTSIDE RTH · ${hours}` : 'OUTSIDE RTH',
        tone: 'closed', detail: scope + cite }
    case 'CLOSED_HOLIDAY':
      return { label: 'NO RTH · HOLIDAY', tone: 'closed', detail: scope + cite }
    case 'CLOSED_WEEKEND':
      return { label: 'NO RTH · WEEKEND', tone: 'closed', detail: scope + s.basis }
    default:
      return { label: 'SESSION UNKNOWN', tone: 'unknown', detail: scope + s.basis }
  }
}

function pick(body: unknown): MarketSession | null {
  const s = (body as { session?: unknown } | null)?.session
  // A backend older than this field answers 200 with no `session`. That is
  // `SESSION UNKNOWN`, not a crash and not a guess — the same reason the settings
  // page tolerates a payload with no `sourceNotes`.
  if (!s || typeof s !== 'object') return null
  return s as MarketSession
}

export function useMarketSession(): { panel: Panel<MarketSession | null> } {
  const [panel, setPanel] = useState<Panel<MarketSession | null>>({ status: 'loading' })

  useEffect(() => {
    let live = true
    const read = async () => {
      const p = await loadPanel<MarketSession | null>('/api/health', pick)
      if (live) setPanel(p)
    }
    void read()
    const t = setInterval(() => void read(), POLL_MS)
    return () => { live = false; clearInterval(t) }
  }, [])

  return { panel }
}
