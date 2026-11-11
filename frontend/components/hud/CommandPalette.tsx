'use client'
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { useRouter } from 'next/navigation'
import { rankNav, type NavItem } from '@/lib/nav'

/**
 * Ctrl+K / ⌘K: jump to any page by typing part of its name.
 *
 * The list is `NAV` from `lib/nav.ts` — the same list the sidebar draws — so a
 * page cannot be reachable from one and missing from the other. It navigates
 * and does nothing else: no actions, no search over data, nothing that would
 * need a result the terminal does not have.
 *
 * Accessibility: a modal dialog holding a combobox and its listbox. Focus goes
 * to the input on open, stays inside the dialog while it is open (Tab is held),
 * and returns to whatever had it before on close.
 */

export const OPEN_PALETTE_EVENT = 'qf:open-palette'

/** Open the palette from anywhere, e.g. the status strip's button. */
export function openPalette(): void {
  window.dispatchEvent(new CustomEvent(OPEN_PALETTE_EVENT))
}

const FOCUSABLE = 'input, button, select, textarea, a[href], [tabindex]:not([tabindex="-1"])'

export function CommandPalette() {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const openRef = useRef(false)
  const returnTo = useRef<HTMLElement | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const listId = useId()
  const results = useMemo(() => rankNav(query), [query])

  const show = useCallback(() => {
    if (openRef.current) return
    returnTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    openRef.current = true
    setQuery('')
    setActive(0)
    setOpen(true)
  }, [])

  const close = useCallback(() => {
    if (!openRef.current) return
    openRef.current = false
    setOpen(false)
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        if (openRef.current) close()
        else show()
      }
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener(OPEN_PALETTE_EVENT, show)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener(OPEN_PALETTE_EVENT, show)
    }
  }, [show, close])

  // Focus in on open, back out on close.
  useEffect(() => {
    if (open) {
      inputRef.current?.focus()
      return
    }
    const back = returnTo.current
    returnTo.current = null
    if (back && back.isConnected) back.focus()
  }, [open])

  const go = (item: NavItem | undefined) => {
    if (!item) return
    close()
    router.push(item.href)
  }

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const n = results.length
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        if (n > 0) setActive((a) => (a + 1) % n)
        break
      case 'ArrowUp':
        e.preventDefault()
        if (n > 0) setActive((a) => (a - 1 + n) % n)
        break
      case 'Home':
        if (n > 0) { e.preventDefault(); setActive(0) }
        break
      case 'End':
        if (n > 0) { e.preventDefault(); setActive(n - 1) }
        break
      case 'Enter':
        e.preventDefault()
        go(results[active])
        break
      case 'Escape':
        e.preventDefault()
        close()
        break
      case 'Tab': {
        // Hold focus inside the dialog: wrap between its first and last
        // focusable elements (today the input is the only one).
        const items = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])
        e.preventDefault()
        if (items.length === 0) return
        const at = items.indexOf(document.activeElement as HTMLElement)
        const next = e.shiftKey
          ? items[(at <= 0 ? items.length : at) - 1]
          : items[(at + 1) % items.length]
        next?.focus()
        break
      }
    }
  }

  if (!open) return null

  const activeId = results.length > 0 ? `${listId}-opt-${Math.min(active, results.length - 1)}` : undefined

  return (
    <div className="palette-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) close() }}>
      <div ref={dialogRef} className="palette" role="dialog" aria-modal="true" aria-label="Jump to page" onKeyDown={onKeyDown}>
        <div className="palette__bar">
          <span className="hud-code" aria-hidden="true">JUMP</span>
          <input
            ref={inputRef}
            className="palette__input"
            role="combobox"
            aria-expanded={results.length > 0}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={activeId}
            aria-label="Page name"
            placeholder="Type a page name…"
            autoComplete="off"
            spellCheck={false}
            value={query}
            onChange={(e) => { setQuery(e.target.value); setActive(0) }}
          />
          <kbd className="palette__kbd">ESC</kbd>
        </div>
        <ul id={listId} role="listbox" aria-label="Pages" className="palette__list">
          {results.map((item, i) => (
            <li
              key={item.href}
              id={`${listId}-opt-${i}`}
              role="option"
              aria-selected={i === active}
              data-href={item.href}
              className="palette__option"
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => go(item)}
            >
              <span className="palette__icon" aria-hidden="true">{item.icon}</span>
              <span className="palette__label">{item.label}</span>
              <span className="palette__path">{item.href}</span>
            </li>
          ))}
        </ul>
        {results.length === 0 && (
          <div className="palette__empty" role="status">No page matches &ldquo;{query}&rdquo;</div>
        )}
        <div className="palette__foot" aria-hidden="true">↑ ↓ move · ↵ open · esc close</div>
      </div>
    </div>
  )
}
