'use client'
import { useMemo, useState, type CSSProperties } from 'react'
import {
  MIN_SAMPLE, SELF_TAGS, evaluateEntry, journalStats,
  type EntryEvaluation, type JournalEntry, type SelfTag,
} from '@/lib/journal'
import { mergeImport, serializeJournal, useJournal } from '@/lib/journalStore'
import { Panel } from '@/components/hud/Panel'

/**
 * The trade journal: planned against actual, R against the planned stop, and
 * process judged apart from outcome. Entries come from the trade ticket's
 * "Save to journal" and keep that ticket frozen beside what happened.
 */

const MONO = "'JetBrains Mono', monospace"
const LABEL: CSSProperties = { fontSize: 10, color: 'var(--text-muted)', display: 'block', marginBottom: 4, fontWeight: 600, letterSpacing: '0.08em' }
const INPUT: CSSProperties = { width: '100%', background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 4, padding: '6px 8px', color: '#fafafa', fontFamily: MONO, fontSize: 12 }
const BUTTON: CSSProperties = { padding: '5px 10px', borderRadius: 4, border: '1px solid var(--border)', background: 'var(--bg-secondary)', color: '#a78bfa', cursor: 'pointer', fontSize: 11 }

const money = (n: number) => `${n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const rText = (n: number) => `${n >= 0 ? '+' : ''}${n.toFixed(2)}R`

function parseField(v: string): number | null {
  const t = v.trim()
  if (t === '') return null
  const n = Number(t)
  return Number.isFinite(n) ? n : null
}

/** A datetime-local value, read as this browser's local time. */
function isoFromLocal(v: string): string | null {
  const t = Date.parse(v)
  return Number.isFinite(t) ? new Date(t).toISOString() : null
}

function localNow(): string {
  const d = new Date()
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset())
  return d.toISOString().slice(0, 16)
}

function Field({ id, label, value, onChange, type = 'number', placeholder }: {
  id: string; label: string; value: string; onChange: (v: string) => void; type?: string; placeholder?: string
}) {
  return (
    <div style={{ flex: 1, minWidth: 120 }}>
      <label htmlFor={id} style={LABEL}>{label}</label>
      <input id={id} type={type} inputMode={type === 'number' ? 'decimal' : undefined} step="any" value={value} placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)} style={INPUT} />
    </div>
  )
}

/**
 * A number field that keeps what was typed ("2." while typing 2.5) and commits
 * the parsed value. Binding the input to the stored number would drop the dot.
 */
function NumCommit({ id, label, value, onCommit, placeholder }: {
  id: string; label: string; value: number | null; onCommit: (n: number | null) => void; placeholder?: string
}) {
  const [text, setText] = useState(value === null ? '' : String(value))
  return <Field id={id} label={label} value={text} placeholder={placeholder} onChange={(v) => { setText(v); onCommit(parseField(v)) }} />
}

export default function JournalPage() {
  const { entries, rejected, error, ready, update } = useJournal()
  const [msg, setMsg] = useState<string | null>(null)
  const [importText, setImportText] = useState('')
  const [showExport, setShowExport] = useState(false)

  const stats = useMemo(() => journalStats(entries), [entries])
  const evals = useMemo(() => new Map(entries.map((e) => [e.id, evaluateEntry(e, entries)])), [entries])
  const ordered = useMemo(() => [...entries].sort((a, b) => b.savedAt.localeCompare(a.savedAt)), [entries])

  const patch = (id: string, p: Partial<JournalEntry>) => {
    const err = update((es) => es.map((e) => (e.id === id ? { ...e, ...p } : e)))
    setMsg(err)
  }

  const doImport = () => {
    const r = mergeImport(entries, importText)
    if ('error' in r) { setMsg(r.error); return }
    const err = update(() => r.entries)
    setMsg(err ?? `Imported ${r.added}; skipped ${r.skipped} already here${r.rejected ? `; ${r.rejected} failed the shape check and were not imported` : ''}.`)
    if (!err) setImportText('')
  }

  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        <h1 style={{ fontSize: 18, fontWeight: 700, color: '#fafafa', marginBottom: 4 }}>📓 Trade Journal</h1>
        <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          Planned against actual. R is measured from your fill against the stop you planned. A clean loss is a
          rule-following trade; a winning violation proves nothing about the method.
        </p>
        <p data-testid="storage-note" style={{ fontSize: 11, color: '#fbbf24', marginTop: 4 }}>
          Stored in this browser only. Another browser or a cleared cache will not have it — export to keep a copy.
        </p>
      </div>

      {error && <div data-testid="journal-error" className="card" style={{ padding: 12, marginBottom: 16, color: '#fca5a5', fontSize: 12 }}>{error}</div>}
      {rejected > 0 && (
        <div className="card" style={{ padding: 12, marginBottom: 16, color: '#fcd34d', fontSize: 12 }}>
          {rejected} stored entr{rejected === 1 ? 'y fails' : 'ies fail'} the shape check. They are kept in storage, not shown, and not counted.
        </div>
      )}
      {msg && <div data-testid="journal-msg" style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 12 }}>{msg}</div>}

      <Panel title="Journal stats" code="THIS BROWSER" data-testid="journal-stats">
        <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', fontFamily: MONO, fontSize: 12, color: 'var(--text-secondary)', marginBottom: 8 }}>
          <span>SAVED {stats.saved}</span>
          <span>TAKEN {stats.taken}</span>
          <span>PASSED {stats.passed}</span>
          <span>CLOSED {stats.closed}</span>
          <span>MEASURED {stats.measured}</span>
          <span>W/L/BE {stats.wins}/{stats.losses}/{stats.breakeven}</span>
          {/* Green and red say up and down. A zero total — which is what an
              empty journal sums to — is neither, so it stays neutral. */}
          <span style={{ color: stats.totalR > 0 ? '#22c55e' : stats.totalR < 0 ? '#ef4444' : 'var(--text-secondary)' }}>TOTAL {rText(stats.totalR)}</span>
        </div>
        <div style={{ fontFamily: MONO, fontSize: 12, marginBottom: 8 }} data-testid="journal-rates">
          {stats.rates
            ? <span style={{ color: '#fafafa' }}>WIN RATE {(stats.rates.winRate * 100).toFixed(1)}% · AVG {rText(stats.rates.avgR)} · over {stats.measured} measured trades</span>
            : <span style={{ color: 'var(--text-muted)' }}>No win rate or average yet: {stats.measured} of {MIN_SAMPLE} measured trades. A rate over fewer says nothing about an edge.</span>}
        </div>
        <div style={{ fontFamily: MONO, fontSize: 11, color: 'var(--text-muted)' }}>
          CLEAN {stats.byProcess.clean.n} ({rText(stats.byProcess.clean.totalR)}) · VIOLATION {stats.byProcess.violation.n} ({rText(stats.byProcess.violation.totalR)}) · UNREVIEWED {stats.byProcess.unreviewed.n}
          {Object.keys(stats.tagCounts).length > 0 && (
            <> · TAGS {Object.entries(stats.tagCounts).map(([t, n]) => `${t}×${n}`).join(' ')}</>
          )}
        </div>
      </Panel>

      {ready && ordered.length === 0 && !error && (
        <div className="card" style={{ padding: 16, marginBottom: 16, fontSize: 12, color: 'var(--text-muted)' }}>
          Nothing journaled yet. Fill in a trade ticket and use &ldquo;Save to journal&rdquo; — blocked ideas are worth saving too.
        </div>
      )}

      {ordered.map((e) => <EntryCard key={e.id} entry={e} ev={evals.get(e.id)!} onPatch={(p) => patch(e.id, p)} />)}

      <Panel title="Export / import" code="THIS BROWSER" style={{ marginTop: 16 }}
        actions={<button type="button" style={BUTTON} onClick={() => setShowExport((s) => !s)}>{showExport ? 'Hide export' : 'Export JSON'}</button>}>
        {showExport && (
          <textarea data-testid="journal-export" readOnly rows={6} value={serializeJournal(entries, [])} style={{ ...INPUT, fontSize: 11, marginBottom: 8 }} />
        )}
        <label htmlFor="import" style={LABEL}>IMPORT (PASTE AN EXPORT)</label>
        <textarea id="import" rows={3} value={importText} onChange={(e) => setImportText(e.target.value)} style={{ ...INPUT, fontSize: 11, marginBottom: 8 }} />
        <button type="button" style={BUTTON} onClick={doImport} disabled={importText.trim() === ''}>Import</button>
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6 }}>An import adds entries by id and never rewrites one that is already here.</div>
      </Panel>
    </div>
  )
}

function EntryCard({ entry: e, ev, onPatch }: { entry: JournalEntry; ev: EntryEvaluation; onPatch: (p: Partial<JournalEntry>) => void }) {
  const t = e.ticket
  const [fillPrice, setFillPrice] = useState(t.plan.entry === null ? '' : String(t.plan.entry))
  const [fillUnits, setFillUnits] = useState(t.plan.units === null ? '' : String(t.plan.units))
  const [fillAt, setFillAt] = useState(localNow())
  const [exitPrice, setExitPrice] = useState('')
  const [exitUnits, setExitUnits] = useState('')
  const [exitAt, setExitAt] = useState(localNow())
  const [problem, setProblem] = useState<string | null>(null)
  const pfx = `e-${e.id}`

  const take = () => {
    const price = parseField(fillPrice)
    const units = parseField(fillUnits)
    const at = isoFromLocal(fillAt)
    if (price === null || price <= 0 || units === null || units <= 0 || !Number.isInteger(units) || at === null) {
      setProblem('Enter the fill price, a whole number of units and the time.')
      return
    }
    setProblem(null)
    onPatch({ status: 'TAKEN', fill: { price, units, at } })
  }

  const addExit = () => {
    const price = parseField(exitPrice)
    const units = parseField(exitUnits)
    const at = isoFromLocal(exitAt)
    if (price === null || price <= 0 || units === null || units <= 0 || !Number.isInteger(units) || at === null) {
      setProblem('Enter the exit price, a whole number of units and the time.')
      return
    }
    setProblem(null)
    onPatch({ exits: [...e.exits, { price, units, at }] })
    setExitPrice('')
    setExitUnits('')
  }

  const toggleTag = (tag: SelfTag) =>
    onPatch({ tags: e.tags.includes(tag) ? e.tags.filter((x) => x !== tag) : [...e.tags, tag] })

  const stateColor = t.state === 'APPROVED_TRADE' ? '#22c55e' : t.state === 'BLOCKED' ? '#ef4444' : '#fbbf24'
  const taken = e.status === 'TAKEN' || e.status === 'CLOSED'

  return (
    <div className="card" data-testid={`entry-${t.setupId}`} style={{ padding: 16, marginBottom: 12 }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8, fontFamily: MONO, fontSize: 12 }}>
        <span style={{ color: '#fafafa', fontWeight: 700 }}>{t.setupId}</span>
        <span style={{ color: 'var(--text-secondary)' }}>{t.contract ?? t.symbol} · {t.direction ?? '—'}</span>
        <span style={{ color: stateColor, fontSize: 10, fontWeight: 700 }}>TICKET {t.state}</span>
        <span data-testid="entry-status" style={{ fontSize: 10, fontWeight: 700, color: '#a78bfa' }}>{e.status}</span>
        <span style={{ color: 'var(--text-muted)', fontSize: 10 }}>saved {new Date(e.savedAt).toLocaleString()}</span>
      </div>
      <div style={{ fontFamily: MONO, fontSize: 11, color: 'var(--text-muted)', marginBottom: 8 }}>
        PLAN entry {t.plan.entry ?? '—'} · stop {t.plan.stop ?? '—'} · {t.plan.units ?? '—'} {e.spec.unit}s · risk {t.plan.plannedRisk === null ? '—' : money(t.plan.plannedRisk)} · targets {t.plan.targets.map((x) => x.price).join(', ') || '—'}
        {t.blockers.length > 0 && <> · BLOCKED BY {t.blockers.map((b) => b.code).join(', ')}</>}
      </div>

      {e.status === 'PLANNED' && (
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 8 }}>
          <Field id={`${pfx}-fill`} label="FILL PRICE" value={fillPrice} onChange={setFillPrice} />
          <Field id={`${pfx}-units`} label="UNITS" value={fillUnits} onChange={setFillUnits} />
          <Field id={`${pfx}-fill-at`} label="FILLED AT" type="datetime-local" value={fillAt} onChange={setFillAt} />
          <button type="button" style={BUTTON} onClick={take}>Mark taken</button>
          <button type="button" style={{ ...BUTTON, color: 'var(--text-secondary)' }} onClick={() => onPatch({ status: 'PASSED' })}>Pass</button>
        </div>
      )}

      {taken && e.fill && (
        <>
          <div style={{ fontFamily: MONO, fontSize: 11, color: 'var(--text-secondary)', marginBottom: 8 }}>
            FILLED {e.fill.units} @ {e.fill.price} · {new Date(e.fill.at).toLocaleString()}
            {e.exits.length > 0 && <> · EXITS {e.exits.map((x) => `${x.units}@${x.price}`).join(', ')}</>}
          </div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 8 }}>
            <Field id={`${pfx}-exit`} label="EXIT PRICE" value={exitPrice} onChange={setExitPrice} />
            <Field id={`${pfx}-exit-units`} label="EXIT UNITS" value={exitUnits} onChange={setExitUnits} />
            <Field id={`${pfx}-exit-at`} label="EXITED AT" type="datetime-local" value={exitAt} onChange={setExitAt} />
            <button type="button" style={BUTTON} onClick={addExit}>Add exit</button>
            {e.exits.length > 0 && (
              <button type="button" style={{ ...BUTTON, color: 'var(--text-secondary)' }} onClick={() => onPatch({ exits: e.exits.slice(0, -1) })}>Remove last exit</button>
            )}
          </div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 8 }}>
            <NumCommit id={`${pfx}-fees`} label="FEES PAID ($, TOTAL)" value={e.fees} placeholder="0 if none"
              onCommit={(n) => onPatch({ fees: n !== null && n < 0 ? null : n })} />
            <NumCommit id={`${pfx}-stop`} label="ACTUAL STOP (IF MOVED)" value={e.actualStop}
              onCommit={(n) => onPatch({ actualStop: n !== null && n <= 0 ? null : n })} />
            {e.status === 'TAKEN' && <button type="button" style={BUTTON} onClick={() => onPatch({ status: 'CLOSED' })}>Close trade</button>}
          </div>
        </>
      )}
      {problem && <div style={{ fontSize: 12, color: '#fca5a5', marginBottom: 8 }}>{problem}</div>}

      {e.status === 'CLOSED' && (
        <div data-testid="entry-result" style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontFamily: MONO, fontSize: 12, marginBottom: 8 }}>
          {ev.realized ? (
            <>
              <span style={{ color: ev.realized.pnl >= 0 ? '#22c55e' : '#ef4444' }}>P&amp;L {money(ev.realized.pnl)}</span>
              <span>{ev.realized.r === null ? 'R —' : rText(ev.realized.r)}</span>
              <span>{ev.outcome}</span>
            </>
          ) : <span style={{ color: 'var(--text-muted)' }}>Not measured yet.</span>}
          {ev.process && (
            <span data-testid="entry-process" style={{ fontWeight: 700, color: ev.process === 'CLEAN' ? '#22c55e' : ev.process === 'VIOLATION' ? '#ef4444' : '#fbbf24' }}>
              PROCESS {ev.process}
            </span>
          )}
        </div>
      )}
      {ev.problems.length > 0 && (
        <ul style={{ margin: '0 0 8px', paddingLeft: 18, color: '#fcd34d', fontSize: 12 }}>
          {ev.problems.map((p) => <li key={p}>{p}</li>)}
        </ul>
      )}
      {ev.autoTags.length > 0 && (
        <div data-testid="auto-tags" style={{ fontSize: 11, color: '#fca5a5', marginBottom: 8, fontFamily: MONO }}>
          MEASURED VIOLATIONS: {ev.autoTags.join(', ')}
        </div>
      )}

      {taken && (
        <details>
          <summary style={{ fontSize: 11, color: 'var(--text-secondary)', cursor: 'pointer' }}>Review</summary>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', margin: '8px 0' }}>
            {SELF_TAGS.map((tag) => (
              <label key={tag} style={{ fontSize: 11, color: 'var(--text-secondary)', display: 'flex', gap: 4, alignItems: 'center' }}>
                <input type="checkbox" checked={e.tags.includes(tag)} onChange={() => toggleTag(tag)} /> {tag}
              </label>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
            <Field id={`${pfx}-emotion`} label="EMOTIONAL STATE" type="text" value={e.emotion} onChange={(v) => onPatch({ emotion: v })} />
            <Field id={`${pfx}-after`} label="AFTER SCREENSHOT" type="text" value={e.review.afterScreenshot}
              onChange={(v) => onPatch({ review: { ...e.review, afterScreenshot: v } })} />
          </div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
            <Field id={`${pfx}-worked`} label="WHAT WORKED" type="text" value={e.review.worked} onChange={(v) => onPatch({ review: { ...e.review, worked: v } })} />
            <Field id={`${pfx}-failed`} label="WHAT FAILED" type="text" value={e.review.failed} onChange={(v) => onPatch({ review: { ...e.review, failed: v } })} />
            <Field id={`${pfx}-next`} label="REPEAT / AVOID NEXT TIME" type="text" value={e.review.nextAction} onChange={(v) => onPatch({ review: { ...e.review, nextAction: v } })} />
          </div>
          <label style={{ fontSize: 11, color: 'var(--text-secondary)', display: 'flex', gap: 6, alignItems: 'center' }}>
            <input type="checkbox" checked={e.reviewed} onChange={(x) => onPatch({ reviewed: x.target.checked })} />
            Reviewed — a trade with no violation counts as CLEAN only once this is ticked
          </label>
        </details>
      )}
    </div>
  )
}
