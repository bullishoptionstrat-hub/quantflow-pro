/**
 * Display formatters, extracted from the pages that used to hide them.
 *
 * These lived as module-local functions inside `app/macro/page.tsx`, which
 * meant they could not be tested at all — and one of them was wrong in a way
 * that mattered. `cryptoPrice` rendered any sub-$1 asset with `toFixed(4)`, so
 * SHIB at 0.0000058 displayed as **$0.0000**: a live quote shown as zero, the
 * same defect as the dead sources it sat beside, arriving through the
 * formatter instead. It was caught by eye in a screenshot. It should have been
 * caught by a test, and now can be.
 */

/** Compact money for large magnitudes; a plain number below a million. */
export function fmt(n: number, decimals = 2): string {
  if (n >= 1e12) return `$${(n / 1e12).toFixed(1)}T`
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`
  return n.toFixed(decimals)
}

/** Green up, red down, muted flat. */
export function pctColor(v: number): string {
  if (v > 0) return '#22c55e'
  if (v < 0) return '#ef4444'
  return 'var(--text-muted)'
}

/**
 * Grey for a ratio we do not have. Absence is not a reading.
 *
 * The old inline expression was `(data?.pcr ?? 0) > 1 ? red : green`, which
 * resolved *green* for a missing ratio — colouring an unavailable put/call
 * reading as bullish.
 */
export function pcrColor(v: number | null | undefined): string {
  if (v == null) return 'var(--text-muted)'
  return v > 1 ? '#ef4444' : '#22c55e'
}

/**
 * A crypto price, at enough precision to be a price.
 *
 * Sub-cent assets get significant digits rather than fixed decimals, because
 * four decimal places is not enough to express one. Trailing zeros are trimmed
 * back off so the result reads as a number rather than a padded field.
 */
export function cryptoPrice(v: number): string {
  if (v >= 1) return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  if (v >= 0.01) return v.toFixed(4)
  if (!(v > 0)) return '0'
  const places = Math.max(4, -Math.floor(Math.log10(v)) + 3)
  return v.toFixed(places).replace(/0+$/, '').replace(/\.$/, '')
}

/**
 * An equity or index price, with a thousands separator.
 *
 * The ticker tape used `toFixed(q.price > 100 ? 2 : 2)` — a branch on price
 * with identical arms, which is what a formatter looks like after the
 * distinction it was written for is gone. An index at 5587 reads as a price
 * with the separator and as a serial number without it.
 */
export function spotPrice(v: number): string {
  // Below a dollar this hands off to `cryptoPrice`, because the SHIB defect
  // above is not a fact about crypto — it is what two fixed decimals do to a
  // small number, and `toFixed(2)` on a sub-cent price prints $0.00 whatever
  // the asset is. The tape renders whichever symbols the feed carries rather
  // than a list we control, so "no equity trades under a dollar" is not ours
  // to assume. The two agree above a dollar by construction.
  if (v < 1) return cryptoPrice(v)
  return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

/**
 * A signed percentage, for a change that is only readable with its direction.
 *
 * `-0.4%` carries its sign; `+0.4%` does not unless something adds it, and a
 * tape that shows one and not the other reads as if every quote were down.
 */
export function signedPct(v: number): string {
  return `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`
}
