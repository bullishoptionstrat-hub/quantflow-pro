'use client'
import { useState, useEffect, useCallback } from 'react'
import { loadPanel, listAt, type Panel } from './panel'
import type { SpotQuote } from './types'

/**
 * The one place the terminal reads spot prices, and the one place its
 * staleness rule lives.
 *
 * Three components used to hold their own 2024 price map instead:
 * `TopBar`'s (SPX 5587, NVDA 942, TSLA 182) was jittered by `Math.random()`
 * and is gone; `app/watchlist/page.tsx` rendered `$5,587` under SPX as a card
 * price; `components/calculator/StrategyBuilder.tsx` seeded every strategy off
 * `SPY: 557`. The maps disagreed with each other on the symbols they shared,
 * which is what a hand-maintained list in front of a feed always ends up
 * doing — the same finding that retired three lists from the settings page.
 */

/** How often to re-read the board. */
export const POLL_MS = 30_000

/**
 * Older than this and a quote is dated rather than presented as current.
 *
 * The connector caches, so a dead TwelveData feed keeps serving its last board
 * forever; rendering that in live styling is the Stooq failure with a
 * different connector. Five minutes without a newer quote means the feed has
 * stopped, the session has closed, or the vendor is refusing — three causes
 * with one honest reading: these are not live prices.
 */
export const STALE_MS = 5 * 60_000

export interface SpotFeed {
  panel: Panel<SpotQuote[]>
  /** The quote for a symbol, or `undefined` — never a substitute. */
  quote: (symbol: string) => SpotQuote | undefined
}

export function isStale(q: SpotQuote, now = Date.now()): boolean {
  return !q.timestamp || now - q.timestamp > STALE_MS
}

/** `HH:MM:SS` in New York, for dating a quote the feed has stopped refreshing. */
export function asOf(q: SpotQuote): string {
  return new Date(q.timestamp).toLocaleTimeString('en-US', { hour12: false, timeZone: 'America/New_York' })
}

export function useSpotQuotes(): SpotFeed {
  const [panel, setPanel] = useState<Panel<SpotQuote[]>>({ status: 'loading' })

  const load = useCallback(async () => {
    setPanel(await loadPanel<SpotQuote[]>('/api/macro/quotes', b => listAt(b, 'quotes')))
  }, [])

  useEffect(() => {
    load()
    const id = setInterval(load, POLL_MS)
    return () => clearInterval(id)
  }, [load])

  const quotes = panel.status === 'ok' ? panel.data : []
  return {
    panel,
    quote: (symbol: string) => quotes.find(q => q.symbol === symbol),
  }
}
