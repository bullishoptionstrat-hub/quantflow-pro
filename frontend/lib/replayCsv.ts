/**
 * The setup replay as a CSV a spreadsheet can open, with its provenance in the
 * file rather than only on the page.
 *
 * What travels with the rows, as `#` comment lines above the header: the
 * report kind, the scope sentence, the setup and structure method versions,
 * the config hash, each dataset's content id, provenance and timestamp
 * convention, and the outcome summary as the backend published it. Below the
 * sample floor the rate is not in the file: the backend's suppression reason
 * is, exactly as on the page.
 *
 * Rules:
 * - An absent value is an empty cell, never 0. `netR`, entry and target are
 *   null on most ideas, and a 0 there reads as a measured zero.
 * - A text cell that a spreadsheet would read as a formula (`= + - @`, tab,
 *   CR, or any leading whitespace) is prefixed with `'`. Numbers are written as numbers and never
 *   prefixed, so a negative R stays a number.
 * - Commas, quotes and newlines are quoted per RFC 4180.
 * - Nothing here computes: every value is copied from the report.
 */

export interface CsvIdea {
  ideaId: string
  setup: string
  side: string
  symbol: string
  netR: number | null
  entry?: number | null
  invalidation?: number | null
  target?: { name: string; price: number } | null
  history: { state: string; knownAt: number }[]
}

export interface CsvReport {
  scope: string
  configHash: string
  setupMethodVersion: string
  structureMethodVersion: string | null
  datasets: { symbol: string; contentId: string; provenance: string; timestampMarks: string }[]
  runs: { symbol: string; pairSymbol: string; ideas: CsvIdea[] }[]
  outcomes?: {
    summary: { decided: number; minSample: number; hitRate: number | null; meanR: number | null; suppressed: string | null }
    ideas: { ideaId: string; state: string; r: number | null; decidedAt: number | null; gapMinutes: number; detail: string }[]
  }
}

export const REPLAY_CSV_COLUMNS = [
  'idea_id', 'symbol', 'pair_symbol', 'setup', 'side', 'terminal_state', 'actionable_at',
  'entry', 'invalidation', 'target_name', 'target_price', 'net_r',
  'outcome_state', 'outcome_r', 'decided_at', 'gap_minutes', 'outcome_detail',
] as const

/**
 * A spreadsheet trims leading whitespace before deciding a cell is a formula,
 * so ` =1+1` and `\t=1` are formulas too. Any leading whitespace (space, tab,
 * CR, LF, NBSP and other Unicode spaces) is guarded, and so is a formula
 * character after it.
 */
export const FORMULA_LEAD = /^(?:\s|[=+\-@])/

/** A text cell: formula-guarded, then quoted if it needs it. */
export function textCell(s: string | null | undefined): string {
  if (s === null || s === undefined) return ''
  const guarded = FORMULA_LEAD.test(s) ? `'${s}` : s
  return /[",\n\r]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded
}

/** A number cell: empty when absent or not finite, never a substituted 0. */
export function numCell(n: number | null | undefined): string {
  return typeof n === 'number' && Number.isFinite(n) ? String(n) : ''
}

function isoCell(ms: number | null | undefined): string {
  return typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString() : ''
}

/** One comment line; a newline inside a value cannot start a data row. */
function comment(s: string): string {
  return `# ${s.replace(/[\r\n]+/g, ' ')}`
}

export function replayCsv(report: CsvReport): string {
  const lines: string[] = [
    comment('quantflow setup replay export · USER IMPORT · synthetic or user data, not evidence of an edge, not P&L'),
    comment(`scope: ${report.scope}`),
    comment(`setup method: ${report.setupMethodVersion}`),
    comment(`structure method: ${report.structureMethodVersion ?? 'none'}`),
    comment(`config hash: ${report.configHash}`),
    ...report.datasets.map((d) => comment(`dataset ${d.symbol}: ${d.contentId} · ${d.provenance} · timestamps mark bar ${d.timestampMarks}`)),
  ]
  const o = report.outcomes
  if (!o) {
    lines.push(comment('outcomes: not graded by this backend'))
  } else if (o.summary.hitRate === null || o.summary.meanR === null) {
    lines.push(comment(`outcomes: ${o.summary.decided} decided, sample floor ${o.summary.minSample}; no rate published: ${o.summary.suppressed ?? 'suppressed'}`))
  } else {
    lines.push(comment(`outcomes: ${o.summary.decided} decided; hit rate ${o.summary.hitRate}; mean R ${o.summary.meanR}`))
  }
  lines.push(REPLAY_CSV_COLUMNS.join(','))
  const outcome = new Map((o?.ideas ?? []).map((x) => [x.ideaId, x]))
  for (const run of report.runs) {
    for (const i of run.ideas) {
      const g = outcome.get(i.ideaId)
      const actionable = i.history.find((t) => t.state === 'ACTIONABLE')
      lines.push([
        textCell(i.ideaId), textCell(i.symbol), textCell(run.pairSymbol), textCell(i.setup), textCell(i.side),
        textCell(i.history[i.history.length - 1]?.state ?? null), isoCell(actionable?.knownAt),
        numCell(i.entry), numCell(i.invalidation), textCell(i.target?.name ?? null), numCell(i.target?.price), numCell(i.netR),
        textCell(g?.state ?? null), numCell(g?.r), isoCell(g?.decidedAt), numCell(g?.gapMinutes), textCell(g?.detail ?? null),
      ].join(','))
    }
  }
  return lines.join('\n') + '\n'
}
