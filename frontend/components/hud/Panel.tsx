'use client'
import { useId, type CSSProperties, type HTMLAttributes, type ReactNode } from 'react'

/**
 * A titled desk panel: a title bar over a `.card` body.
 *
 * `code` is a provenance tag — where the numbers inside come from
 * (`TRADER INPUT`, `BROWSER CALC`, `THIS BROWSER`). It is deliberately not a
 * serial like `RSK-01`: a number on screen that measures nothing is the thing
 * this terminal keeps removing, and a decorative one is no better than a
 * fabricated one.
 *
 * The section is labelled by its title, so it is a named region for a screen
 * reader. Titles must not equal a form label inside the page: Testing Library's
 * `getByLabelText` matches `aria-labelledby` too, and the page tests query
 * their fields by label.
 */
export interface PanelProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  title: string
  /** Where the panel's numbers come from. Never a serial number. */
  code?: string
  status?: ReactNode
  asOf?: ReactNode
  actions?: ReactNode
  bodyStyle?: CSSProperties
}

export function Panel({ title, code, status, asOf, actions, bodyStyle, className, children, ...rest }: PanelProps) {
  const id = useId()
  const slots = status != null || asOf != null || actions != null
  return (
    <section className={className ? `card hud-panel ${className}` : 'card hud-panel'} aria-labelledby={id} {...rest}>
      <header className="hud-panel__bar">
        <h2 id={id} className="hud-title">{title}</h2>
        {code && <span className="hud-code" title="Where the numbers in this panel come from">{code}</span>}
        {slots && (
          <span className="hud-panel__slots">
            {status}
            {asOf}
            {actions}
          </span>
        )}
      </header>
      <div className="hud-panel__body" style={{ padding: 16, ...bodyStyle }}>
        {children}
      </div>
    </section>
  )
}
