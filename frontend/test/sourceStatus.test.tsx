/**
 * The sidebar's source status comes from /api/health, never from a list.
 *
 * It printed CBOE, FRED, CRYPTO, REDDIT, NEWS and STOOQ in green on every
 * deployment. On the recorded keyless payload below, the backend reports
 * FRED, Reddit and NewsAPI `disabled` and Stooq and CoinGecko `error`, so
 * five of those six green tags were false.
 */
import { expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { render } from '@testing-library/react'
import { summariseSources } from '@/lib/sourceSummary'
import { SourceStatus } from '@/components/layout/SourceStatus'

const ROOT = join(__dirname, '..', '..')
const recorded = JSON.parse(readFileSync(join(ROOT, 'backend', 'test', 'fixtures', 'health.json'), 'utf8'))

test('the recorded keyless payload: what the old tags called green is reported as it is', () => {
  const s = summariseSources(recorded)!
  for (const name of ['fred', 'reddit', 'newsapi']) expect(s.byState.disabled).toContain(name)
  for (const name of ['stooq', 'coingecko']) expect(s.byState.error).toContain(name)
  expect(s.byState.connected).toEqual(['cboe'])
  // The simulator is reported on its own, not counted as a connected source.
  expect(s.simulation).toBe(true)
  expect(Object.values(s.byState).flat()).not.toContain('simulation')
})

test('connected with a note is degraded, not connected', () => {
  const s = summariseSources({ ingestion: {
    sources: { polygon: 'connected', cboe: 'connected' },
    sourceNotes: { polygon: 'entitlement refused: HTTP 403' },
  } })!
  expect(s.byState.connected).toEqual(['cboe'])
  expect(s.byState.degraded).toEqual(['polygon'])
})

test('a state the frontend does not know is unknown, never connected', () => {
  const s = summariseSources({ ingestion: { sources: { a: 'live', b: 42, c: null, d: 'connected' } } })!
  expect(s.byState.unknown).toEqual(['a', 'b', 'c'])
  expect(s.byState.connected).toEqual(['d'])
})

test('a payload with no source map is not reported, not reported as empty', () => {
  for (const body of [null, {}, { ingestion: {} }, { ingestion: { sources: 'x' } }, { ingestion: { sources: [] } }]) {
    expect(summariseSources(body)).toBeNull()
  }
})

test('the sidebar never shows green while it does not know', () => {
  const unreachable = render(<SourceStatus panel={{ status: 'unreachable' }} />).container
  expect(unreachable.textContent).toBe('SOURCES: BACKEND UNREACHABLE')
  const notReported = render(<SourceStatus panel={{ status: 'ok', data: null }} />).container
  expect(notReported.textContent).toBe('SOURCES: NOT REPORTED')
  const loading = render(<SourceStatus panel={{ status: 'loading' }} />).container
  expect(loading.textContent).toBe('')
  for (const c of [unreachable, notReported, loading]) expect(c.innerHTML).not.toContain('CONNECTED')
})

test('the sidebar renders counts in the backend states and names the simulator', () => {
  const { container } = render(<SourceStatus panel={{ status: 'ok', data: summariseSources(recorded) }} />)
  const text = container.textContent ?? ''
  expect(text).toContain('1 CONNECTED')
  expect(text).toContain('4 ERROR')
  expect(text).toContain('SIMULATOR ON')
  expect(text).not.toMatch(/LIVE/)
  // Each chip names its sources on hover, so a count can be checked.
  expect(container.querySelector('[title="cboe"]')).not.toBeNull()
})

test('no hand-maintained source list survives in the sidebar', () => {
  const src = readFileSync(join(ROOT, 'frontend', 'components', 'layout', 'Sidebar.tsx'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  expect(src).not.toMatch(/\[\s*'CBOE'/)
  expect(src).toMatch(/<SourceStatus panel=\{sourcesPanel\} \/>/)
})
