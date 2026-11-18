/**
 * The replay CSV, driven by the CLI's recorded report over the planted-episode
 * fixture (engine output, not a hand-built report), plus the cell rules.
 * Synthetic data: nothing here is evidence about the rules or about markets.
 */
import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { replayCsv, textCell, numCell, REPLAY_CSV_COLUMNS, type CsvReport } from '@/lib/replayCsv'

const recorded = JSON.parse(readFileSync(join(__dirname, '..', '..', 'backend', 'test', 'fixtures', 'setupReplayEpisodes.json'), 'utf8'))
const report: CsvReport = recorded.report
const csv = replayCsv(report)
const lines = csv.trimEnd().split('\n')
const comments = lines.filter((l) => l.startsWith('#'))
const header = lines[comments.length]!
const rows = lines.slice(comments.length + 1).map((l) => l.split(','))
const col = (name: (typeof REPLAY_CSV_COLUMNS)[number]) => REPLAY_CSV_COLUMNS.indexOf(name)
const ideas = report.runs.flatMap((r) => r.ideas)

describe('replay CSV on engine output', () => {
  test('the provenance travels in the file', () => {
    const head = comments.join('\n')
    expect(head).toContain(report.setupMethodVersion)
    expect(head).toContain(String(report.structureMethodVersion))
    expect(head).toContain(report.configHash)
    for (const d of report.datasets) expect(head).toContain(`${d.contentId} · ${d.provenance}`)
    expect(head).toMatch(/not evidence of an edge/)
    expect(lines.slice(0, comments.length).every((l) => l.startsWith('# '))).toBe(true)
  })

  test('one row per idea, in report order, with the header the columns name', () => {
    expect(header).toBe(REPLAY_CSV_COLUMNS.join(','))
    expect(rows.map((r) => r[col('idea_id')])).toEqual(ideas.map((i) => i.ideaId))
    for (const r of rows) expect(r.length).toBe(REPLAY_CSV_COLUMNS.length)
    // terminal_state is the LAST transition: an idea's first state is never its outcome.
    expect(rows.map((r) => r[col('terminal_state')])).toEqual(ideas.map((i) => i.history[i.history.length - 1]!.state))
    expect(new Set(rows.map((r) => r[col('terminal_state')])).size).toBeGreaterThan(1)
  })

  test('below the sample floor the file carries the suppression, not a rate', () => {
    expect(report.outcomes!.summary.hitRate).toBeNull()
    const line = comments.find((c) => c.startsWith('# outcomes:'))!
    expect(line).toContain(report.outcomes!.summary.suppressed!)
    expect(line).not.toMatch(/hit rate \d/)
  })

  test('ACTIONABLE ideas carry their levels and outcome; absent values are empty, never 0', () => {
    const graded = new Map(report.outcomes!.ideas.map((o) => [o.ideaId, o]))
    let actionable = 0
    ideas.forEach((i, n) => {
      const r = rows[n]!
      const a = i.history.find((t) => t.state === 'ACTIONABLE')
      if (a) {
        actionable++
        expect(r[col('actionable_at')]).toBe(new Date(a.knownAt).toISOString())
        expect(Number(r[col('target_price')])).toBe(i.target!.price)
        expect(r[col('target_name')]).toBe(i.target!.name)
        expect(Number(r[col('net_r')])).toBe(i.netR)
        const g = graded.get(i.ideaId)!
        expect(r[col('outcome_state')]).toBe(g.state)
        expect(r[col('outcome_r')]).toBe(g.r === null ? '' : String(g.r))
      } else {
        expect(r[col('actionable_at')]).toBe('')
      }
      if (i.netR === null) expect(r[col('net_r')]).toBe('')
      if (i.entry === null || i.entry === undefined) expect(r[col('entry')]).toBe('')
      if (!i.target) expect(r[col('target_price')]).toBe('')
      if (!graded.has(i.ideaId)) expect(r[col('outcome_r')]).toBe('')
    })
    expect(actionable).toBeGreaterThanOrEqual(5)
  })
})

describe('cell rules', () => {
  test('a formula-shaped text cell is neutralised; a negative number is not', () => {
    expect(textCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`)
    expect(textCell('+1')).toBe("'+1")
    expect(textCell('-1')).toBe("'-1")
    expect(textCell('@SUM')).toBe("'@SUM")
    expect(numCell(-1)).toBe('-1')
  })
  test('leading whitespace before a formula character is guarded too', () => {
    for (const lead of [' ', '  ', '\t', '\r', '\n', '\u00a0', '\u2003']) {
      for (const f of ['=', '+', '-', '@']) {
        const cell = textCell(`${lead}${f}1+1`)
        expect(cell.replace(/^"/, '').startsWith("'"), JSON.stringify(lead + f)).toBe(true)
      }
    }
    expect(textCell(' plain')).toBe("' plain")
    expect(textCell('a =b')).toBe('a =b')
  })
  test('commas, quotes and newlines are quoted', () => {
    expect(textCell('a,b')).toBe('"a,b"')
    expect(textCell('a"b')).toBe('"a""b"')
    expect(textCell('a\nb')).toBe('"a\nb"')
    expect(textCell('plain')).toBe('plain')
  })
  test('absent and non-finite numbers are empty', () => {
    for (const v of [null, undefined, NaN, Infinity]) expect(numCell(v as number | null)).toBe('')
    expect(numCell(0)).toBe('0')
  })
  test('a newline in a header value cannot start a data row', () => {
    const out = replayCsv({ ...report, scope: 'one\ntwo,three' })
    expect(out.split('\n').filter((l) => l.startsWith('two')).length).toBe(0)
  })
  test('a backend without outcomes says so', () => {
    const { outcomes: _, ...rest } = report
    expect(replayCsv(rest)).toContain('# outcomes: not graded by this backend')
  })
})

test('/setups downloads through replayCsv, not a second serializer', () => {
  const src = readFileSync(join(__dirname, '..', 'components', 'setups', 'SetupReplay.tsx'), 'utf8')
  expect(src).toMatch(/new Blob\(\[replayCsv\(report\)\]/)
  expect(src).toContain('DOWNLOAD CSV')
})
