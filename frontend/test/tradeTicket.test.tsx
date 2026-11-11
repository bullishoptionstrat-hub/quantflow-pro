/**
 * The trade ticket.
 *
 * Each block holds one rule the ticket exists for. The complete ticket below is
 * an ES long that passes everything; each test breaks exactly one thing about
 * it, so a failure names the rule rather than a number.
 */
import { describe, expect, test, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { render, screen, fireEvent, within } from '@testing-library/react'
import {
  ADDED_CODES, MODELS, README_CODES, SESSION_PROFILES,
  contractProblem, evaluateTicket, gateWaiting, minutesOf, sessionGate, ticketRecord, visibleGates,
  type AnsweredGateId, type GateResult, type SessionClock, type TicketInput,
} from '@/lib/tradeTicket'
import { gexContext } from '@/lib/gexContext'
import type { GEXResponse } from '@/lib/types'
import { specFor } from '@/lib/contractSpecs'
import type { MarketSession } from '@/lib/marketSession'
// vi.mock below is hoisted above every import, so the page reads the mocked clock.
import TicketPageUnderTest from '@/app/ticket/page'

const CLOCK = vi.hoisted(() => ({
  session: {
    state: 'OPEN', date: '2026-11-09',
    nowMinutesEt: 10 * 60, openMinutesEt: 9 * 60 + 30, closeMinutesEt: 16 * 60,
    basis: 'test', source: 'test', readAt: '2026-11-06',
    coverage: { from: '2026-01-01', to: '2027-12-31' },
  } as unknown,
}))

vi.mock('@/lib/marketSession', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@/lib/marketSession')>()
  return {
    ...orig,
    useMarketSession: () => ({ panel: { status: 'ok', data: CLOCK.session as MarketSession }, sources: { status: 'loading' } }),
  }
})

const specOf = (symbol: string) => {
  const s = specFor(symbol)
  if (!s) throw new Error(`no spec ${symbol}`)
  return { tickSize: s.tickSize, tickValue: s.tickValue, unit: s.unit, micro: s.micro }
}

const at = (hhmm: string, o: Partial<SessionClock> = {}): SessionClock =>
  ({ state: 'OPEN', nowMinutesEt: minutesOf(hhmm), closeMinutesEt: minutesOf('16:00'), ...o })

/** Every gate the input shows, answered PASS. */
function allPass(input: Omit<TicketInput, 'answers'>): TicketInput['answers'] {
  const answers: TicketInput['answers'] = {}
  for (const { def } of visibleGates({ ...input, answers: {} })) answers[def.id] = 'PASS'
  return answers
}

/**
 * ES long, 10-point stop (40 ticks × $12.50 = $500 a contract), $1,000 budget:
 * 2 contracts. One external target 30 points away: 3R with no costs. 10:00 ET,
 * inside the OnePager NY AM window.
 */
function complete(o: Partial<TicketInput> = {}): TicketInput {
  const base: Omit<TicketInput, 'answers'> = {
    symbol: 'ES', spec: specOf('ES'), contract: 'ESZ6', side: 'LONG', setupId: 'ES-1109-01',
    model: 'TRAP_FADE', sessionProfile: 'ONEPAGER', alsoRequire: { candle23: false, cisd: false },
    narrative: {
      htfContext: '4H bullish, discount', poi: '1H iFVG 4988–4992', liquidityEvent: 'Swept ONL, closed back above',
      invalidation: 'Close below 4989', cancelCondition: 'No retest by 11:00', managementPlan: 'Hold to TP1',
      screenshot: 'es-1109-01.png',
    },
    entry: 5000, stop: 4990, targets: [{ price: 5030, kind: 'EXTERNAL' }],
    riskBudget: 1000, costPerUnit: 0, slippageTicks: 0, minR: 2,
    clock: at('10:00'),
    ...o,
  }
  return { ...base, answers: o.answers ?? allPass(base) }
}

const withAnswer = (id: AnsweredGateId, a: 'PASS' | 'FAIL' | undefined, o: Partial<TicketInput> = {}) => {
  const t = complete(o)
  const answers = { ...t.answers }
  if (a === undefined) delete answers[id]
  else answers[id] = a
  return { ...t, answers }
}

describe('the complete ticket', () => {
  test('passes every gate, sizes, and is approved — and the score agrees', () => {
    const r = evaluateTicket(complete())
    expect(r.waiting).toEqual([])
    expect(r.blockers).toEqual([])
    expect(r.state).toBe('APPROVED_TRADE')
    expect(r.sizing?.units).toBe(2)
    expect(r.sizing?.blendedNetR).toBeCloseTo(3, 12)
    expect(r.score.value).toBe(5)
  })
})

describe('a failed required gate blocks, under its own code', () => {
  const required = visibleGates(complete()).filter((g) => g.required)

  test.each(required.map((g) => [g.def.id, g.def.code] as const))('%s FAIL is %s', (id, code) => {
    const r = evaluateTicket(withAnswer(id, 'FAIL'))
    expect(r.state).toBe('BLOCKED')
    expect(r.blockers.map((b) => b.code)).toEqual([code])
  })

  test('an unanswered required gate waits, and says which', () => {
    for (const g of required) {
      const r = evaluateTicket(withAnswer(g.def.id, undefined))
      expect(r.state).toBe('WAIT_FOR_TRIGGER')
      expect(r.waiting).toContain(`Answer: ${g.def.title}.`)
    }
  })
})

describe('a score never approves', () => {
  test('5 of 5 with the daily lock active is blocked', () => {
    const r = evaluateTicket(withAnswer('dailyLock', 'FAIL'))
    expect(r.score.value).toBe(5)
    expect(r.state).toBe('BLOCKED')
    expect(r.blockers.map((b) => b.code)).toEqual(['DAILY_LOCK_ACTIVE'])
  })

  test('5 of 5 with no pre-entry screenshot waits', () => {
    const t = complete()
    const r = evaluateTicket({ ...t, narrative: { ...t.narrative, screenshot: '  ' } })
    expect(r.score.value).toBe(5)
    expect(r.state).toBe('WAIT_FOR_TRIGGER')
    expect(r.waiting).toContain('Write the pre-entry screenshot.')
  })
})

describe('direction is earned, and locks outrank it', () => {
  test('no direction is NEUTRAL, however complete the rest', () => {
    expect(evaluateTicket(complete({ side: null })).state).toBe('NEUTRAL')
  })

  test.each(['dailyLock', 'firstAttempt', 'traderState'] as const)('a failed %s blocks even with no direction', (id) => {
    const r = evaluateTicket(withAnswer(id, 'FAIL', { side: null }))
    expect(r.state).toBe('BLOCKED')
  })

  test('a setup gate failing with no direction is still NEUTRAL: it has nothing to be aligned with', () => {
    expect(evaluateTicket(withAnswer('htfAlignment', 'FAIL', { side: null })).state).toBe('NEUTRAL')
  })
})

describe('paired SMT', () => {
  test.each(['ES', 'MES', 'NQ', 'MNQ', 'SPY', 'QQQ', 'CUSTOM'])('is required for %s', (symbol) => {
    const g = visibleGates({ ...complete(), symbol }).find((x) => x.def.id === 'smt')
    expect(g?.required).toBe(true)
  })

  test('is optional for metals: recorded and scored, never gating', () => {
    // GC, 10-point stop = 100 ticks × $10 = $1,000; $2,000 buys 2. Target 30 points: 3R.
    const gc = (answer: 'FAIL' | undefined) => {
      const t = complete({ symbol: 'GC', spec: specOf('GC'), contract: 'GCZ6', entry: 2000, stop: 1990, riskBudget: 2000, targets: [{ price: 2030, kind: 'EXTERNAL' }] })
      const answers = { ...t.answers }
      if (answer) answers.smt = answer
      else delete answers.smt
      return evaluateTicket({ ...t, answers })
    }
    expect(gc('FAIL').state).toBe('APPROVED_TRADE')
    expect(gc('FAIL').score.value).toBe(4)
    expect(gc(undefined).state).toBe('APPROVED_TRADE')
  })
})

describe('the session window is measured on the backend clock', () => {
  const g = (profile: Parameters<typeof sessionGate>[0], clock: SessionClock | null) => sessionGate(profile, clock)

  test('start is inside, end is outside', () => {
    expect(g('ONEPAGER', at('09:30')).status).toBe('PASS')
    expect(g('ONEPAGER', at('11:29')).status).toBe('PASS')
    expect(g('ONEPAGER', at('11:30')).status).toBe('FAIL')
    expect(g('ONEPAGER', at('09:29')).status).toBe('FAIL')
  })

  test('a London window before the open passes on an ordinary day', () => {
    expect(g('ONEPAGER', at('03:30', { state: 'CLOSED_OUTSIDE_HOURS' })).status).toBe('PASS')
  })

  test('a window after a half day\'s published close fails; the same time on a full day passes', () => {
    const half = g('ONEPAGER', at('13:45', { state: 'CLOSED_OUTSIDE_HOURS', closeMinutesEt: minutesOf('13:00') }))
    expect(half.status).toBe('FAIL')
    expect(half.detail).toMatch(/after today's published close at 13:00 ET/)
    expect(g('ONEPAGER', at('13:45')).status).toBe('PASS')
  })

  test('a weekend fails; a holiday, an unknown date or no clock cannot be measured', () => {
    expect(g('ONEPAGER', at('10:00', { state: 'CLOSED_WEEKEND' })).status).toBe('FAIL')
    expect(g('ONEPAGER', at('10:00', { state: 'CLOSED_HOLIDAY' })).status).toBe('UNMEASURABLE')
    expect(g('ONEPAGER', at('10:00', { state: 'UNKNOWN' })).status).toBe('UNMEASURABLE')
    expect(g('ONEPAGER', at('10:00', { nowMinutesEt: null })).status).toBe('UNMEASURABLE')
    expect(g('ONEPAGER', null).status).toBe('UNMEASURABLE')
  })

  test('unmeasurable waits; outside the window blocks; no profile waits', () => {
    expect(evaluateTicket(complete({ clock: null })).state).toBe('WAIT_FOR_TRIGGER')
    expect(evaluateTicket(complete({ clock: at('10:00', { state: 'CLOSED_HOLIDAY' }) })).state).toBe('WAIT_FOR_TRIGGER')
    const out = evaluateTicket(complete({ clock: at('12:00') }))
    expect(out.state).toBe('BLOCKED')
    expect(out.blockers.map((b) => b.code)).toEqual(['SESSION_MODEL_MISSING'])
    const none = evaluateTicket(complete({ sessionProfile: null }))
    expect(none.state).toBe('WAIT_FOR_TRIGGER')
    expect(none.waiting).toContain('Choose a session profile.')
  })

  test('each profile is the trader\'s own windows, in order and non-overlapping', () => {
    for (const p of Object.values(SESSION_PROFILES)) {
      let prev = -1
      for (const w of p.windows) {
        expect(minutesOf(w.from)).toBeGreaterThanOrEqual(prev)
        expect(minutesOf(w.to)).toBeGreaterThan(minutesOf(w.from))
        prev = minutesOf(w.to)
      }
    }
  })
})

describe('the reward gate is computed, after costs', () => {
  test('1.5R is blocked under REWARD_UNDER_2R', () => {
    const r = evaluateTicket(complete({ targets: [{ price: 5015, kind: 'EXTERNAL' }] }))
    expect(r.state).toBe('BLOCKED')
    expect(r.blockers.map((b) => b.code)).toEqual(['REWARD_UNDER_2R'])
  })

  test('a gross 2R trade with costs is below 2R and blocked', () => {
    // 80 ticks × 12.50 = 1,000 reward; 40 ticks = 500 risk. With $5 round trip: 995 / 505.
    const r = evaluateTicket(complete({ targets: [{ price: 5020, kind: 'EXTERNAL' }], costPerUnit: 5 }))
    expect(r.blockers.map((b) => b.code)).toEqual(['REWARD_UNDER_2R'])
  })

  test('a minimum under 2R is refused; a higher one is honoured', () => {
    const low = evaluateTicket(complete({ minR: 1.5 }))
    expect(low.state).toBe('WAIT_FOR_TRIGGER')
    expect(low.waiting.join(' ')).toMatch(/strict minimum is 2R/)
    const high = evaluateTicket(complete({ minR: 4 }))
    expect(high.state).toBe('BLOCKED')
    expect(high.blockers[0]!.reason).toMatch(/4R minimum/)
  })

  test('a 1.5R idea typed against a 1.5R minimum is still blocked: the floor reaches the sizing', () => {
    // Without the floor the sizing would read 1.5R as a pass, and the ticket
    // would only wait on the refused minimum. With it, the reward gate fails.
    const r = evaluateTicket(complete({ minR: 1.5, targets: [{ price: 5015, kind: 'EXTERNAL' }] }))
    expect(r.state).toBe('BLOCKED')
    expect(r.blockers.map((b) => b.code)).toEqual(['REWARD_UNDER_2R'])
  })

  test('the reward is read from the whole-unit split, not the shares', () => {
    // $1,500 buys 3. 50/50 of 3 is 2 at 1R and 1 at 3R: 5 / 3 = 1.67R, blocked.
    // Blending by share would read 2R and approve.
    const r = evaluateTicket(complete({
      riskBudget: 1500,
      targets: [{ price: 5010, share: 0.5, kind: 'INTERNAL' }, { price: 5030, share: 0.5, kind: 'EXTERNAL' }],
    }))
    expect(r.sizing?.targets.map((t) => t.units)).toEqual([2, 1])
    expect(r.blockers.map((b) => b.code)).toEqual(['REWARD_UNDER_2R'])
  })
})

describe('a required computed gate that cannot be measured waits — any of them', () => {
  // The rule used to read `UNMEASURABLE && id === 'session'`, so only the
  // session window was held to it. A required COMPUTED gate is a measurement,
  // and a measurement nobody could take is not a pass.
  const reward: GateResult = {
    id: 'reward', code: 'REWARD_UNDER_2R', title: 'Net reward', required: true, source: 'COMPUTED',
    status: 'UNMEASURABLE', detail: 'Computed once the idea is sized against at least one target.',
  }

  test('a non-session computed gate that reads UNMEASURABLE leaves the ticket waiting', () => {
    expect(gateWaiting([reward])).toEqual([
      'Net reward cannot be measured: Computed once the idea is sized against at least one target.',
    ])
  })

  test('every required computed gate on a complete ticket would wait if it could not be measured', () => {
    const computed = evaluateTicket(complete()).gates.filter((g) => g.required && g.source === 'COMPUTED')
    expect(computed.map((g) => g.id).sort()).toEqual(['reward', 'session'])
    for (const g of computed) {
      expect(gateWaiting([{ ...g, status: 'UNMEASURABLE' }])).toEqual([`${g.title} cannot be measured: ${g.detail}`])
    }
  })

  test('decided and optional gates leave nothing waiting', () => {
    expect(gateWaiting([{ ...reward, status: 'PASS' }, { ...reward, status: 'FAIL' }, { ...reward, required: false }])).toEqual([])
  })

  test('on the ticket: an unmeasurable reward is listed, not left to another line to cover', () => {
    const r = evaluateTicket(complete({ targets: [] }))
    expect(r.state).toBe('WAIT_FOR_TRIGGER')
    expect(r.gates.find((g) => g.id === 'reward')?.status).toBe('UNMEASURABLE')
    expect(r.waiting).toContain(`Net reward cannot be measured: ${reward.detail}`)
    expect(r.waiting).toContain('Enter at least one target.')
  })

  test('the session window still reads as it did', () => {
    const r = evaluateTicket(complete({ clock: null }))
    expect(r.waiting).toContain('Session window cannot be measured: The backend did not answer, so the ET clock could not be read.')
  })

  test('precedence is unchanged: lock, then a failed gate, then size, then waiting', () => {
    expect(evaluateTicket(withAnswer('dailyLock', 'FAIL', { clock: null, side: null })).state).toBe('BLOCKED')
    expect(evaluateTicket(complete({ clock: null, side: null })).state).toBe('NEUTRAL')
    expect(evaluateTicket(withAnswer('retest', 'FAIL', { clock: null })).state).toBe('BLOCKED')
    expect(evaluateTicket(complete({ clock: null, riskBudget: 400 })).state).toBe('NO_TRADE')
    expect(evaluateTicket(complete({ clock: null })).state).toBe('WAIT_FOR_TRIGGER')
  })
})

describe('GEX context is beside the ticket, never in it', () => {
  const recorded = (): GEXResponse => JSON.parse(readFileSync(
    join(__dirname, '..', '..', 'backend', 'test', 'fixtures', 'gex.json'), 'utf8'))

  test('the verdict is identical with and without GEX context, for every kind of ticket', () => {
    const ctx = gexContext({ ...recorded(), spot: 760, asOf: '2026-09-15T19:46:01.000Z' })
    const tickets: TicketInput[] = [
      complete(), complete({ side: null }), complete({ clock: null }), complete({ targets: [] }),
      complete({ riskBudget: 400 }), withAnswer('retest', 'FAIL'), withAnswer('smt', undefined),
      complete({ symbol: 'SPY', spec: specOf('SPY'), contract: '' }),
    ]
    for (const t of tickets) {
      const withGex = { ...t, gex: ctx, gexContext: ctx } as TicketInput
      expect(evaluateTicket(withGex)).toEqual(evaluateTicket(t))
    }
  })

  test('the ticket module never reads GEX, and the page never puts it into the input', () => {
    // Comments are stripped, and so is `RegExp`, whose middle spells "gEx".
    const strip = (x: string) =>
      x.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '').replace(/RegExp/g, '')
    const ticket = strip(readFileSync(join(__dirname, '..', 'lib', 'tradeTicket.ts'), 'utf8'))
    expect(ticket).not.toMatch(/gex/i)
    const page = strip(readFileSync(join(__dirname, '..', 'app', 'ticket', 'page.tsx'), 'utf8'))
    const start = page.indexOf('const input: TicketInput = useMemo(')
    expect(start).toBeGreaterThan(0)
    const inputBlock = page.slice(start, page.indexOf('const result = useMemo(', start))
    expect(inputBlock).not.toMatch(/gex/i)
    expect(page).toMatch(/<GexContextPanel symbol=\{symbol\} \/>/)
  })
})

describe('what cannot be sized is not traded', () => {
  test('one contract over budget is NO_TRADE, naming the micro', () => {
    const r = evaluateTicket(complete({ riskBudget: 400 }))
    expect(r.state).toBe('NO_TRADE')
    expect(r.waiting.join(' ')).toMatch(/MES/)
  })

  test('a failed gate outranks no size', () => {
    expect(evaluateTicket(withAnswer('retest', 'FAIL', { riskBudget: 400 })).state).toBe('BLOCKED')
  })
})

describe('models and requirements tighten, never loosen', () => {
  test('the trap-fade does not ask for CISD, Candle 2/3 or an iFVG', () => {
    const ids = visibleGates(complete()).map((g) => g.def.id)
    expect(ids).not.toContain('cisd')
    expect(ids).not.toContain('candle23')
    expect(ids).not.toContain('ifvgInversion')
  })

  test('the four-layer model requires the iFVG inversion and CISD', () => {
    const t = complete({ model: 'AMD_IFVG' })
    const req = visibleGates(t).filter((g) => g.required).map((g) => g.def.id)
    expect(req).toEqual(expect.arrayContaining(MODELS.AMD_IFVG.requires))
    // allPass() answered them, so it approves; failing either blocks.
    expect(evaluateTicket(t).state).toBe('APPROVED_TRADE')
    expect(evaluateTicket(withAnswer('ifvgInversion', 'FAIL', { model: 'AMD_IFVG' })).blockers.map((b) => b.code)).toEqual(['NO_IFVG_INVERSION'])
  })

  test('"also require" adds Candle 2/3 and CISD to any model', () => {
    const t = complete({ alsoRequire: { candle23: true, cisd: true } })
    const req = visibleGates(t).filter((g) => g.required).map((g) => g.def.id)
    expect(req).toEqual(expect.arrayContaining(['candle23', 'cisd']))
  })

  test('the liquidity gate reads differently per model', () => {
    const pass = (m: keyof typeof MODELS) => visibleGates(complete({ model: m })).find((g) => g.def.id === 'liquidityEvent')!.def.pass
    expect(pass('TRAP_FADE')).toMatch(/swept/)
    expect(pass('HTF_CONTINUATION')).toMatch(/break, retest and acceptance/)
  })
})

describe('blocker codes', () => {
  test('every README code can be produced, plus the two added here', () => {
    const t = complete({ model: 'AMD_IFVG', alsoRequire: { candle23: true, cisd: true } })
    const codes = new Set(evaluateTicket(t).gates.map((g) => g.code))
    for (const c of [...README_CODES, ...ADDED_CODES]) expect(codes).toContain(c)
  })
})

describe('the exact contract', () => {
  test.each([
    ['ES', 'ESZ6', null],
    ['ES', 'esz26', null],
    ['ES', 'MESZ6', 'does not match ES'],
    ['ES', 'NQZ6', 'does not match ES'],
    ['ES', 'ES', 'does not match ES'],
    ['ES', 'ESL6', 'does not match ES'],
    ['SI', 'SILZ6', 'does not match SI'],
    ['ES', '', 'Enter the exact contract'],
  ] as const)('%s / %s', (symbol, contract, problem) => {
    const p = contractProblem(symbol, 'contract', contract)
    if (problem === null) expect(p).toBeNull()
    else expect(p).toMatch(problem)
  })

  test('share instruments have no contract to check', () => {
    expect(contractProblem('SPY', 'share', '')).toBeNull()
  })

  test('a mismatched contract keeps the ticket waiting', () => {
    expect(evaluateTicket(complete({ contract: 'MESZ6' })).state).toBe('WAIT_FOR_TRIGGER')
  })
})

describe('the ticket record', () => {
  test('round-trips as JSON and says what it is', () => {
    const t = complete()
    const rec = JSON.parse(JSON.stringify(ticketRecord(t, evaluateTicket(t), '2026-11-09T15:00:00.000Z', 'UNVERIFIED')))
    expect(rec.schema).toBe('quantflow.ticket/v1')
    expect(rec.state).toBe('APPROVED_TRADE')
    expect(rec.note).toMatch(/places no order/)
    expect(rec.score.rankingOnly).toBe(true)
    expect(rec.specStatus).toBe('UNVERIFIED')
    expect(rec.plan.stopTicks).toBe(40)
    expect(rec.plan.stopPoints).toBe(10)
    expect(rec.plan.units).toBe(2)
    expect(rec.plan.targets[0].kind).toBe('EXTERNAL')
    const sources = new Set(rec.gates.map((g: { source: string }) => g.source))
    expect(sources).toEqual(new Set(['TRADER', 'COMPUTED']))
  })

  test('a blocked ticket records its codes', () => {
    const t = withAnswer('noDenial', 'FAIL')
    const rec = ticketRecord(t, evaluateTicket(t), '2026-11-09T15:00:00.000Z', 'UNVERIFIED')
    expect(rec.blockers.map((b) => b.code)).toEqual(['DENIAL_OVERRIDE'])
  })
})

describe('the page', () => {
  const src = readFileSync(join(__dirname, '..', 'app', 'ticket', 'page.tsx'), 'utf8')

  test('nothing is pre-answered in the source', () => {
    expect(src).toMatch(/const \[symbol, setSymbol\] = useState\(''\)/)
    expect(src).toMatch(/const \[side, setSide\] = useState<Side \| null>\(null\)/)
    expect(src).toMatch(/const \[budget, setBudget\] = useState\(''\)/)
    expect(src).toMatch(/const \[cost, setCost\] = useState\(''\)/)
    expect(src).toMatch(/const \[slippage, setSlippage\] = useState\(''\)/)
    expect(src).toMatch(/useState<Partial<Record<AnsweredGateId, Answer>>>\(\{\}\)/)
  })

  test('starts NEUTRAL with no direction chosen', () => {
    render(<TicketPageUnderTest />)
    expect(screen.getByTestId('ticket-state').textContent).toBe('NEUTRAL — WAITING')
    for (const b of within(screen.getByRole('group', { name: 'direction' })).getAllByRole('button')) {
      expect(b.getAttribute('aria-pressed')).toBe('false')
    }
  })

  test('a ticket filled in by hand is approved, and one failed gate blocks it', () => {
    render(<TicketPageUnderTest />)
    const set = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } })
    set('INSTRUMENT', 'ES')
    set('EXACT CONTRACT', 'ESZ6')
    fireEvent.click(screen.getByRole('button', { name: 'LONG' }))
    set('SETUP / IDEA ID', 'ES-1109-01')
    set('MODEL', 'TRAP_FADE')
    set('SESSION PROFILE', 'ONEPAGER')
    for (const b of screen.getAllByRole('button', { name: /: pass$/ })) fireEvent.click(b)
    set('HTF CONTEXT', '4H bullish')
    set('POI', '1H iFVG')
    set('LIQUIDITY EVENT', 'Swept ONL')
    set('INVALIDATION', 'Close below 4989')
    set('CANCEL CONDITION', 'No retest by 11:00')
    set('MANAGEMENT PLAN', 'Hold to TP1')
    set('PRE-ENTRY SCREENSHOT', 'es.png')
    set('ENTRY', '5000')
    set('STOP / INVALIDATION', '4990')
    set('RISK BUDGET ($ THIS IDEA MAY LOSE)', '1000')
    set('ROUND-TRIP COST ($ PER CONTRACT)', '0')
    set('STOP SLIPPAGE (TICKS)', '0')
    set('TP1 PRICE', '5030')
    set('TP1 LIQUIDITY', 'EXTERNAL')

    expect(screen.queryByTestId('waiting')).toBeNull()
    expect(screen.getByTestId('ticket-state').textContent).toBe('APPROVED TRADE')
    expect(screen.getByTestId('ticket-size').textContent).toMatch(/SIZE 2 contracts/)

    fireEvent.click(screen.getByRole('button', { name: 'Daily lock: fail' }))
    expect(screen.getByTestId('ticket-state').textContent).toBe('BLOCKED')
    expect(screen.getByTestId('blockers').textContent).toMatch(/DAILY_LOCK_ACTIVE/)
  })
})
