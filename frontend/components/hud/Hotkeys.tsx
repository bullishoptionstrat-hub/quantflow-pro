'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { NAV, hotkeyTarget } from '@/lib/nav'
import { openPalette } from './CommandPalette'

/**
 * Keyboard-first navigation, desk style.
 *
 *   g then a key   jump to that page (the key is `NavItem.key` in `lib/nav.ts`)
 *   /              open the page palette (same as Ctrl/Cmd+K)
 *   ?              this list
 *   Esc            close this list, or cancel a pending `g`
 *
 * Every binding is navigation. None places, edits or confirms anything, so a
 * stray keystroke can at worst change the page. Keys are ignored while the
 * reader is typing (input, textarea, select, contentEditable) and whenever a
 * modifier is held, so no form field and no browser shortcut loses a key.
 *
 * The help list is built from `NAV`, the same list the sidebar and palette
 * read, so a binding cannot be listed and missing or the other way round.
 */

/** How long a pending `g` waits for its second key. */
export const CHORD_MS = 1500

export function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false
  if (t.isContentEditable) return true
  const tag = t.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}

export function Hotkeys() {
  const router = useRouter()
  const [help, setHelp] = useState(false)
  const pending = useRef<number | null>(null)

  const cancel = useCallback(() => {
    if (pending.current !== null) window.clearTimeout(pending.current)
    pending.current = null
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return
      if (isTypingTarget(e.target)) return
      if (e.key === 'Escape') { cancel(); setHelp(false); return }
      if (pending.current !== null) {
        cancel()
        const item = hotkeyTarget(e.key)
        if (item) { e.preventDefault(); setHelp(false); router.push(item.href) }
        return
      }
      if (e.key === 'g') {
        pending.current = window.setTimeout(() => { pending.current = null }, CHORD_MS)
        return
      }
      if (e.key === '?') { e.preventDefault(); setHelp((h) => !h); return }
      if (e.key === '/') { e.preventDefault(); openPalette() }
    }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey); cancel() }
  }, [router, cancel])

  if (!help) return null
  return (
    <div className="palette-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) setHelp(false) }}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts">
        <div className="palette__bar"><span className="hud-code">KEYS</span><span style={{ marginLeft: 8 }}>Navigation only — no key places or changes anything</span></div>
        <ul className="palette__list" aria-label="Shortcuts">
          <li className="palette__option"><kbd>/</kbd><span className="palette__label">Jump to a page by name</span></li>
          <li className="palette__option"><kbd>?</kbd><span className="palette__label">Show or hide this list</span></li>
          {NAV.map((n) => (
            <li key={n.href} className="palette__option" data-href={n.href}>
              <kbd>g {n.key}</kbd>
              <span className="palette__label">{n.label}</span>
              <span className="palette__path">{n.href}</span>
            </li>
          ))}
        </ul>
        <div className="palette__foot">esc close</div>
      </div>
    </div>
  )
}
