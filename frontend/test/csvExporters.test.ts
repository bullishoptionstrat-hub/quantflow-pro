/**
 * Every CSV exporter in the frontend writes through `textCell` / `numCell`.
 * The flow feed's export was a bare `join(',')` with no formula guard; this
 * walks the source for any `text/csv` Blob and requires its builder to be one
 * of the shared ones, then drives the flow exporter with hostile values.
 */
import { describe, expect, test } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { flowCsv } from '@/lib/flowCsv'
import type { FlowEvent, FlowFilters } from '@/lib/types'

const ROOT = join(__dirname, '..')
function walk(d: string, out: string[] = []): string[] {
  for (const n of readdirSync(d)) {
    if (['node_modules', '.next', 'test'].includes(n)) continue
    const p = join(d, n)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(n)) out.push(p)
  }
  return out
}

const filters = {
  ticker: 'SPY\n=EVIL', minPremium: 0, optionType: 'ALL', orderType: 'ALL', sentiment: 'ALL', minHeat: 0, unusualOnly: false,
} as unknown as FlowFilters

function ev(over: Partial<FlowEvent>): FlowEvent {
  return {
    created_at: '2026-11-18T15:00:00Z', underlying: 'SPY', expiry: '2026-12-18', strike: 600, option_type: 'CALL',
    order_type: 'SWEEP', total_size: 10, total_premium: 1000, heat_score: 50, sentiment: 'BULLISH', synthetic: true,
    datasets: ['SIMULATION'], rights_display: 'PERMITTED', ...over,
  } as FlowEvent
}

describe('flow CSV export', () => {
  test('formula-shaped and whitespace-led text is guarded; commas cannot shift columns', () => {
    const csv = flowCsv([ev({ underlying: ' =HYPERLINK("x")', sentiment: '@x' as never, rights_display: 'a,b' as never })], 1, filters, (s) => s)
    const row = csv.trim().split('\n').at(-1)!
    expect(row).toContain(`"' =HYPERLINK(""x"")"`)
    expect(row).toContain("'@x")
    expect(row).toContain('"a,b"')
  })
  test('a typed ticker cannot start a data row', () => {
    const csv = flowCsv([], 0, filters, (s) => s)
    expect(csv.split('\n').filter((l) => l.startsWith('=')).length).toBe(0)
  })
  test('an absent number is an empty cell, not 0', () => {
    const row = flowCsv([ev({ strike: null as never })], 1, filters, (s) => s).trim().split('\n').at(-1)!
    expect(row.split(',')[3]).toBe('')
  })
})

describe('every exporter uses the shared cell rules', () => {
  test("any file building a text/csv Blob imports a shared CSV builder and joins no raw rows", () => {
    const files = walk(ROOT).filter((f) => readFileSync(f, 'utf8').includes("'text/csv'"))
    expect(files.length).toBeGreaterThan(0)
    for (const f of files) {
      const src = readFileSync(f, 'utf8')
      expect(src, f).toMatch(/from '@\/lib\/(flowCsv|journalCsv|replayCsv)'/)
      expect(src, f).not.toMatch(/\]\.join\(','\)/)
    }
  })
})
