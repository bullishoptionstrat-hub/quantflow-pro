/**
 * The one list of pages.
 *
 * The sidebar, the mobile bar and the command palette all read this. Each of
 * them used to be able to hold its own list, and a hand-maintained list in
 * front of something that changes is the defect this repo keeps finding: the
 * ticker tape's fifteen symbols in front of a ten-symbol feed, the settings
 * page's three source lists. `hud.test.tsx` holds this list to the page
 * directories under `app/` in both directions.
 */

export type NavGroup = 'desk' | 'flow' | 'analytics' | 'tools'

export interface NavItem {
  href: string
  icon: string
  label: string
  badge: 'NEW' | null
  group: NavGroup
  /** The mobile bar's label. Only pages that have one appear there. */
  short?: string
  /** `g` then this key jumps here (`components/hud/Hotkeys.tsx`). Unique across NAV. */
  key: string
}

export const NAV: readonly NavItem[] = [
  // The God's Plan day starts here: the overview, then the pre-session map.
  { href: '/desk',         icon: '◫',  label: 'Desk',             badge: 'NEW', group: 'desk',      short: 'Desk', key: 'd' },
  { href: '/prep',         icon: '📋', label: 'Daily Plan',       badge: 'NEW', group: 'desk', key: 'p' },
  // "Options Flow", not "Live Flow": the tape is whatever the backend sends,
  // and on a keyless deployment that is simulated. Each row says whether it
  // was observed or constructed; the menu entry should not say it for them.
  { href: '/flow',         icon: '⚡', label: 'Options Flow',     badge: null,  group: 'flow',      short: 'Flow', key: 'f' },
  { href: '/dark-pool',    icon: '🌑', label: 'Dark Pool',        badge: null,  group: 'flow', key: 'o' },
  { href: '/power-alerts', icon: '🔥', label: 'Power Alerts',     badge: null,  group: 'flow',      short: 'Alerts', key: 'a' },
  { href: '/heat-map',     icon: '🗺', label: 'Heat Map',         badge: null,  group: 'flow', key: 'h' },
  { href: '/gex',          icon: 'Γ',  label: 'GEX Levels',       badge: null,  group: 'analytics', short: 'GEX', key: 'x' },
  { href: '/structure',    icon: '⌗',  label: 'Structure Map',    badge: 'NEW', group: 'analytics', key: 'm' },
  { href: '/setups',       icon: '⟲',  label: 'Setup Replay',     badge: 'NEW', group: 'analytics', key: 's' },
  { href: '/backtest',     icon: '⏮', label: 'Scanner Backtest', badge: 'NEW', group: 'analytics', key: 'b' },
  { href: '/macro',        icon: '📊', label: 'Macro',            badge: 'NEW', group: 'analytics', key: 'e' },
  { href: '/news',         icon: '📰', label: 'News & Sentiment', badge: 'NEW', group: 'analytics', key: 'n' },
  { href: '/ticket',       icon: '🧾', label: 'Trade Ticket',     badge: 'NEW', group: 'tools',     short: 'Ticket', key: 't' },
  { href: '/journal',      icon: '📓', label: 'Trade Journal',    badge: 'NEW', group: 'tools', key: 'j' },
  { href: '/risk',         icon: '🎯', label: 'Risk & Size',      badge: 'NEW', group: 'tools',     short: 'Risk', key: 'r' },
  { href: '/calculator',   icon: '🧮', label: 'P/L Calculator',   badge: null,  group: 'tools',     short: 'Calc', key: 'c' },
  { href: '/optimizer',    icon: '⚙', label: 'Optimizer',        badge: null,  group: 'tools', key: 'z' },
  { href: '/watchlist',    icon: '★',  label: 'Watchlist',        badge: null,  group: 'tools',     short: 'Watch', key: 'w' },
  { href: '/settings',     icon: '⚙', label: 'Settings',         badge: null,  group: 'tools', key: ',' },
]

export const NAV_GROUPS: readonly { id: NavGroup; label: string }[] = [
  { id: 'desk', label: 'DESK' },
  { id: 'flow', label: 'FLOW' },
  { id: 'analytics', label: 'ANALYTICS' },
  { id: 'tools', label: 'TOOLS' },
]

/** Whether `pathname` is inside the page `href` names. */
export function isActive(pathname: string | null, href: string): boolean {
  if (!pathname) return false
  return pathname === href || pathname.startsWith(`${href}/`)
}

/**
 * How well `query` matches `text`, or `null` when it does not match at all.
 *
 * Tiers rather than a tuned formula, so the order is explainable: the whole
 * text starting with the query beats a word starting with it, which beats the
 * query appearing anywhere, which beats its letters appearing in order with
 * gaps (fewer gaps ranks higher). An empty query matches everything equally,
 * so the palette shows the list in its own order.
 */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.trim().toLowerCase()
  const t = text.toLowerCase()
  if (q === '') return 0
  if (t.startsWith(q)) return 400
  const at = t.indexOf(q)
  if (at > 0) return /[a-z0-9]/.test(t[at - 1]!) ? 200 : 300
  let gaps = 0
  let i = 0
  let last = -1
  for (const ch of q) {
    if (ch === ' ') continue
    const found = t.indexOf(ch, i)
    if (found < 0) return null
    if (last >= 0) gaps += found - last - 1
    last = found
    i = found + 1
  }
  return Math.max(1, 100 - gaps)
}

/** `NAV` filtered to what matches `query`, best first; ties keep list order. */
export function rankNav(query: string, items: readonly NavItem[] = NAV): NavItem[] {
  const scored: { item: NavItem; score: number; index: number }[] = []
  items.forEach((item, index) => {
    const byLabel = fuzzyScore(query, item.label)
    const byPath = fuzzyScore(query, item.href.slice(1).replace(/-/g, ' '))
    const best = Math.max(byLabel ?? -1, byPath ?? -1)
    if (best >= 0) scored.push({ item, score: best, index })
  })
  scored.sort((a, b) => b.score - a.score || a.index - b.index)
  return scored.map((s) => s.item)
}

/** The page the chord `g` + `key` names, or `null`. Case-insensitive for letters. */
export function hotkeyTarget(key: string, items: readonly NavItem[] = NAV): NavItem | null {
  const k = key.length === 1 ? key.toLowerCase() : key
  return items.find((n) => n.key === k) ?? null
}
