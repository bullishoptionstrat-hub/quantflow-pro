import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatPremium(val: number): string {
  if (val >= 1_000_000) return `$${(val / 1_000_000).toFixed(1)}M`
  if (val >= 1_000) return `$${Math.round(val / 1_000)}K`
  return `$${val}`
}

export function formatNumber(val: number): string {
  if (val >= 1_000_000) return `${(val / 1_000_000).toFixed(1)}M`
  if (val >= 1_000) return `${(val / 1_000).toFixed(1)}K`
  return val.toString()
}

export function formatTime(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'America/New_York' })
}

export function formatDate(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

export function formatExpiry(expiry: string): string {
  // expiry: "2026-05-01" → "May 1"
  const d = new Date(expiry + 'T12:00:00')
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

/**
 * Is it a weekday between 09:30 and 16:00 New York time?
 *
 * That is all this checks, and it is not the same question as "is the market
 * open" — which is what it was called, and what the sidebar asserted with a
 * green dot. There is no holiday calendar here, so Thanksgiving, Good Friday
 * and every other full closure read as open, and half-days read as open past
 * the 13:00 close. Adding a calendar means maintaining one; naming the
 * function for what it computes costs nothing and stops the UI claiming more.
 */
export function isRegularHours(): boolean {
  const et = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }))
  const d = et.getDay()
  const t = et.getHours() * 60 + et.getMinutes()
  return d >= 1 && d <= 5 && t >= 570 && t < 960 // 9:30 AM – 4:00 PM ET
}

export function heatColor(score: number): string {
  if (score >= 75) return '#fbbf24'  // fire
  if (score >= 65) return '#f97316'  // hot
  if (score >= 40) return '#3b82f6'  // warm
  return '#6b7280'                    // cold
}

export function heatBg(score: number): string {
  if (score >= 75) return 'rgba(251,191,36,0.15)'
  if (score >= 65) return 'rgba(249,115,22,0.15)'
  if (score >= 40) return 'rgba(59,130,246,0.15)'
  return 'rgba(107,114,128,0.15)'
}

export function sentimentColor(s: string): string {
  if (s === 'BULLISH') return '#22c55e'
  if (s === 'BEARISH') return '#ef4444'
  return '#a1a1aa'
}

export function sentimentBg(s: string): string {
  if (s === 'BULLISH') return 'rgba(34,197,94,0.12)'
  if (s === 'BEARISH') return 'rgba(239,68,68,0.12)'
  return 'rgba(161,161,170,0.12)'
}

// Generate realistic seed flow events for demo
/**
 * `generateSeedFlow` was here. It manufactured flow events — random tickers,
 * premiums up to $15M, heat scores drawn uniformly from 40 to 100, spot prices
 * hardcoded at 2024 values — and `useFlowFeed` seeded the store with fifty of
 * them on mount and invented one more every eight seconds while the socket was
 * down. The eight-second ones went through `handleEvent`, which speaks a trade
 * aloud above heat 80 and raises an OS notification above 85. Deleted: the
 * backend simulates prints when no keys are configured and flags them
 * `synthetic` where the UI can see it, so this was redundant even when honest.
 */
