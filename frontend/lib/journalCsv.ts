/**
 * The journal as a CSV a spreadsheet can open, with its provenance in the file.
 *
 * Header `#` lines say what the file is: a per-browser journal, its schema, how
 * many entries it holds, that R is measured from the actual fill against the
 * planned stop, and that no rate is published below MIN_SAMPLE measured trades
 * (no rate is in this file at all; a spreadsheet can compute one, and the
 * header says what that rate would be over).
 *
 * Rules, shared with `replayCsv.ts` (its cell writers are reused):
 * - An absent value is an empty cell, never 0. A fee not entered, an R that
 *   cannot be measured, a fill not yet taken: all empty.
 * - Formula-leading text is prefixed with `'`; numbers are never prefixed.
 * - Every figure is copied from the entry or from `evaluateEntry`, the
 *   function the page renders. Nothing is computed here.
 */
import { JOURNAL_SCHEMA, MIN_SAMPLE, evaluateEntry, type JournalEntry } from './journal'
import { numCell, textCell } from './replayCsv'

export const JOURNAL_CSV_COLUMNS = [
  'entry_id', 'saved_at', 'status', 'symbol', 'contract', 'direction', 'setup_id', 'model',
  'ticket_state', 'ticket_blockers', 'planned_entry', 'planned_stop', 'planned_units', 'planned_risk',
  'fill_price', 'fill_units', 'fill_at', 'actual_stop', 'exit_units', 'last_exit_at',
  'fees', 'pnl', 'risk_at_fill', 'r', 'outcome', 'process', 'auto_tags', 'self_tags', 'reviewed', 'problems',
] as const

function comment(s: string): string {
  return `# ${s.replace(/[\r\n]+/g, ' ')}`
}

function list(xs: readonly string[]): string {
  return textCell(xs.length ? xs.join(';') : null)
}

export function journalCsv(entries: readonly JournalEntry[], exportedAt: string): string {
  const evals = entries.map((e) => evaluateEntry(e, entries))
  const measured = evals.filter((v, i) => entries[i].status === 'CLOSED' && typeof v.realized?.r === 'number').length
  const lines = [
    comment('quantflow trade journal export · THIS BROWSER · trader-entered records, not broker statements'),
    comment(`schema: ${JOURNAL_SCHEMA}`),
    comment(`exported at: ${exportedAt}`),
    comment(`entries: ${entries.length}; closed with a measured R: ${measured}`),
    comment('R: realized P&L (net of entered fees) over risk at the actual fill against the planned stop; empty when it cannot be measured'),
    comment(`no rate is published below ${MIN_SAMPLE} measured trades; ${measured < MIN_SAMPLE ? 'this file is below that floor' : 'this file meets that floor'}`),
    JOURNAL_CSV_COLUMNS.join(','),
  ]
  entries.forEach((e, i) => {
    const v = evals[i]
    const t = e.ticket
    const exitUnits = e.exits.length ? e.exits.reduce((a, x) => a + x.units, 0) : null
    const lastExit = e.exits.length ? [...e.exits].map((x) => x.at).sort().at(-1) ?? null : null
    lines.push([
      textCell(e.id), textCell(e.savedAt), textCell(e.status), textCell(t.symbol), textCell(t.contract),
      textCell(t.direction), textCell(t.setupId || null), textCell(t.model), textCell(t.state),
      list(t.blockers.map((b) => b.code)), numCell(t.plan.entry), numCell(t.plan.stop), numCell(t.plan.units), numCell(t.plan.plannedRisk),
      numCell(e.fill?.price), numCell(e.fill?.units), textCell(e.fill?.at), numCell(e.actualStop),
      numCell(exitUnits), textCell(lastExit), numCell(e.fees),
      numCell(v.realized?.pnl), numCell(v.realized?.riskAtFill), numCell(v.realized?.r),
      textCell(v.outcome), textCell(v.process), list(v.autoTags), list(e.tags),
      e.reviewed ? 'true' : 'false', list(v.problems),
    ].join(','))
  })
  return lines.join('\n') + '\n'
}
