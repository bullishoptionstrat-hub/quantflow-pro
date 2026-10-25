'use client'
import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { signOut } from '@/lib/signOut'

/**
 * Rendered only while a session exists. The layout mounts the sidebar on
 * /login too, and a sign-out control there would be a button that does
 * nothing.
 */
export function SignOutButton({ variant = 'sidebar' }: { variant?: 'sidebar' | 'mobile' }) {
  const [signedIn, setSignedIn] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    supabase.auth.getSession().then(({ data }) => {
      if (live) setSignedIn(Boolean(data.session))
    })
    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      setSignedIn(Boolean(session))
    })
    return () => {
      live = false
      data.subscription.unsubscribe()
    }
  }, [])

  if (!signedIn) return null

  async function onClick() {
    setBusy(true)
    setError(null)
    const result = await signOut()
    // On success the page is already navigating away; only a failure stays.
    if (result.error) {
      setError(result.error)
      setBusy(false)
    }
  }

  if (variant === 'mobile') {
    return (
      <button
        type="button"
        onClick={onClick}
        disabled={busy}
        title={error ?? 'Sign out'}
        style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, padding: '4px 12px', color: error ? '#f87171' : 'var(--text-secondary)', background: 'none', border: 'none', cursor: 'pointer' }}
      >
        <span style={{ fontSize: 18 }}>⎋</span>
        <span style={{ fontSize: 10 }}>{busy ? '…' : error ? 'Retry' : 'Sign out'}</span>
      </button>
    )
  }

  return (
    <div style={{ marginBottom: 8 }}>
      <button
        type="button"
        onClick={onClick}
        disabled={busy}
        style={{ width: '100%', textAlign: 'left', fontSize: 11, fontFamily: "'JetBrains Mono', monospace", color: 'var(--text-secondary)', background: 'none', border: '1px solid var(--border)', borderRadius: 4, padding: '5px 8px', cursor: busy ? 'default' : 'pointer' }}
      >
        {busy ? 'SIGNING OUT…' : '⎋ SIGN OUT'}
      </button>
      {error && (
        <div role="alert" style={{ marginTop: 4, fontSize: 10, color: '#f87171' }}>
          {error}
        </div>
      )}
    </div>
  )
}
