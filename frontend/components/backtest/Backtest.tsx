'use client'
import { useEffect, useState } from 'react'
import { apiFetch } from '@/lib/apiFetch'
import {
  loadPresets, savePreset, deletePreset, type ScannerPreset,
} from '@/lib/presets'
import type { BacktestResponse, BacktestRow, ScannerFilter } from '@/lib/types'

/**
 * The scanner backtest surface: build a filter, run it, read back how the
 * signals it selected actually performed — and save the filter as a preset so
 * the terminal becomes a habit. Roadmap 4.1 (backtest) and 5.1 (presets).
 *
 * Two honesty rules are load-bearing in what this draws, both inherited from
 * the backend rather than re-decided here:
 *
 *   - A bucket below `minSample` graded outcomes has **no** `hitRate` — the
 *     field is absent, not zero. This renders "SUPPRESSED (n<30)" and the
 *     sample size, never a 0%. Binding `hitRate ?? 0` would manufacture the
 *     flattering-or-damning number the endpoint exists to withhold.
 *   - The measured interval is shown beside the horizon whenever they differ,
 *     because a rate filed under M15 but measured over 32 minutes is not a
 *     15-minute rate. The backend already says so in `notes`; the row makes it
 *     visible at a glance.
 *
 * The `disclaimer` and every `note` the backend returns are rendered verbatim.
 * They are the sentences that keep the numbers beside them honest; editing or
 * summarising them here would be the exact move this product refuses.
 */

const KINDS = ['SWEEP', 'BLOCK', 'SPLIT', 'MULTI_LEG', 'LARGE']
const SIDES = ['BUY', 'SELL']

/** The form's own draft state, all strings so an empty field is not a 0. */
interface Draft {
  kinds: string[]
  underlyings: string
  sides: string[]
  minPremium: string
  minSize: string
  minScore: string
  isoOnly: boolean
}

const EMPTY_DRAFT: Draft = {
  kinds: [], underlyings: '', sides: [], minPremium: '', minSize: '', minScore: '', isoOnly: false,
}

/** Turn the draft into the wire filter, dropping empty/unset fields. */
function draftToFilter(d: Draft): ScannerFilter {
  const f: ScannerFilter = {}
  if (d.kinds.length) f.kinds = d.kinds
  const unds = d.underlyings.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)
  if (unds.length) f.underlyings = unds
  if (d.sides.length) f.sides = d.sides
  const num = (s: string) => (s.trim() === '' ? undefined : Number(s))
  const mp = num(d.minPremium); if (mp !== undefined && Number.isFinite(mp)) f.minPremium = mp
  const msz = num(d.minSize); if (msz !== undefined && Number.isFinite(msz)) f.minSize = msz
  const msc = num(d.minScore); if (msc !== undefined && Number.isFinite(msc)) f.minScore = msc
  if (d.isoOnly) f.isoOnly = true
  return f
}

/** Rebuild a draft from a saved filter, for loading a preset back in. */
function filterToDraft(f: ScannerFilter): Draft {
  return {
    kinds: f.kinds ?? [],
    underlyings: (f.underlyings ?? []).join(', '),
    sides: f.sides ?? [],
    minPremium: f.minPremium != null ? String(f.minPremium) : '',
    minSize: f.minSize != null ? String(f.minSize) : '',
    minScore: f.minScore != null ? String(f.minScore) : '',
    isoOnly: f.isoOnly === true,
  }
}

const mins = (ms: number) => Math.round(ms / 60_000)

export function Backtest() {
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT)
  const [result, setResult] = useState<BacktestResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [presets, setPresets] = useState<ScannerPreset[]>([])
  const [presetName, setPresetName] = useState('')

  // Presets live in localStorage, which does not exist during SSR — so they
  // load on mount, client-side, and the list is empty until then.
  useEffect(() => { setPresets(loadPresets()) }, [])

  const toggle = (arr: string[], v: string) =>
    arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]

  async function run() {
    setLoading(true)
    setError(null)
    try {
      const res = await apiFetch('/api/backtest', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(draftToFilter(draft)),
      })
      const body = await res.json()
      if (!res.ok) {
        // The backend's 400 detail is the useful message ("an empty set matches
        // nothing"), so surface it rather than a bare status.
        throw new Error(body?.detail || body?.error || `backend returned ${res.status}`)
      }
      setResult(body as BacktestResponse)
    } catch (e: any) {
      setResult(null)
      setError(e?.message ?? 'could not reach the backend')
    } finally {
      setLoading(false)
    }
  }

  function onSavePreset() {
    const name = presetName.trim()
    if (!name) return
    setPresets(savePreset(name, draftToFilter(draft)))
    setPresetName('')
  }

  function onLoadPreset(p: ScannerPreset) {
    setDraft(filterToDraft(p.filter))
  }

  function onDeletePreset(id: string) {
    setPresets(deletePreset(id))
  }

  const chip = (active: boolean) => ({
    padding: '5px 12px', borderRadius: 5,
    border: `1px solid ${active ? 'rgba(139,92,246,0.5)' : 'var(--border)'}`,
    background: active ? 'rgba(139,92,246,0.15)' : 'var(--bg-secondary)',
    color: active ? '#a78bfa' : 'var(--text-secondary)',
    fontSize: 12, fontWeight: 600, cursor: 'pointer',
    fontFamily: "'JetBrains Mono', monospace",
  })
  const input: React.CSSProperties = {
    padding: '6px 10px', borderRadius: 5, border: '1px solid var(--border)',
    background: 'var(--bg-secondary)', color: '#fafafa', fontSize: 12,
    fontFamily: "'JetBrains Mono', monospace", width: '100%',
  }
  const label: React.CSSProperties = {
    fontSize: 10, color: 'var(--text-muted)', fontWeight: 700, marginBottom: 5,
    letterSpacing: '0.04em', textTransform: 'uppercase',
  }

  return (
    <div>
      {/* ── Saved presets ─────────────────────────────────────────────── */}
      <div className="card" style={{ padding: 14, marginBottom: 16 }}>
        <div style={label}>Saved scanners</div>
        {presets.length === 0 ? (
          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            None yet. Build a filter below and save it — presets live in this browser only.
          </div>
        ) : (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {presets.map((p) => (
              <div key={p.id} style={{
                display: 'flex', alignItems: 'center', gap: 6, padding: '4px 6px 4px 12px',
                borderRadius: 5, border: '1px solid var(--border)', background: 'var(--bg-secondary)',
              }}>
                <button onClick={() => onLoadPreset(p)} style={{
                  background: 'none', border: 'none', color: '#a78bfa', fontSize: 12, fontWeight: 600,
                  cursor: 'pointer', fontFamily: "'JetBrains Mono', monospace", padding: 0,
                }} title="Load this scanner into the filter">{p.name}</button>
                <button onClick={() => onDeletePreset(p.id)} aria-label={`delete ${p.name}`} style={{
                  background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: 14,
                  cursor: 'pointer', lineHeight: 1, padding: '0 2px',
                }} title="Delete">×</button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Filter builder ────────────────────────────────────────────── */}
      <div className="card" style={{ padding: 16, marginBottom: 16 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 16 }}>
          <div>
            <div style={label}>Kinds</div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {KINDS.map((k) => (
                <button key={k} style={chip(draft.kinds.includes(k))}
                  onClick={() => setDraft({ ...draft, kinds: toggle(draft.kinds, k) })}>{k}</button>
              ))}
            </div>
          </div>
          <div>
            <div style={label}>Sides</div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {SIDES.map((s) => (
                <button key={s} style={chip(draft.sides.includes(s))}
                  onClick={() => setDraft({ ...draft, sides: toggle(draft.sides, s) })}>{s}</button>
              ))}
              <button style={chip(draft.isoOnly)}
                onClick={() => setDraft({ ...draft, isoOnly: !draft.isoOnly })}
                title="Intermarket-sweep prints only">ISO ONLY</button>
            </div>
          </div>
          <div>
            <div style={label}>Underlyings (comma-separated)</div>
            <input style={input} value={draft.underlyings} placeholder="SPY, QQQ, NVDA"
              onChange={(e) => setDraft({ ...draft, underlyings: e.target.value })} />
          </div>
          <div>
            <div style={label}>Min premium ($)</div>
            <input style={input} value={draft.minPremium} placeholder="100000" inputMode="numeric"
              onChange={(e) => setDraft({ ...draft, minPremium: e.target.value })} />
          </div>
          <div>
            <div style={label}>Min size (contracts)</div>
            <input style={input} value={draft.minSize} placeholder="50" inputMode="numeric"
              onChange={(e) => setDraft({ ...draft, minSize: e.target.value })} />
          </div>
          <div>
            <div style={label}>Min score</div>
            <input style={input} value={draft.minScore} placeholder="70" inputMode="numeric"
              onChange={(e) => setDraft({ ...draft, minScore: e.target.value })} />
          </div>
        </div>

        <div style={{ display: 'flex', gap: 10, marginTop: 16, flexWrap: 'wrap', alignItems: 'center' }}>
          <button onClick={run} disabled={loading} style={{
            padding: '8px 20px', borderRadius: 6, border: '1px solid rgba(139,92,246,0.5)',
            background: 'rgba(139,92,246,0.2)', color: '#a78bfa', fontSize: 13, fontWeight: 700,
            cursor: loading ? 'wait' : 'pointer', fontFamily: "'JetBrains Mono', monospace",
          }}>{loading ? 'RUNNING…' : 'RUN BACKTEST'}</button>
          <button onClick={() => { setDraft(EMPTY_DRAFT); setResult(null); setError(null) }} style={{
            padding: '8px 16px', borderRadius: 6, border: '1px solid var(--border)',
            background: 'var(--bg-secondary)', color: 'var(--text-secondary)', fontSize: 12,
            cursor: 'pointer', fontFamily: "'JetBrains Mono', monospace",
          }}>RESET</button>
          <div style={{ flex: 1 }} />
          <input style={{ ...input, width: 180 }} value={presetName} placeholder="Name this scanner…"
            onChange={(e) => setPresetName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') onSavePreset() }} />
          <button onClick={onSavePreset} disabled={!presetName.trim()} style={{
            padding: '8px 16px', borderRadius: 6, border: '1px solid var(--border)',
            background: 'var(--bg-secondary)',
            color: presetName.trim() ? '#fafafa' : 'var(--text-muted)',
            fontSize: 12, cursor: presetName.trim() ? 'pointer' : 'default',
            fontFamily: "'JetBrains Mono', monospace",
          }}>SAVE PRESET</button>
        </div>
      </div>

      {/* ── Results ───────────────────────────────────────────────────── */}
      {error && (
        <div className="card" style={{ padding: 20, textAlign: 'center', color: '#fca5a5', fontSize: 12 }}>
          The backtest did not run — {error}.
        </div>
      )}

      {result && !error && <Results result={result} />}
    </div>
  )
}

function Results({ result }: { result: BacktestResponse }) {
  const empty = result.matched === 0 || result.rows.length === 0

  return (
    <>
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
          <span style={{ fontWeight: 700, fontSize: 13 }}>BACKTEST RESULT</span>
          <span style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: "'JetBrains Mono', monospace" }}>
            {result.matched} matched · store: {result.storeKind} · {new Date(result.generatedAt).toLocaleTimeString()}
          </span>
        </div>

        {empty ? (
          <div style={{ padding: '28px 16px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 12, lineHeight: 1.6 }}>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>Nothing to show for this filter</div>
            <div style={{ maxWidth: 520, margin: '0 auto' }}>
              {result.matched === 0
                ? 'No signal in the record matched this scanner. This is a statement about the filter and the history collected so far, not about any signal having failed.'
                : 'Signals matched, but none survived to a published row — they were synthetic, event-time-only, rights-refused, or ungraded. See the notes below.'}
            </div>
          </div>
        ) : (
          <table className="flow-table">
            <thead>
              <tr>
                <th>KIND</th><th>HORIZON</th><th>HIT RATE</th><th>GRADED</th>
                <th>UNGRADED</th><th>MED. EXCURSION</th><th>MEASURED OVER</th>
              </tr>
            </thead>
            <tbody>
              {result.rows.map((r: BacktestRow) => {
                const mi = r.measuredInterval
                const drift = mi?.medianMs != null && mi.nominalMs != null && mi.medianMs > mi.nominalMs
                return (
                  <tr key={`${r.kind}|${r.horizon}`}>
                    <td style={{ fontWeight: 700, color: '#a78bfa' }}>{r.kind}</td>
                    <td style={{ fontFamily: "'JetBrains Mono', monospace" }}>{r.horizon}</td>
                    <td>
                      {/* Suppressed vs. a real rate: never a 0 standing in for
                          "not enough sample". The whole endpoint is this cell. */}
                      {r.suppressionReason === 'INSUFFICIENT_SAMPLE' || r.hitRate == null ? (
                        <span style={{ color: '#fde68a', fontSize: 11, fontWeight: 700 }}
                          title={`Below the ${result.minSample}-outcome floor — no rate is published`}>
                          SUPPRESSED (n&lt;{result.minSample})
                        </span>
                      ) : (
                        <span style={{ color: r.hitRate >= 0.5 ? '#22c55e' : '#ef4444', fontWeight: 700 }}>
                          {(r.hitRate * 100).toFixed(1)}%
                        </span>
                      )}
                    </td>
                    <td style={{ fontFamily: "'JetBrains Mono', monospace" }}>{r.nGraded}</td>
                    <td style={{ fontFamily: "'JetBrains Mono', monospace", color: r.nUngraded > 0 ? '#fde68a' : 'var(--text-muted)' }}>
                      {r.nUngraded}
                    </td>
                    <td style={{ color: r.medianExcursion != null ? (r.medianExcursion >= 0 ? '#22c55e' : '#ef4444') : 'var(--text-muted)', fontFamily: "'JetBrains Mono', monospace" }}>
                      {r.medianExcursion != null ? `${(r.medianExcursion * 100).toFixed(2)}%` : '—'}
                    </td>
                    <td style={{ fontSize: 11, fontFamily: "'JetBrains Mono', monospace", color: drift ? '#fde68a' : 'var(--text-muted)' }}>
                      {mi?.medianMs != null
                        ? `${mins(mi.medianMs)}min${mi.nominalMs != null ? ` / ${mins(mi.nominalMs)} nominal` : ''}`
                        : '—'}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Exclusions, scoped to the matched population. */}
      {(result.excluded.synthetic > 0 || result.excluded.eventTimeOnlyBasis > 0 || result.excluded.rightsRefused > 0) && (
        <div className="card" style={{ padding: 14, marginBottom: 16 }}>
          <div style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 700, marginBottom: 8, letterSpacing: '0.04em' }}>
            EXCLUDED FROM RATES (matched, but not counted)
          </div>
          <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', fontSize: 12, fontFamily: "'JetBrains Mono', monospace" }}>
            <span>synthetic: <strong style={{ color: '#fde68a' }}>{result.excluded.synthetic}</strong></span>
            <span>event-time-only: <strong style={{ color: '#fde68a' }}>{result.excluded.eventTimeOnlyBasis}</strong></span>
            <span>rights-refused: <strong style={{ color: '#fde68a' }}>{result.excluded.rightsRefused}</strong></span>
          </div>
        </div>
      )}

      {/* The backend's own notes and disclaimer, verbatim. These are the
          sentences that keep the numbers honest; they are not summarised. */}
      {result.notes.length > 0 && (
        <div className="card" style={{ padding: 14, marginBottom: 16 }}>
          <div style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 700, marginBottom: 8, letterSpacing: '0.04em' }}>NOTES</div>
          <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {result.notes.map((n, i) => (
              <li key={i} style={{ fontSize: 11, lineHeight: 1.6, color: 'var(--text-secondary)' }}>{n}</li>
            ))}
          </ul>
        </div>
      )}

      <div style={{ fontSize: 11, lineHeight: 1.6, color: 'var(--text-muted)', padding: '0 4px' }}>
        {result.disclaimer}
      </div>
    </>
  )
}
