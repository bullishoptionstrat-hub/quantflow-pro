'use client'
import { useState } from 'react'
import { apiFetch } from '@/lib/apiFetch'
import { Panel } from '@/components/hud/Panel'
import { ideaLinkQuery, ideaPrefill } from '@/lib/replayIdea'
import { BarPreflight } from '@/components/setups/BarPreflight'

/**
 * Replay the setup engine over bars the trader imports.
 *
 * Every field is the trader's: two symbols (each is the other's SMT pair), the
 * timestamp convention their export uses, and a round-trip cost per unit. None
 * has a default. Missing ones are named and the run is not sent. The backend
 * runs the same `runSetupReplay` the `research:setup-replay` CLI runs, keeps
 * nothing, and returns signal events only — no outcome, P&L or win rate.
 */

const MONO = "'JetBrains Mono', monospace"

interface Transition { state: string; knownAt: number; bar: string; reasons: { code: string; detail: string }[] }
interface Idea { ideaId: string; setup: string; side: string; symbol: string; netR: number | null; entry?: number | null; invalidation?: number | null; target?: { name: string; price: number } | null; history: Transition[] }
interface Dataset { symbol: string; contentId: string; provenance: string; timestampMarks: string; rejected: unknown[]; gaps: unknown[] }
export interface ReplayReport {
  scope: string
  configHash: string
  setupMethodVersion: string
  structureMethodVersion: string | null
  datasets: Dataset[]
  counts: { ideas: number; byTerminalState: Record<string, number>; blockedByReason: Record<string, number> }
  runs: { symbol: string; pairSymbol: string; ideas: Idea[] }[]
  /** Absent from a backend older than outcome grading. */
  outcomes?: {
    summary: { byState: Record<string, number>; decided: number; minSample: number; hitRate: number | null; meanR: number | null; suppressed: string | null }
    ideas: { ideaId: string; symbol: string; state: string; r: number | null; decidedAt: number | null; gapMinutes: number; detail: string }[]
  }
}

type State =
  | { kind: 'idle' }
  | { kind: 'running' }
  | { kind: 'refused'; reasons: string[] }
  | { kind: 'error'; message: string }
  | { kind: 'ok'; report: ReplayReport }

export interface Inputs {
  symbolA: string; symbolB: string
  fileA: string | null; fileB: string | null
  marks: '' | 'OPEN' | 'CLOSE'
  cost: string
}

/** Which required inputs are missing or unreadable. Empty means ready. */
export function missingInputs(i: Inputs): string[] {
  const m: string[] = []
  const a = i.symbolA.trim().toUpperCase(), b = i.symbolB.trim().toUpperCase()
  if (a === '') m.push('Symbol A')
  if (b === '') m.push('Symbol B (SMT pair)')
  if (a !== '' && a === b) m.push('Two different symbols')
  if (i.fileA === null) m.push('CSV for symbol A')
  if (i.fileB === null) m.push('CSV for symbol B')
  if (i.marks === '') m.push('Timestamp convention')
  const c = i.cost.trim()
  if (c === '') m.push('Round-trip cost per unit')
  else if (!Number.isFinite(Number(c)) || Number(c) < 0) m.push('Round-trip cost per unit (a non-negative number)')
  return m
}

const fmtTime = (ms: number) => new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + 'Z'

export function SetupReplay() {
  const [inp, setInp] = useState<Inputs>({ symbolA: '', symbolB: '', fileA: null, fileB: null, marks: '', cost: '' })
  const [state, setState] = useState<State>({ kind: 'idle' })
  const missing = missingInputs(inp)

  const readFile = (key: 'fileA' | 'fileB') => async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    const text = f ? await f.text() : null
    setInp((p) => ({ ...p, [key]: text }))
  }

  async function run() {
    if (missing.length > 0) return
    const a = inp.symbolA.trim().toUpperCase(), b = inp.symbolB.trim().toUpperCase()
    setState({ kind: 'running' })
    try {
      const res = await apiFetch('/api/setups/replay', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          config: { symbols: [a, b], timestampMarks: inp.marks, costs: { roundTripPerUnit: Number(inp.cost.trim()) } },
          csv: { [a]: inp.fileA, [b]: inp.fileB },
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
      <Panel title="SETUP REPLAY" code="USER IMPORT">
        <p style={{ fontSize: 12, margin: '0 0 12px' }}>
          Replays the Sweep and Reclaim / Sell the Rip state machine over 1-minute bars you import. It reports signal events only.
          <strong> This is not evidence of an edge</strong>: the definitions are untuned, versioned hypotheses, and no outcome, P&L or win rate is computed. Nothing is stored.
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10 }}>
          <label>Symbol A<input aria-label="Symbol A" style={field} value={inp.symbolA} onChange={(e) => setInp({ ...inp, symbolA: e.target.value })} /></label>
          <label>Symbol B (SMT pair)<input aria-label="Symbol B" style={field} value={inp.symbolB} onChange={(e) => setInp({ ...inp, symbolB: e.target.value })} /></label>
          <label>CSV for A<input aria-label="CSV for A" type="file" accept=".csv,text/csv" onChange={readFile('fileA')} /></label>
          <label>CSV for B<input aria-label="CSV for B" type="file" accept=".csv,text/csv" onChange={readFile('fileB')} /></label>
          <label>Timestamp convention
            <select aria-label="Timestamp convention" style={field} value={inp.marks} onChange={(e) => setInp({ ...inp, marks: e.target.value as Inputs['marks'] })}>
              <option value="">— choose —</option>
              <option value="OPEN">Stamp marks the bar OPEN</option>
              <option value="CLOSE">Stamp marks the bar CLOSE</option>
            </select>
          </label>
          <label>Round-trip cost per unit<input aria-label="Round-trip cost per unit" inputMode="decimal" style={field} value={inp.cost} onChange={(e) => setInp({ ...inp, cost: e.target.value })} /></label>
        </div>
        {missing.length > 0 && (
          <p role="status" style={{ fontSize: 12, color: '#fbbf24' }}>Required: {missing.join(' · ')}</p>
        )}
        <button disabled={missing.length > 0 || state.kind === 'running'} onClick={run} style={{ marginTop: 8, fontFamily: MONO }}>
          {state.kind === 'running' ? 'REPLAYING…' : 'REPLAY'}
        </button>
      </Panel>

      <BarPreflight inputs={inp} />

      {state.kind === 'refused' && (
        <Panel title="REFUSED" code="BACKEND">
          <ul role="alert" style={{ fontFamily: MONO, fontSize: 12 }}>{state.reasons.map((r) => <li key={r}>{r}</li>)}</ul>
        </Panel>
      )}
      {state.kind === 'error' && <Panel title="NO ANSWER" code="BACKEND"><p role="alert">{state.message}</p></Panel>}
      {state.kind === 'ok' && <Report report={state.report} />}
    </div>
  )
}

function Report({ report }: { report: ReplayReport }) {
  return (
    <>
      <Panel title="REPLAY REPORT" code="USER IMPORT">
        <p style={{ fontSize: 12 }}>{report.scope}</p>
        <div style={{ fontFamily: MONO, fontSize: 11, wordBreak: 'break-all' }}>
          <div>setup method {report.setupMethodVersion} · structure method {report.structureMethodVersion ?? '—'}</div>
          <div>config {report.configHash}</div>
          {report.datasets.map((d) => (
            <div key={d.symbol}>{d.symbol} · {d.provenance} · {d.timestampMarks} · dataset {d.contentId} · {d.rejected.length} rows refused · {d.gaps.length} gaps</div>
          ))}
        </div>
        <h4>Ideas by terminal state ({report.counts.ideas})</h4>
        <ul style={{ fontFamily: MONO, fontSize: 12 }}>
          {Object.entries(report.counts.byTerminalState).map(([k, v]) => <li key={k}>{k}: {v}</li>)}
        </ul>
        <h4>Blocked by reason</h4>
        {Object.keys(report.counts.blockedByReason).length === 0
          ? <p style={{ fontSize: 12 }}>No idea was blocked.</p>
          : <ul style={{ fontFamily: MONO, fontSize: 12 }}>{Object.entries(report.counts.blockedByReason).map(([k, v]) => <li key={k}>{k}: {v}</li>)}</ul>}
      </Panel>
      <Outcomes report={report} />
      {report.runs.map((r) => (
        <Panel key={r.symbol} title={`${r.symbol} · SMT ${r.pairSymbol}`} code="USER IMPORT">
          {r.ideas.length === 0 ? <p style={{ fontSize: 12 }}>No idea formed on these bars.</p> : r.ideas.map((i) => (
            <details key={i.ideaId} style={{ fontFamily: MONO, fontSize: 11, marginBottom: 6 }}>
              <summary>{i.setup} {i.side} · {i.history[i.history.length - 1]?.state ?? '—'}</summary>
              <ol>{i.history.map((t, n) => (
                <li key={n}>{fmtTime(t.knownAt)} {t.state}{t.reasons.length > 0 ? ` — ${t.reasons.map((x) => `${x.code}: ${x.detail}`).join('; ')}` : ''}</li>
              ))}</ol>
              <IdeaTicketLink idea={i} method={report.setupMethodVersion} />
            </details>
          ))}
        </Panel>
      ))}
    </>
  )
}

/**
 * Which level the later imported bars touched first, per ACTIONABLE idea.
 * The rate and mean R are rendered only when the backend published them: below
 * its sample floor it sends null with a reason, and the page shows the reason.
 */
function Outcomes({ report }: { report: ReplayReport }) {
  const o = report.outcomes
  if (!o) return <Panel title="OUTCOMES" code="BACKEND"><p style={{ fontSize: 12 }}>This backend does not grade outcomes.</p></Panel>
  const s = o.summary
  return (
    <Panel title="OUTCOMES · TARGET OR INVALIDATION FIRST" code="USER IMPORT">
      <ul style={{ fontFamily: MONO, fontSize: 12 }}>
        {Object.entries(s.byState).map(([k, v]) => <li key={k}>outcome {k}: {v}</li>)}
      </ul>
      {s.hitRate === null || s.meanR === null
        ? <p style={{ fontSize: 12 }} data-testid="outcome-suppressed">No rate shown: {s.suppressed ?? `fewer than ${s.minSample} decided ideas`}.</p>
        : <p style={{ fontFamily: MONO, fontSize: 12 }} data-testid="outcome-rate">
            target first {(s.hitRate * 100).toFixed(1)}% of {s.decided} decided · mean {s.meanR.toFixed(2)}R net of costs
          </p>}
      <p style={{ fontSize: 11 }}>Untuned definitions on imported bars. Not P&amp;L and not evidence of an edge.</p>
      {o.ideas.length > 0 && (
        <ol style={{ fontFamily: MONO, fontSize: 11 }}>
          {o.ideas.map((x) => (
            <li key={x.ideaId}>{x.symbol} {x.state}{x.r === null ? '' : ` ${x.r.toFixed(2)}R`}{x.gapMinutes > 0 ? ` · ${x.gapMinutes} min missing` : ''} — {x.detail}</li>
          ))}
        </ol>
      )}
    </Panel>
  )
}

/**
 * Open an ACTIONABLE idea as a ticket. The link fills the instrument,
 * direction, setup ID (the idea's content hash), entry, stop and target, and
 * nothing else: every gate on the ticket still starts unanswered.
 */
function IdeaTicketLink({ idea, method }: { idea: Idea; method: string }) {
  const p = ideaPrefill(idea, method)
  if ('reason' in p) return null
  return (
    <a href={ideaLinkQuery(p)} data-testid="idea-ticket-link" style={{ fontSize: 11 }}>
      Open as ticket (setup ID {p.ideaId.slice(0, 12)}…, gates unanswered)
    </a>
  )
}
