'use client'
import { useState } from 'react'
import { apiFetch } from '@/lib/apiFetch'
import { Panel } from '@/components/hud/Panel'

/**
 * Bar-import preflight: what each uploaded CSV holds, before a replay runs.
 *
 * The backend reads the files with the replay's own parser
 * (`market/barPreflight.ts` over `importBarsCsv`) and reports rejected rows by
 * reason, duplicates, out-of-order rows, gaps, and each ET date against the
 * calendar's published regular session. It needs the symbols, both files and
 * the timestamp convention — not the cost, which the preflight does not read.
 * Nothing is filled, repaired or stored.
 */

const MONO = "'JetBrains Mono', monospace"

export interface PreflightDay { date: string; session: string; bars: number; rthBars: number | null; rthMinutes: number | null; rthCoverage: number | null; outsideRthBars: number | null }
export interface SymbolPreflight {
  symbol: string
  status: 'OK' | 'REFUSED'
  refused: string[]
  lines: number
  keptBars: number
  coverage: { firstTOpen: number; lastClosedAt: number } | null
  rejectedRows: number
  rejectedByCode: { code: string; rows: number; firstLines: number[]; example: string }[]
  duplicates: number
  outOfOrder: number
  gaps: { count: number; missingMinutes: number; insideRthMinutes: number | null; largest: { afterTOpen: number; beforeTOpen: number; missingMinutes: number } | null }
  days: PreflightDay[]
  warnings: string[]
}

export interface PreflightInputs { symbolA: string; symbolB: string; fileA: string | null; fileB: string | null; marks: '' | 'OPEN' | 'CLOSE' }

/** What the preflight still needs. Cost is not among them. */
export function preflightMissing(i: PreflightInputs): string[] {
  const m: string[] = []
  const a = i.symbolA.trim().toUpperCase(), b = i.symbolB.trim().toUpperCase()
  if (a === '') m.push('Symbol A')
  if (b === '') m.push('Symbol B (SMT pair)')
  if (a !== '' && a === b) m.push('Two different symbols')
  if (i.fileA === null) m.push('CSV for symbol A')
  if (i.fileB === null) m.push('CSV for symbol B')
  if (i.marks === '') m.push('Timestamp convention')
  return m
}

type State =
  | { kind: 'idle' } | { kind: 'running' }
  | { kind: 'refused'; reasons: string[] } | { kind: 'error'; message: string }
  | { kind: 'ok'; scope: string; symbols: SymbolPreflight[] }

const fmt = (ms: number) => new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + 'Z'
const pct = (x: number | null) => (x === null ? '—' : `${(x * 100).toFixed(1)}%`)

export function BarPreflight({ inputs }: { inputs: PreflightInputs }) {
  const [state, setState] = useState<State>({ kind: 'idle' })
  const missing = preflightMissing(inputs)

  async function run() {
    if (missing.length > 0) return
    const a = inputs.symbolA.trim().toUpperCase(), b = inputs.symbolB.trim().toUpperCase()
    setState({ kind: 'running' })
    try {
      const res = await apiFetch('/api/setups/preflight', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: { timestampMarks: inputs.marks }, csv: { [a]: inputs.fileA, [b]: inputs.fileB } }),
      })
      const body = await res.json().catch(() => null) as any
      if (body?.status === 'REFUSED' && Array.isArray(body.reasons)) return setState({ kind: 'refused', reasons: body.reasons })
      if (!res.ok || body?.status !== 'OK' || body?.kind !== 'BAR_PREFLIGHT' || !Array.isArray(body.symbols)) {
        return setState({ kind: 'error', message: `The backend answered ${res.status}${res.status === 401 ? ' — this session was not accepted' : ''} without a preflight report.` })
      }
      setState({ kind: 'ok', scope: String(body.scope ?? ''), symbols: body.symbols })
    } catch {
      setState({ kind: 'error', message: 'The backend did not answer.' })
    }
  }

  return (
    <Panel title="BAR PREFLIGHT" code="USER IMPORT">
      <p style={{ fontSize: 12, margin: '0 0 8px' }}>
        Read this before the replay: rejected rows are not replayed, and a gap inside the regular session is time the engine never saw.
      </p>
      <button disabled={missing.length > 0 || state.kind === 'running'} onClick={run} style={{ fontFamily: MONO }}>
        {state.kind === 'running' ? 'CHECKING…' : 'PREFLIGHT'}
      </button>
      {missing.length > 0 && <p style={{ fontSize: 11, color: 'var(--text-muted)' }} data-testid="preflight-missing">Preflight needs: {missing.join(' · ')}</p>}
      {state.kind === 'refused' && <ul role="alert" style={{ fontFamily: MONO, fontSize: 12 }}>{state.reasons.map((r) => <li key={r}>{r}</li>)}</ul>}
      {state.kind === 'error' && <p role="alert">{state.message}</p>}
      {state.kind === 'ok' && (
        <div data-testid="preflight-report">
          <p style={{ fontSize: 11, color: 'var(--text-muted)' }}>{state.scope}</p>
          {state.symbols.map((s) => <SymbolReport key={s.symbol} s={s} />)}
        </div>
      )}
    </Panel>
  )
}

function SymbolReport({ s }: { s: SymbolPreflight }) {
  if (s.status === 'REFUSED') {
    return (
      <div data-testid={`preflight-${s.symbol}`} style={{ fontFamily: MONO, fontSize: 12, marginTop: 8 }}>
        <strong>{s.symbol}: REFUSED</strong>
        <ul>{s.refused.map((r) => <li key={r}>{r}</li>)}</ul>
      </div>
    )
  }
  return (
    <div data-testid={`preflight-${s.symbol}`} style={{ fontFamily: MONO, fontSize: 11, marginTop: 10 }}>
      <strong style={{ fontSize: 12 }}>{s.symbol}</strong>
      <div>
        {s.keptBars} bars kept of {Math.max(0, s.lines - 1)} rows · {s.rejectedRows} rejected · {s.duplicates} duplicate · {s.outOfOrder} out of order
      </div>
      <div>{s.coverage ? `${fmt(s.coverage.firstTOpen)} → ${fmt(s.coverage.lastClosedAt)}` : 'no coverage'}</div>
      <div>
        {s.gaps.count} gap{s.gaps.count === 1 ? '' : 's'}, {s.gaps.missingMinutes} min missing, of which inside the regular session:{' '}
        {s.gaps.insideRthMinutes === null ? 'not computed (calendar cannot answer)' : `${s.gaps.insideRthMinutes} min`}
      </div>
      {s.rejectedByCode.length > 0 && (
        <ul aria-label={`${s.symbol} rejected rows by reason`}>
          {s.rejectedByCode.map((g) => <li key={g.code}>{g.code}: {g.rows} row{g.rows === 1 ? '' : 's'} (lines {g.firstLines.join(', ')}{g.rows > g.firstLines.length ? ', …' : ''}) — e.g. {g.example}</li>)}
        </ul>
      )}
      <table style={{ fontSize: 11, marginTop: 4 }}>
        <thead><tr><th align="left">ET date</th><th align="left">calendar</th><th align="right">bars</th><th align="right">RTH bars</th><th align="right">RTH coverage</th><th align="right">outside RTH</th></tr></thead>
        <tbody>
          {s.days.map((d) => (
            <tr key={d.date}>
              <td>{d.date}</td><td>{d.session}</td><td align="right">{d.bars}</td>
              <td align="right">{d.rthBars === null ? '—' : `${d.rthBars}/${d.rthMinutes ?? '—'}`}</td>
              <td align="right">{pct(d.rthCoverage)}</td><td align="right">{d.outsideRthBars ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {s.warnings.length > 0
        ? <ul role="note" style={{ color: 'var(--warn)' }}>{s.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
        : <p style={{ color: 'var(--text-muted)' }}>Nothing to flag.</p>}
    </div>
  )
}
