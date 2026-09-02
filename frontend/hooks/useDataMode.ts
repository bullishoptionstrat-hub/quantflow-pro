'use client'
import { useEffect, useState } from 'react'
import { clientDataMode } from '@/lib/utils'

export interface DataModeState {
  /** Backend-reported mode, or the client default until the health call returns. */
  dataMode: 'live' | 'demo'
  /** True once the backend has actually confirmed the mode. */
  confirmed: boolean
}

/**
 * Resolves the effective DATA_MODE.
 *
 * Starts from the client default (demo — see clientDataMode) and upgrades to
 * the backend's answer once /api/health responds. It never optimistically
 * assumes 'live': if the backend is unreachable we keep showing DEMO, because
 * an unverified feed must not be presented as real market data.
 */
export function useDataMode(): DataModeState {
  const [state, setState] = useState<DataModeState>({ dataMode: clientDataMode(), confirmed: false })

  useEffect(() => {
    let cancelled = false
    fetch('/api/health')
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => {
        if (cancelled || !body) return
        const mode = body.dataMode === 'live' ? 'live' : 'demo'
        setState({ dataMode: mode, confirmed: true })
      })
      .catch((err) => {
        // Never silent: log the cause, and stay on the low-trust default.
        console.warn('[useDataMode] health check failed, staying in demo:', err?.message ?? err)
      })
    return () => { cancelled = true }
  }, [])

  return state
}
