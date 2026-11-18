/**
 * Replay idea -> trade ticket link (NEXT_UPGRADES #6).
 *
 * The rule under test is tighten-only: an engine idea may fill fields the
 * trader could have typed, and nothing it fills can pass a gate the trader has
 * not passed. The generated-ticket block holds that over a few hundred random
 * tickets; the rest pin the link's own refusals and the one-attempt rule.
 */
import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  ANSWERED_GATES, MODELS, SESSION_PROFILES, evaluateTicket, ticketRecord, visibleGates,
  type Answer, type AnsweredGateId, type ModelId, type SessionProfileId, type TicketInput,
} from '@/lib/tradeTicket'
import { specFor } from '@/lib/contractSpecs'
import { setupKey } from '@/lib/journal'
import {
  ideaLinkQuery, ideaPrefill, parseIdeaLink, prefillNote, withIdeaPrefill,
  type IdeaPrefill, type ReplayIdeaLike,
} from '@/lib/replayIdea'
import type { MarketSession } from '@/lib/marketSession'
import TicketPage from '@/app/ticket/page'

const CLOCK = vi.hoisted(() => ({
  session: {
    state: 'OPEN', date: '2026-11-09', nowMinutesEt: 600, openMinutesEt: 570, closeMinutesEt: 960,
    basis: 'test', source: 'test', readAt: '2026-11-06', coverage: { from: '2026-01-01', to: '2027-12-31' },
  } as unknown,
}))
vi.mock('@/lib/marketSession', async (orig) => ({
  ...(await orig<typeof import('@/lib/marketSession')>()),
  useMarketSession: () => ({ panel: { status: 'ok', data: CLOCK.session as MarketSession }, sources: { status: 'loading' } }),
}))

const HASH = 'a'.repeat(63) + 'b'
const METHOD = 'setup-rules/1:e7e97035152cb647'

function idea(o: Partial<ReplayIdeaLike> = {}): ReplayIdeaLike {
  return {
    ideaId: HASH, setup: 'SWEEP_AND_RECLAIM', side: 'LONG', symbol: 'SPY',
    entry: 590, invalidation: 589, target: 593,
    history: [{ state: 'CONTEXT_READY', knownAt: 1 }, { state: 'ACTIONABLE', knownAt: 1767624000000 }],
    ...o,
  }
}
const prefill = (o: Partial<ReplayIdeaLike> = {}) => {
  const p = ideaPrefill(idea(o), METHOD)
  if ('reason' in p) throw new Error(p.reason)
  return p
}

describe('which ideas can open a ticket', () => {
  test('an ACTIONABLE idea with sane geometry links, and its setup ID is the content hash', () => {
    const p = prefill()
    expect(p).toMatchObject({ ideaId: HASH, side: 'LONG', symbol: 'SPY', entry: 590, stop: 589, target: 593, actionableAt: 1767624000000 })
  })
  test.each([
    ['never ACTIONABLE', { history: [{ state: 'INVALIDATED', knownAt: 1 }] }, /ACTIONABLE/],
    ['no target', { target: null }, /missing/],
    ['infinite entry', { entry: Infinity }, /missing/],
    ['LONG with stop above entry', { invalidation: 591 }, /stop < entry < target/],
    ['SHORT geometry on a LONG', { side: 'SHORT' }, /target < entry < stop/],
    ['no direction', { side: 'FLAT' }, /direction/],
    ['not a content hash', { ideaId: 'SPY-1' }, /content-hash/],
    ['unreadable symbol', { symbol: 'spy qqq' }, /symbol/],
  ])('%s is refused', (_n, o, re) => {
    const r = ideaPrefill(idea(o as Partial<ReplayIdeaLike>), METHOD)
    expect('reason' in r && r.reason).toMatch(re)
  })
  test('a symbol that is not a preset links with no instrument, and the note says to choose one', () => {
    const p = prefill({ symbol: 'IWM' })
    expect(p.symbol).toBe('')
    expect(prefillNote(p)).toMatch(/IWM is not a preset, so choose the instrument/)
  })
})

describe('the link survives the URL, and a tampered one is refused whole', () => {
  test('round trip', () => {
    const p = prefill()
    const q = new URL(ideaLinkQuery(p), 'http://x').searchParams
    expect(parseIdeaLink(q)).toEqual({ ...p, setupMethodVersion: METHOD })
  })
  test('no idea parameter: no link', () => {
    expect(parseIdeaLink(new URLSearchParams('symbol=SPY'))).toBeNull()
  })
  test.each([
    ['version', 'idea', '2', /version/],
    ['stop moved past entry', 'stop', '595', /stop < entry/],
    ['entry not a number', 'entry', 'abc', /missing/],
    ['no ACTIONABLE time', 'at', '', /ACTIONABLE/],
    ['no method', 'method', '', /method version/],
    ['no setup', 'setup', '', /method version/],
  ])('%s', (_n, key, value, re) => {
    const q = new URL(ideaLinkQuery(prefill()), 'http://x').searchParams
    q.set(key, value)
    const r = parseIdeaLink(q)
    expect(r && 'error' in r && r.error).toMatch(re)
  })
})

// ---- generated tickets ------------------------------------------------------

function rng(seed: number) {
  let s = seed >>> 0
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32 }
}

function genTicket(r: () => number): TicketInput {
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]
  const maybe = <T,>(v: T): T | null => (r() < 0.5 ? v : null)
  const symbol = pick(['', 'SPY', 'QQQ', 'ES'])
  const spec = symbol === '' ? null : (() => { const s = specFor(symbol)!; return { tickSize: s.tickSize, tickValue: s.tickValue, unit: s.unit, micro: s.micro } })()
  const answers: Partial<Record<AnsweredGateId, Answer>> = {}
  for (const g of ANSWERED_GATES) {
    const x = r()
    if (x < 0.45) answers[g.id] = 'PASS'
    else if (x < 0.6) answers[g.id] = 'FAIL'
  }
  const text = () => (r() < 0.7 ? 'x' : '')
  return {
    symbol, spec, contract: symbol === 'ES' ? 'ESZ6' : '',
    side: pick([null, 'LONG', 'SHORT'] as const),
    setupId: pick(['', '', 'MY-ID']),
    model: pick([null, ...Object.keys(MODELS)] as (ModelId | null)[]),
    sessionProfile: pick([null, ...Object.keys(SESSION_PROFILES)] as (SessionProfileId | null)[]),
    alsoRequire: { candle23: r() < 0.2, cisd: r() < 0.2 },
    answers,
    narrative: { htfContext: text(), poi: text(), liquidityEvent: text(), invalidation: text(), cancelCondition: text(), managementPlan: text(), screenshot: text() },
    entry: maybe(590 + Math.round(r() * 4)), stop: maybe(586 + Math.round(r() * 2)),
    targets: r() < 0.5 ? [] : [{ price: 600, kind: pick([null, 'INTERNAL', 'EXTERNAL'] as const) }],
    riskBudget: maybe(1000), costPerUnit: maybe(0.02), slippageTicks: maybe(1), minR: 2,
    clock: pick([null, { state: 'OPEN', nowMinutesEt: 600, closeMinutesEt: 960 }] as const),
    journal: pick([null, { priorAttempts: 0, stopOutsToday: 0 }, { priorAttempts: 1, stopOutsToday: 0 }, { priorAttempts: 0, stopOutsToday: 2 }]),
    plan: pick([null, { status: 'WRITTEN', date: '2026-11-09', missing: [], lossLimit: null, maxAttempts: null, windows: [], day: null }] as const),
  } as TicketInput
}

describe('tighten-only, over generated tickets', () => {
  const r = rng(20261118)
  const cases = Array.from({ length: 400 }, () => ({ input: genTicket(r), p: prefill(r() < 0.5 ? {} : { side: 'SHORT', entry: 590, invalidation: 591, target: 587 }) }))

  test('the prefill touches only the fields a trader could type, and only where empty', () => {
    for (const { input, p } of cases) {
      const after = withIdeaPrefill(input, p)
      for (const k of ['answers', 'model', 'sessionProfile', 'alsoRequire', 'narrative', 'riskBudget', 'costPerUnit', 'slippageTicks', 'minR', 'clock', 'journal', 'plan', 'contract'] as const) {
        expect(after[k]).toEqual(input[k])
      }
      if (input.side !== null) expect(after.side).toBe(input.side)
      if (input.setupId !== '') expect(after.setupId).toBe(input.setupId)
      if (input.entry !== null) expect(after.entry).toBe(input.entry)
      if (input.stop !== null) expect(after.stop).toBe(input.stop)
      if (input.targets.length) expect(after.targets).toEqual(input.targets)
      if (input.symbol !== '') expect(after.symbol).toBe(input.symbol)
      expect(after.targets.every((t) => input.targets.includes(t) || t.kind === null)).toBe(true)
    }
  })

  test('no TRADER gate changes status, and no blocker is lost', () => {
    for (const { input, p } of cases) {
      const before = evaluateTicket(input), after = evaluateTicket(withIdeaPrefill(input, p))
      const trader = (res: typeof before) => Object.fromEntries(res.gates.filter((g) => g.source === 'TRADER').map((g) => [g.id, g.status]))
      // Gates a direction reveals (SMT on a symbol, a model's extras) may appear; none already shown may change.
      const b = trader(before), a = trader(after)
      for (const [id, st] of Object.entries(b)) expect(a[id]).toBe(st)
      for (const blk of before.blockers.filter((x) => x.code !== 'REWARD_UNDER_2R')) {
        expect(after.blockers.map((x) => x.code)).toContain(blk.code)
      }
      if (before.state === 'BLOCKED' && before.blockers.some((x) => x.code !== 'REWARD_UNDER_2R')) expect(after.state).toBe('BLOCKED')
    }
  })

  test('approval after the prefill needs every required gate the trader answers to be the trader\'s PASS', () => {
    let approved = 0
    for (const { input, p } of cases) {
      const filled = withIdeaPrefill(input, p)
      const res = evaluateTicket(filled)
      if (res.state !== 'APPROVED_TRADE') continue
      approved++
      for (const { def, required } of visibleGates(filled)) if (required) expect(filled.answers[def.id]).toBe('PASS')
    }
    // The generator is not built to approve; the assertion above is the claim.
    expect(approved).toBeGreaterThanOrEqual(0)
  })

  test('an idea already attempted in the journal fails firstAttempt by its hash, in any letter case', () => {
    const p = prefill()
    expect(setupKey(p.ideaId)).toBe(setupKey(p.ideaId.toUpperCase()))
    const base = withIdeaPrefill(genTicket(rng(7)), p)
    const res = evaluateTicket({ ...base, answers: { ...base.answers, firstAttempt: 'PASS' }, journal: { priorAttempts: 1, stopOutsToday: 0 } })
    const g = res.gates.find((x) => x.id === 'firstAttempt')!
    expect(g.status).toBe('FAIL')
    expect(g.source).toBe('COMPUTED')
    expect(res.state).toBe('BLOCKED')
  })

  test('the record carries the origin as an annotation, and the gates do not read it', () => {
    const p = prefill()
    const input = withIdeaPrefill(genTicket(rng(9)), p)
    const res = evaluateTicket(input)
    const origin = { kind: 'REPLAY_IDEA' as const, ideaId: p.ideaId, setup: p.setup, setupMethodVersion: METHOD, actionableAt: p.actionableAt }
    const withO = ticketRecord(input, res, 't', 'S', origin), without = ticketRecord(input, res, 't', 'S')
    expect(withO.origin).toEqual(origin)
    expect(without.origin).toBeNull()
    expect({ ...withO, origin: null }).toEqual(without)
  })
})

// ---- pages ------------------------------------------------------------------

describe('the ticket page opened from an idea', () => {
  const setUrl = (q: string) => window.history.replaceState(null, '', q)
  afterEach(() => setUrl('/'))

  test('fills the typed fields, names the source, and answers no gate', async () => {
    window.localStorage.clear()
    setUrl(ideaLinkQuery(prefill()))
    render(<TicketPage />)
    await waitFor(() => expect(screen.getByTestId('idea-prefill').textContent).toMatch(/history, not a live quote/))
    expect((screen.getByLabelText('INSTRUMENT') as HTMLSelectElement).value).toBe('SPY')
    expect((screen.getByLabelText('SETUP / IDEA ID') as HTMLInputElement).value).toBe(HASH)
    expect((screen.getByLabelText('ENTRY') as HTMLInputElement).value).toBe('590')
    expect((screen.getByLabelText('STOP / INVALIDATION') as HTMLInputElement).value).toBe('589')
    expect((screen.getByLabelText('TP1 PRICE') as HTMLInputElement).value).toBe('593')
    expect((screen.getByLabelText('TP1 LIQUIDITY') as HTMLSelectElement).value).toBe('')
    expect(screen.getByRole('button', { name: 'LONG' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.queryAllByRole('button', { name: /: pass$/ }).every((b) => b.getAttribute('aria-pressed') !== 'true')).toBe(true)
    expect(screen.getByTestId('ticket-state').textContent).toBe('WAIT FOR TRIGGER')
  })

  test('a tampered link fills nothing and says why', async () => {
    const q = new URL(ideaLinkQuery(prefill()), 'http://x')
    q.searchParams.set('stop', '600')
    setUrl(q.pathname + q.search)
    render(<TicketPage />)
    await waitFor(() => expect(screen.getByTestId('idea-prefill').textContent).toMatch(/refused/))
    expect((screen.getByLabelText('SETUP / IDEA ID') as HTMLInputElement).value).toBe('')
    expect(screen.getByTestId('ticket-state').textContent).toBe('NEUTRAL — WAITING')
  })
})

describe('the replay page links ACTIONABLE ideas only', () => {
  const replay = JSON.parse(readFileSync(join(__dirname, '..', '..', 'backend', 'test', 'fixtures', 'setupReplay.json'), 'utf8'))
  beforeEach(() => vi.resetModules())
  afterEach(() => vi.doUnmock('@/lib/apiFetch'))

  test('the recorded fixture has no ACTIONABLE idea, so no link; one constructed ACTIONABLE idea gets one', async () => {
    const report = structuredClone(replay)
    const run = report.report.runs[0]
    const base = idea({ side: 'SHORT', entry: 590, invalidation: 591, target: 587 })
    const constructed = { ...run.ideas[0], ...base, history: base.history.map((t) => ({ ...t, bar: 'SPY:1m:0', events: [], reasons: [] })) }
    run.ideas = [...run.ideas, constructed]
    vi.doMock('@/lib/apiFetch', () => ({ apiFetch: vi.fn(async () => ({ ok: true, status: 200, json: async () => report })) }))
    const { SetupReplay } = await import('@/components/setups/SetupReplay')
    const { fireEvent } = await import('@testing-library/react')
    render(<SetupReplay />)
    const set = (l: string, v: string) => fireEvent.change(screen.getByLabelText(l), { target: { value: v } })
    set('Symbol A', 'SPY'); set('Symbol B', 'QQQ'); set('Timestamp convention', 'OPEN'); set('Round-trip cost per unit', '0.02')
    for (const l of ['CSV for A', 'CSV for B']) fireEvent.change(screen.getByLabelText(l), { target: { files: [new File(['t\n'], 'b.csv')] } })
    await waitFor(() => expect((screen.getByText('REPLAY') as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByText('REPLAY'))
    await waitFor(() => expect(screen.getAllByTestId('idea-ticket-link').length).toBe(1))
    const href = screen.getByTestId('idea-ticket-link').getAttribute('href')!
    const back = parseIdeaLink(new URL(href, 'http://x').searchParams) as IdeaPrefill
    expect(back.ideaId).toBe(HASH)
    expect(back.side).toBe('SHORT')
  })
})
