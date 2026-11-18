'use client'
import { useMemo, useState } from 'react'
import { apiFetch } from '@/lib/apiFetch'
import { Panel } from '@/components/hud/Panel'

/**
 * The structure engine over bars the trader imports — read only.
 *
 * Posts to `/api/setups/structure`, which runs `runStructureReplay`, the same
 * function the `research:structure-replay` CLI runs. The page decides nothing:
 * it lists the events the engine published, each with the close it became
 * knowable at (`knownAt`) and the method version it was computed under. A
 * field the backend did not send is not rendered; nothing is filled in.
 */

const MONO = "'JetBrains Mono', monospace"
/** The table shows at most this many rows of the filtered list, and says so. */
export const STRUCTURE_ROW_CAP = 500

export interface StructureEvent {
  id: string
  kind: string
  symbol: string
  knownAt: number
  methodVersion: string
  evidence?: { id: string; closedAt: number }[]
  [k: string]: unknown
}
export interface StructureReport {
  scope: string
  configHash: string
  methodVersion: string
  rulesVersion: string
  symbol: string
  pairSymbol: string | null
  asOf: number
  datasets: { symbol: string; contentId: string; provenance: string; timestampMarks: string; rejected: unknown[]; gaps: unknown[] }[]
  counts: { events: number; byKind: Record<string, number> }
  notComputed: { name: string; status: string; reason: string }[]
  events: StructureEvent[]
}

export interface StructureInputs {
  symbol: string
  pairSymbol: string
  file: string | null
  pairFile: string | null
  marks: '' | 'OPEN' | 'CLOSE'
}

/** Which required inputs are missing. Empty means ready. The pair is optional, but half a pair is not. */
export function missingStructureInputs(i: StructureInputs): string[] {
  const m: string[] = []
  const s = i.symbol.trim().toUpperCase(), p = i.pairSymbol.trim().toUpperCase()
  if (s === '') m.push('Symbol')
  if (i.file === null) m.push('CSV for the symbol')
  if (p !== '' && i.pairFile === null) m.push('CSV for the pair')
  if (p === '' && i.pairFile !== null) m.push('Pair symbol for the pair CSV')
  if (s !== '' && s === p) m.push('A pair different from the symbol')
  if (i.marks === '') m.push('Timestamp convention')
  return m
}

/** New York wall-clock time with the zone named, never the browser's own zone. */
export function fmtEt(ms: number): string {
  const s = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(ms))
  return `${s} ET`
}

/** Fields shown per event, in this order, when the event carries them. Nothing is computed here. */
const SUMMARY_FIELDS = ['direction', 'side', 'name', 'status', 'price', 'level', 'broken', 'close', 'trendAfter', 'bottom', 'top', 'eq', 'high', 'low', 'extreme', 'ratio', 'pairSymbol', 'reason'] as const

export function eventSummary(e: StructureEvent): string {
  const parts: string[] = []
  for (const k of SUMMARY_FIELDS) {
    const v = e[k]
    if (v === undefined) continue
    if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') parts.push(`${k} ${v}`)
    else if (typeof v === 'object' && v !== null && 'price' in (v as object)) {
      const o = v as { name?: unknown; kind?: unknown; price?: unknown }
      const label = o.name ?? o.kind
      parts.push(`${k} ${label !== undefined ? `${String(label)} ` : ''}${String(o.price)}`)
    }
  }
  return parts.join(' · ')
}

type State =
  | { kind: 'idle' }
  | { kind: 'running' }
  | { kind: 'refused'; reasons: string[] }
  | { kind: 'error'; message: string }
  | { kind: 'ok'; report: StructureReport }

export function StructureReplay() {
  const [inp, setInp] = useState<StructureInputs>({ symbol: '', pairSymbol: '', file: null, pairFile: null, marks: '' })
  const [state, setState] = useState<State>({ kind: 'idle' })
  const missing = missingStructureInputs(inp)

  const readFile = (key: 'file' | 'pairFile') => async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    const text = f ? await f.text() : null
    setInp((p) => ({ ...p, [key]: text }))
  }

  async function run() {
    if (missing.length > 0) return
    const s = inp.symbol.trim().toUpperCase(), p = inp.pairSymbol.trim().toUpperCase()
    setState({ kind: 'running' })
    try {
      const res = await apiFetch('/api/setups/structure', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          config: { symbol: s, ...(p !== '' ? { pairSymbol: p } : {}), timestampMarks: inp.marks },
          csv: p !== '' ? { [s]: inp.file, [p]: inp.pairFile } : { [s]: inp.file },
        }),
      })
      const body = await res.json().catch(() => null) as any
      if (body?.status === 'REFUSED' && Array.isArray(body.reasons)) return setState({ kind: 'refused', reasons: body.reasons })
      if (!res.ok || body?.status !== 'OK') return setState({ kind: 'error', message: `The backend answered ${res.status}${res.status === 401 ? ' — this session was not accepted' : ''}.` })
      setState({ kind: 'ok', report: body.report })
    } catch {
      setState({ kind: 'error', message: 'The backend did not answer.' })
    }
  }

  const field = { background: 'var(--bg-input, #0b1220)', color: 'inherit', border: '1px solid var(--border, #334155)', padding: '6px 8px', fontFamily: MONO, fontSize: 12 }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: 16 }}>
      <Panel title="STRUCTURE MAP" code="USER IMPORT">
        <p style={{ fontSize: 12, margin: '0 0 12px' }}>
          Runs the structure engine over 1-minute bars you import: swings, session levels, dealing ranges, displacement, the FVG lifecycle,
          sweeps, BOS/CHoCH, and SMT when you add a pair. Each event shows the close it became knowable at.
          <strong> These are untuned, versioned definitions, not signals.</strong> Nothing is stored.
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10 }}>
          <label>Symbol<input aria-label="Symbol" style={field} value={inp.symbol} onChange={(e) => setInp({ ...inp, symbol: e.target.value })} /></label>
          <label>CSV for the symbol<input aria-label="CSV for the symbol" type="file" accept=".csv,text/csv" onChange={readFile('file')} /></label>
          <label>Pair symbol (optional, for SMT)<input aria-label="Pair symbol" style={field} value={inp.pairSymbol} onChange={(e) => setInp({ ...inp, pairSymbol: e.target.value })} /></label>
          <label>CSV for the pair<input aria-label="CSV for the pair" type="file" accept=".csv,text/csv" onChange={readFile('pairFile')} /></label>
          <label>Timestamp convention
            <select aria-label="Timestamp convention" style={field} value={inp.marks} onChange={(e) => setInp({ ...inp, marks: e.target.value as StructureInputs['marks'] })}>
              <option value="">— choose —</option>
              <option value="OPEN">Stamp marks the bar OPEN</option>
              <option value="CLOSE">Stamp marks the bar CLOSE</option>
            </select>
          </label>
        </div>
        {missing.length > 0 && <p role="status" style={{ fontSize: 12, color: '#fbbf24' }}>Required: {missing.join(' · ')}</p>}
        <button disabled={missing.length > 0 || state.kind === 'running'} onClick={run} style={{ marginTop: 8, fontFamily: MONO }}>
          {state.kind === 'running' ? 'ANALYSING…' : 'ANALYSE'}
        </button>
      </Panel>
      {state.kind === 'refused' && (
        <Panel title="REFUSED" code="BACKEND">
          <ul role="alert" style={{ fontFamily: MONO, fontSize: 12 }}>{state.reasons.map((r) => <li key={r}>{r}</li>)}</ul>
        </Panel>
      )}
      {state.kind === 'error' && <Panel title="NO ANSWER" code="BACKEND"><p role="alert">{state.message}</p></Panel>}
      {state.kind === 'ok' && <StructureReportView report={state.report} />}
    </div>
  )
}

export function StructureReportView({ report }: { report: StructureReport }) {
  const [kind, setKind] = useState<string>('')
  const filtered = useMemo(() => (kind === '' ? report.events : report.events.filter((e) => e.kind === kind)), [kind, report.events])
  const shown = filtered.slice(0, STRUCTURE_ROW_CAP)
  return (
    <>
      <Panel title="STRUCTURE REPORT" code="USER IMPORT">
        <p style={{ fontSize: 12 }}>{report.scope}</p>
        <div style={{ fontFamily: MONO, fontSize: 11, wordBreak: 'break-all' }}>
          <div>method {report.methodVersion} · rules {report.rulesVersion}</div>
          <div>config {report.configHash}</div>
          <div>{report.symbol}{report.pairSymbol !== null ? ` · SMT pair ${report.pairSymbol}` : ' · no SMT pair'} · last close {fmtEt(report.asOf)}</div>
          {report.datasets.map((d) => (
            <div key={d.symbol}>{d.symbol} · {d.provenance} · {d.timestampMarks} · dataset {d.contentId} · {d.rejected.length} rows refused · {d.gaps.length} gaps</div>
          ))}
        </div>
        <h4>Not computed</h4>
        <ul style={{ fontSize: 12 }}>{report.notComputed.map((n) => <li key={n.name}><span style={{ fontFamily: MONO }}>{n.name}</span> — {n.reason}</li>)}</ul>
      </Panel>
      <Panel title={`EVENTS (${report.counts.events})`} code="USER IMPORT">
        <label style={{ fontSize: 12 }}>Kind{' '}
          <select aria-label="Event kind" value={kind} onChange={(e) => setKind(e.target.value)} style={{ fontFamily: MONO, fontSize: 12 }}>
            <option value="">All kinds</option>
            {Object.entries(report.counts.byKind).map(([k, v]) => <option key={k} value={k}>{k} ({v})</option>)}
          </select>
        </label>
        {filtered.length === 0 ? (
          <p style={{ fontSize: 12 }}>The engine published no event{kind !== '' ? ` of kind ${kind}` : ''} on these bars.</p>
        ) : (
          <>
            <p role="note" style={{ fontSize: 11 }}>
              Showing {shown.length} of {filtered.length}{filtered.length > shown.length ? ` — the first ${STRUCTURE_ROW_CAP} by knownAt` : ''}.
            </p>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ fontFamily: MONO, fontSize: 11, borderCollapse: 'collapse', width: '100%' }}>
                <thead><tr><th align="left">KNOWN AT</th><th align="left">SYMBOL</th><th align="left">KIND</th><th align="left">DETAIL</th><th align="left">CITES</th></tr></thead>
                <tbody>
                  {shown.map((e) => (
                    <tr key={e.id} data-kind={e.kind}>
                      <td>{fmtEt(e.knownAt)}</td>
                      <td>{e.symbol}</td>
                      <td>{e.kind}</td>
                      <td>{eventSummary(e)}</td>
                      <td>{Array.isArray(e.evidence) ? `${e.evidence.length} bars` : ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Panel>
    </>
  )
}
