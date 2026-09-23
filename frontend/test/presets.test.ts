/**
 * Saved scanner presets — the localStorage-backed store behind Roadmap 5.1.
 *
 * The rules that matter are the defensive ones: an SSR render has no `window`,
 * and a corrupt store must open empty rather than white-screen the page. These
 * hold both, plus the same-name replacement that keeps the habit from becoming
 * a pile of near-duplicates.
 */
import { describe, expect, test, beforeEach } from 'vitest'
import {
  loadPresets, savePreset, deletePreset, type ScannerPreset,
} from '@/lib/presets'

beforeEach(() => {
  window.localStorage.clear()
})

test('an empty store loads as an empty list', () => {
  expect(loadPresets()).toEqual([])
})

test('a saved preset round-trips through localStorage', () => {
  savePreset('SPY sweeps', { kinds: ['SWEEP'], underlyings: ['SPY'], minPremium: 100_000 })
  const list = loadPresets()
  expect(list.length).toBe(1)
  expect(list[0]!.name).toBe('SPY sweeps')
  expect(list[0]!.filter).toEqual({ kinds: ['SWEEP'], underlyings: ['SPY'], minPremium: 100_000 })
  expect(typeof list[0]!.id).toBe('string')
})

test('re-saving the same name replaces rather than duplicating', () => {
  savePreset('0DTE', { kinds: ['SWEEP'] })
  const first = loadPresets()[0]!
  savePreset('0dte', { kinds: ['SWEEP'], minScore: 90 }) // case-insensitive match
  const list = loadPresets()
  expect(list.length).toBe(1)
  expect(list[0]!.filter.minScore).toBe(90)
  expect(list[0]!.id).toBe(first.id) // id preserved so React keys don't churn
})

test('presets come back newest first', async () => {
  savePreset('old', {})
  await new Promise((r) => setTimeout(r, 2))
  savePreset('new', {})
  expect(loadPresets().map((p) => p.name)).toEqual(['new', 'old'])
})

test('delete removes exactly one preset by id', () => {
  savePreset('a', {})
  savePreset('b', {})
  const b = loadPresets().find((p) => p.name === 'b')!
  deletePreset(b.id)
  expect(loadPresets().map((p) => p.name)).toEqual(['a'])
})

test('a blank name saves nothing', () => {
  savePreset('   ', { kinds: ['SWEEP'] })
  expect(loadPresets()).toEqual([])
})

describe('a corrupt store opens empty rather than throwing', () => {
  test('non-JSON', () => {
    window.localStorage.setItem('qf_scanner_presets', '{not json')
    expect(loadPresets()).toEqual([])
  })

  test('JSON that is not an array', () => {
    window.localStorage.setItem('qf_scanner_presets', '{"nope":1}')
    expect(loadPresets()).toEqual([])
  })

  test('an array with malformed rows drops only the bad ones', () => {
    const good: ScannerPreset = { id: 'x', name: 'ok', filter: {}, savedAt: 1 }
    window.localStorage.setItem('qf_scanner_presets', JSON.stringify([good, { junk: true }, 42]))
    const list = loadPresets()
    expect(list.length).toBe(1)
    expect(list[0]!.name).toBe('ok')
  })
})
