/**
 * A pre-trade ticket: the God's Plan gates first, then the size.
 *
 * The ticket's job is to say NO clearly, and to say why. It is not an order
 * ticket and it sends nothing anywhere: APPROVED_TRADE means "every required
 * gate passed and the idea sizes to at least the minimum R", which is
 * permission to place an order by hand, not an order.
 *
 * The rules it enforces, each closing a specific way a checklist misleads:
 *
 *  - **A score never approves.** The five-part confluence score is shown for
 *    ranking only. Every required gate is checked on its own, so a 5/5 idea
 *    with the daily lock active is BLOCKED, not "strong".
 *  - **Unanswered is not passed.** A gate nobody ticked is WAIT_FOR_TRIGGER.
 *    A gate this terminal cannot measure (no clock from the backend, a date the
 *    calendar will not answer for) is UNMEASURABLE, and that waits too.
 *  - **No direction by default.** The ticket starts NEUTRAL. A direction is
 *    chosen, never pre-selected.
 *  - **Locks outrank everything.** The daily lock, a used attempt and the
 *    trader's own state block even a ticket with no direction yet: they are
 *    about the trader, not the setup.
 *  - **Requirements can be tightened, never loosened.** A model adds gates;
 *    the "also require" switches add gates; nothing here removes one.
 *  - **The reward gate is computed, not ticked.** It reads `sizePosition`'s
 *    blended net R of the split that can actually be filled, after costs.
 *
 *  - **The daily plan tightens, and passes only itself.** `PLAN_NOT_WRITTEN`
 *    passes when today's plan (on the backend's ET date) is written with its
 *    checklist complete; otherwise it waits. The plan's written loss limit and
 *    maximum attempts, measured against the journal, can only fail the daily
 *    lock; its event windows can only fail or wait `EVENT_STAND_ASIDE`.
 *
 * What it does not know, and does not pretend to: whether any answer the
 * trader gives is true. Every TRADER gate is the trader's own observation,
 * labelled as such in the export. Measured here: the session window, the
 * reward, the plan's own gate, and the plan's and journal's tightenings.
 */
import type { MarketSession } from './marketSession'
import { sizePosition, type Side, type SizingResult, type SizingSpec } from './riskSize'

export type DecisionState = 'NEUTRAL' | 'WAIT_FOR_TRIGGER' | 'BLOCKED' | 'NO_TRADE' | 'APPROVED_TRADE'

/** The terminal README's blocker codes, kept by name. */
export const README_CODES = [
  'NO_SMT', 'MIDRANGE_COMPRESSION', 'NO_DISPLACEMENT', 'NO_RETEST', 'NO_ENGULF_OR_REJECTION',
  'HTF_MISALIGNMENT', 'NO_CANDLE2_OR_CANDLE3_CLOSE', 'NO_CISD', 'WEAK_POI', 'DENIAL_OVERRIDE',
  'NO_EXTERNAL_SWEEP_OR_HTF_RETEST', 'REWARD_UNDER_2R', 'OPPOSING_LIQUIDITY_UNDER_ATTACK',
  'SESSION_MODEL_MISSING', 'DAILY_LOCK_ACTIVE', 'ONE_ATTEMPT_ALREADY_USED',
] as const

/**
 * Codes added here because playbook rules had none: the four-layer model's
 * iFVG inversion, the trader-state blocker (tilt, fatigue, revenge intent),
 * the pre-session plan (`PLAN_NOT_WRITTEN`), and standing aside around a
 * scheduled event the plan declares (`EVENT_STAND_ASIDE`).
 */
export const ADDED_CODES = ['NO_IFVG_INVERSION', 'TRADER_STATE_NOT_CLEAR', 'PLAN_NOT_WRITTEN', 'EVENT_STAND_ASIDE'] as const

export type BlockerCode = typeof README_CODES[number] | typeof ADDED_CODES[number]

export type AnsweredGateId =
  | 'traderState' | 'dailyLock' | 'firstAttempt'
  | 'htfAlignment' | 'liquidityEvent' | 'poiQuality' | 'smt'
  | 'displacement' | 'retest' | 'confirmation'
  | 'notMidrange' | 'noDenial' | 'opposingLiquidity'
  | 'candle23' | 'cisd' | 'ifvgInversion'

export type GateId = AnsweredGateId | 'session' | 'reward' | 'plan' | 'eventStandAside'

export type Answer = 'PASS' | 'FAIL'

export interface GateDef {
  id: AnsweredGateId
  code: BlockerCode
  title: string
  /** What must be true to answer PASS. */
  pass: string
  /** What answering FAIL means. */
  fail: string
  /** About the trader, not the setup: blocks even before a direction is chosen. */
  lock?: true
}

export const ANSWERED_GATES: readonly GateDef[] = [
  { id: 'traderState', code: 'TRADER_STATE_NOT_CLEAR', lock: true, title: 'Trader state',
    pass: 'No tilt, fatigue, revenge intent, or need to trade.',
    fail: 'Tilted, tired, chasing a loss, sizing up after wins, or trading to trade.' },
  { id: 'dailyLock', code: 'DAILY_LOCK_ACTIVE', lock: true, title: 'Daily lock',
    pass: "Today's written loss limit and lockout are not hit, and no condition ban applies.",
    fail: 'The daily loss limit, the two-stop-out lockout, or a condition ban is active.' },
  { id: 'firstAttempt', code: 'ONE_ATTEMPT_ALREADY_USED', lock: true, title: 'First attempt',
    pass: 'This is the first attempt at this idea.',
    fail: 'This idea already had its attempt. It needs a new higher-timeframe trigger.' },
  { id: 'htfAlignment', code: 'HTF_MISALIGNMENT', title: 'HTF alignment',
    pass: 'Higher-timeframe bias agrees with this direction, and no conflicting HTF zone is in the way.',
    fail: 'HTF bias disagrees, or a conflicting HTF zone sits in the path.' },
  { id: 'liquidityEvent', code: 'NO_EXTERNAL_SWEEP_OR_HTF_RETEST', title: 'Liquidity event',
    pass: '(set by the model)', fail: '(set by the model)' },
  { id: 'poiQuality', code: 'WEAK_POI', title: 'POI quality',
    pass: 'A defined POI (FVG, iFVG, order block, breaker) with HTF context and displacement away from it.',
    fail: 'Weak POI: no HTF context, or no displacement from it.' },
  { id: 'smt', code: 'NO_SMT', title: 'Paired SMT',
    pass: 'Paired SMT is clear, current and agrees with this direction.',
    fail: 'SMT is absent, unclear, mixed, stale or opposing.' },
  { id: 'displacement', code: 'NO_DISPLACEMENT', title: 'Displacement',
    pass: 'Displacement with a structure shift (BOS / CHoCH / MSS).',
    fail: 'No displacement, or no structure shift.' },
  { id: 'retest', code: 'NO_RETEST', title: 'Retest',
    pass: 'Price came back and retested the POI after the shift.',
    fail: 'No retest yet. Entering now is a first touch or a chase.' },
  { id: 'confirmation', code: 'NO_ENGULF_OR_REJECTION', title: 'Closed confirmation',
    pass: 'A CLOSED engulfing or strong rejection candle at the retest.',
    fail: 'No closed confirmation candle. A candle still forming does not count.' },
  { id: 'notMidrange', code: 'MIDRANGE_COMPRESSION', title: 'Out of equilibrium',
    pass: 'A long from discount or a short from premium, out of chop and compression.',
    fail: 'At equilibrium, in chop, or in tight compression (three or more overlapping candles).' },
  { id: 'noDenial', code: 'DENIAL_OVERRIDE', title: 'No denial',
    pass: 'No front-run or denial has cancelled the scenario, and this is not an unconfirmed first Judas leg.',
    fail: 'Price reversed with displacement before the anticipated pool, or this is an unconfirmed first Judas leg.' },
  { id: 'opposingLiquidity', code: 'OPPOSING_LIQUIDITY_UNDER_ATTACK', title: 'Opposing liquidity',
    pass: 'Opposing liquidity is not being taken, and there is room before it.',
    fail: 'Opposing liquidity is under attack, or the target runs into it.' },
  { id: 'candle23', code: 'NO_CANDLE2_OR_CANDLE3_CLOSE', title: 'Candle 2/3 closure',
    pass: 'TTrades Candle 2 or Candle 3 has closed, confirming the HTF reaction.',
    fail: 'No Candle 2/3 closure yet.' },
  { id: 'cisd', code: 'NO_CISD', title: 'CISD',
    pass: 'Lower-timeframe CISD (change in the state of delivery) is confirmed.',
    fail: 'No CISD.' },
  { id: 'ifvgInversion', code: 'NO_IFVG_INVERSION', title: 'iFVG inversion',
    pass: 'A lower-timeframe FVG was inverted by a candle closing through it.',
    fail: 'No confirmed iFVG inversion.' },
]

export type ModelId = 'TRAP_FADE' | 'HTF_CONTINUATION' | 'AMD_IFVG'

export interface ModelDef {
  label: string
  liquidityPass: string
  liquidityFail: string
  /** Gates this model adds to the core set. */
  requires: AnsweredGateId[]
}

export const MODELS: Record<ModelId, ModelDef> = {
  TRAP_FADE: {
    label: 'Trap-fade: sweep & reclaim / sell the rip',
    liquidityPass: 'A named external liquidity pool was swept and a candle closed back through it. A wick alone is not a reclaim.',
    liquidityFail: 'No external sweep, or no close back through the swept level.',
    requires: [],
  },
  HTF_CONTINUATION: {
    label: 'HTF continuation',
    liquidityPass: 'A higher-timeframe break, retest and acceptance is confirmed in this direction.',
    liquidityFail: 'No confirmed HTF break, retest and acceptance. An indicator flip does not count.',
    requires: [],
  },
  AMD_IFVG: {
    label: 'AMD / PO3 / iFVG four-layer',
    liquidityPass: 'An external liquidity pool was swept (layer 1). The POI gate is the HTF FVG/OB location (layer 2).',
    liquidityFail: 'No external sweep. A sweep alone does not establish distribution, but without one there is no model.',
    requires: ['ifvgInversion', 'cisd'],
  },
}

export type SessionProfileId = 'ONEPAGER' | 'LEGACY_RESEARCH' | 'PROP_REPORT'

export interface SessionWindow { name: string; from: string; to: string }

/**
 * Trading windows, ET, start inclusive and end exclusive. These are the
 * trader's own profiles from the playbook notes, not market hours: whether the
 * exchange is open on a date comes from the backend's calendar.
 */
export const SESSION_PROFILES: Record<SessionProfileId, { label: string; windows: SessionWindow[] }> = {
  ONEPAGER: {
    label: 'OnePager',
    windows: [
      { name: 'London', from: '03:00', to: '05:00' },
      { name: 'NY AM', from: '09:30', to: '11:30' },
      { name: 'NY PM', from: '13:30', to: '15:00' },
    ],
  },
  LEGACY_RESEARCH: {
    label: 'Legacy research',
    windows: [
      { name: 'London', from: '02:00', to: '05:00' },
      { name: 'NY AM', from: '08:00', to: '11:30' },
      { name: 'NY PM', from: '13:00', to: '16:00' },
    ],
  },
  PROP_REPORT: {
    label: 'Prop report',
    windows: [
      { name: 'Premarket', from: '07:00', to: '08:30' },
      { name: 'NY', from: '08:30', to: '11:00' },
      { name: 'NY PM', from: '13:30', to: '15:00' },
    ],
  },
}

/** Instruments where paired SMT is mandatory in the strict profile. */
export const SMT_REQUIRED_SYMBOLS = ['ES', 'MES', 'NQ', 'MNQ', 'SPY', 'QQQ'] as const

/** CUSTOM cannot be classified, so it gets the strict answer. */
export function smtRequired(symbol: string): boolean {
  return symbol === 'CUSTOM' || (SMT_REQUIRED_SYMBOLS as readonly string[]).includes(symbol)
}

/** The strict profile's floor. A lower minimum is a relaxed variant, not offered here. */
export const STRICT_MIN_R = 2

/**
 * Losing trades in one ET calendar day that lock the rest of it: the
 * playbook's conservative two-stop-out default. A stricter personal rule is
 * the trader's own answer to the daily-lock gate; this only adds to it.
 */
export const STOP_OUT_LOCK = 2

/**
 * What the journal in this browser knows about this idea and today. It can
 * only tighten the two gates it informs: a journal that has no record proves
 * nothing (it may be another browser's), so the trader's answer stands.
 */
export interface JournalContext {
  /** Earlier entries with this setup ID that were taken. */
  priorAttempts: number
  /** Closed losing trades whose last exit fell on today's ET date. */
  stopOutsToday: number
}

/** A stand-aside window the plan declares, in ET minutes past midnight, start inclusive, end exclusive. */
export interface PlanEventWindow {
  name: string
  /** The event's own time, `HH:MM` ET. */
  time: string
  start: number
  end: number
}

/**
 * What today's daily plan says, as `lib/dailyPlan.ts` reads it for the date
 * the backend published. The ticket compares; it computes none of this.
 *
 * It can PASS exactly one gate — `PLAN_NOT_WRITTEN`, its own — and can only
 * turn the daily lock to FAIL or add a gate that fails or waits
 * (`EVENT_STAND_ASIDE`). A plan never answers a gate the trader left open.
 */
export type PlanContext =
  /** The date or the stored plans could not be read, so nothing can be matched. */
  | { status: 'UNAVAILABLE'; reason: string }
  | { status: 'NOT_WRITTEN'; date: string }
  | {
      status: 'WRITTEN'
      date: string
      /** Checklist items not complete, each saying what is missing. Empty: complete. */
      missing: string[]
      /** The strictest written across the plan and its amendments. Null: not written. */
      lossLimit: number | null
      maxAttempts: number | null
      /** Every stand-aside window the plan or an amendment declares. */
      windows: PlanEventWindow[]
      /** The journal's figures for the plan's date. Null when the journal could not be read. */
      day: { realizedLoss: number; lossesWithoutFees: number; attempts: number } | null
    }

/** Is `now` (ET minutes) inside the window? Start inclusive, end exclusive. */
export function windowContains(w: PlanEventWindow, now: number): boolean {
  return now >= w.start && now < w.end
}

const usd = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

/**
 * Why the day is locked, from what this browser measured: the journal's
 * stop-outs and the plan's written limits. Empty means nothing measured locks
 * it, which is not the same as unlocked — the trader's own answer still stands.
 *
 * "Reaches" is `>=`: a $500 limit is hit by a $500 loss, and a maximum of two
 * attempts is used up by the second.
 */
export function dailyLockReasons(journal: JournalContext | null | undefined, plan: PlanContext | null | undefined): string[] {
  const out: string[] = []
  if (journal && journal.stopOutsToday >= STOP_OUT_LOCK) {
    out.push(`The journal in this browser holds ${journal.stopOutsToday} losing trades today (ET). ${STOP_OUT_LOCK} stop-outs lock the day.`)
  }
  if (plan?.status === 'WRITTEN' && plan.day) {
    const d = plan.day
    if (plan.lossLimit !== null && d.realizedLoss >= plan.lossLimit) {
      const atLeast = d.lossesWithoutFees > 0
        ? ` (at least: ${d.lossesWithoutFees} losing trade${d.lossesWithoutFees === 1 ? ' has' : 's have'} no fees entered and count at gross)`
        : ''
      out.push(`Realized loss on ${plan.date} is ${usd(d.realizedLoss)}${atLeast}, which reaches the plan's written daily limit of ${usd(plan.lossLimit)}.`)
    }
    if (plan.maxAttempts !== null && d.attempts >= plan.maxAttempts) {
      out.push(`${d.attempts} attempt${d.attempts === 1 ? '' : 's'} taken on ${plan.date}, which uses the plan's maximum of ${plan.maxAttempts}.`)
    }
  }
  return out
}

/** The plan's own gate: PASS only for a written plan whose checklist is complete. */
export function planGate(plan: PlanContext | null | undefined): { status: GateStatus; detail: string } {
  if (!plan) return { status: 'UNMEASURABLE', detail: 'No daily plan was consulted.' }
  if (plan.status === 'UNAVAILABLE') return { status: 'UNMEASURABLE', detail: plan.reason }
  if (plan.status === 'NOT_WRITTEN') {
    return { status: 'UNANSWERED', detail: `No daily plan is written for ${plan.date} (ET, the backend's date). Write it on the Daily Plan page.` }
  }
  if (plan.missing.length) {
    return { status: 'UNANSWERED', detail: `The daily plan for ${plan.date} is incomplete. ${plan.missing.join(' ')}` }
  }
  return { status: 'PASS', detail: `The daily plan for ${plan.date} is written and its pre-session checklist is complete.` }
}

export type TargetKind = 'INTERNAL' | 'EXTERNAL'

export interface TicketTarget {
  price: number
  /** Fraction 0..1. Omit for a single target. */
  share?: number
  kind: TargetKind | null
}

export interface Narrative {
  htfContext: string
  poi: string
  liquidityEvent: string
  invalidation: string
  cancelCondition: string
  managementPlan: string
  screenshot: string
}

export const NARRATIVE_FIELDS: readonly { key: keyof Narrative; label: string }[] = [
  { key: 'htfContext', label: 'HTF context' },
  { key: 'poi', label: 'POI' },
  { key: 'liquidityEvent', label: 'Liquidity event' },
  { key: 'invalidation', label: 'Invalidation' },
  { key: 'cancelCondition', label: 'Cancel condition' },
  { key: 'managementPlan', label: 'Management plan' },
  { key: 'screenshot', label: 'Pre-entry screenshot' },
]

export type SessionClock = Pick<MarketSession, 'state' | 'nowMinutesEt' | 'closeMinutesEt'>

export interface TicketInput {
  /** A CONTRACT_SPECS symbol, 'CUSTOM', or '' when none is chosen. */
  symbol: string
  /** Null when no instrument is chosen. CUSTOM supplies its own. */
  spec: SizingSpec | null
  /** The exact contract, e.g. ESZ6. Not asked for share instruments. */
  contract: string
  side: Side | null
  setupId: string
  model: ModelId | null
  sessionProfile: SessionProfileId | null
  alsoRequire: { candle23: boolean; cisd: boolean }
  answers: Partial<Record<AnsweredGateId, Answer>>
  narrative: Narrative
  entry: number | null
  stop: number | null
  targets: TicketTarget[]
  riskBudget: number | null
  costPerUnit: number | null
  slippageTicks: number | null
  minR: number
  /** The backend's session verdict and ET clock. Null when it did not answer. */
  clock: SessionClock | null
  /** The journal's record of this idea and today. Absent or null: not consulted. */
  journal?: JournalContext | null
  /** Today's daily plan. Absent or null: not consulted, and the plan gate waits. */
  plan?: PlanContext | null
}

export type GateStatus = 'PASS' | 'FAIL' | 'UNANSWERED' | 'UNMEASURABLE'

export interface GateResult {
  id: GateId
  code: BlockerCode
  title: string
  required: boolean
  source: 'TRADER' | 'COMPUTED'
  status: GateStatus
  detail: string
}

export interface Blocker { code: BlockerCode; reason: string }

export interface ScoreCategory { name: string; met: boolean }

export interface TicketResult {
  state: DecisionState
  gates: GateResult[]
  blockers: Blocker[]
  /** Why it is not approved yet: unanswered gates, missing fields, bad inputs. */
  waiting: string[]
  score: { value: number; of: 5; categories: ScoreCategory[] }
  sizing: SizingResult | null
}

/** Minutes past midnight from 'HH:MM'. */
export function minutesOf(hhmm: string): number {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm)
  if (!m) throw new Error(`not HH:MM: ${hhmm}`)
  return Number(m[1]) * 60 + Number(m[2])
}

function clockText(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
}

/**
 * The session gate, measured on the backend's ET clock.
 *
 * A window is the trader's; whether there is a session at all is the
 * calendar's. A weekend fails. A holiday cannot be measured here, because
 * futures keep their own holiday hours and this terminal's calendar is the
 * exchange's regular session. A window that falls after the day's published
 * close fails, which only happens on a half day: no profile window runs past
 * a regular close.
 */
export function sessionGate(profile: SessionProfileId | null, clock: SessionClock | null): { status: GateStatus; detail: string } {
  if (profile === null) return { status: 'UNANSWERED', detail: 'Choose a session profile.' }
  const p = SESSION_PROFILES[profile]
  if (clock === null) {
    return { status: 'UNMEASURABLE', detail: 'The backend did not answer, so the ET clock could not be read.' }
  }
  if (clock.state === 'UNKNOWN') {
    return { status: 'UNMEASURABLE', detail: 'The session calendar cannot say for this date.' }
  }
  const now = clock.nowMinutesEt
  if (now === null || !Number.isFinite(now)) {
    return { status: 'UNMEASURABLE', detail: 'The backend sent no ET clock.' }
  }
  if (clock.state === 'CLOSED_WEEKEND') {
    return { status: 'FAIL', detail: 'It is the weekend: there is no session to trade.' }
  }
  if (clock.state === 'CLOSED_HOLIDAY') {
    return { status: 'UNMEASURABLE', detail: 'Exchange holiday. Futures holiday hours are not in this terminal\'s calendar; check the exchange schedule.' }
  }
  const w = p.windows.find((x) => now >= minutesOf(x.from) && now < minutesOf(x.to))
  if (!w) {
    return { status: 'FAIL', detail: `${clockText(now)} ET is outside every ${p.label} window.` }
  }
  if (clock.closeMinutesEt !== null && now >= clock.closeMinutesEt) {
    return { status: 'FAIL', detail: `${clockText(now)} ET is after today's published close at ${clockText(clock.closeMinutesEt)} ET.` }
  }
  return { status: 'PASS', detail: `${clockText(now)} ET is inside ${p.label} ${w.name} ${w.from}–${w.to} ET.` }
}

const MONTH_CODES = 'FGHJKMNQUVXZ'

/**
 * The exact contract must belong to the chosen instrument: ESZ6 for ES, not
 * MESZ6 or NQZ6. This checks the format and the root only — not whether that
 * month is listed or is the front month.
 */
export function contractProblem(symbol: string, unit: 'contract' | 'share' | null, contract: string): string | null {
  const c = contract.trim().toUpperCase()
  if (unit === 'share') return null
  if (symbol === 'CUSTOM') return c === '' ? 'Enter the exact contract.' : null
  if (c === '') return `Enter the exact contract (e.g. ${symbol}Z6).`
  const m = new RegExp(`^${symbol}([${MONTH_CODES}])(\\d{1,2})$`).exec(c)
  if (!m) return `${c} does not match ${symbol}: expected ${symbol} + month code + year, e.g. ${symbol}Z6.`
  return null
}

function requiredGates(input: TicketInput): Set<AnsweredGateId> {
  const req = new Set<AnsweredGateId>([
    'traderState', 'dailyLock', 'firstAttempt',
    'htfAlignment', 'liquidityEvent', 'poiQuality',
    'displacement', 'retest', 'confirmation',
    'notMidrange', 'noDenial', 'opposingLiquidity',
  ])
  if (input.symbol !== '' && smtRequired(input.symbol)) req.add('smt')
  if (input.model) for (const g of MODELS[input.model].requires) req.add(g)
  if (input.alsoRequire.candle23) req.add('candle23')
  if (input.alsoRequire.cisd) req.add('cisd')
  return req
}

/** Gates shown on the ticket: the required ones, plus SMT where it is optional. */
export function visibleGates(input: TicketInput): { def: GateDef; required: boolean }[] {
  const req = requiredGates(input)
  return ANSWERED_GATES
    .filter((d) => req.has(d.id) || d.id === 'smt')
    .map((d) => {
      if (d.id !== 'liquidityEvent' || !input.model) return { def: d, required: req.has(d.id) }
      const m = MODELS[input.model]
      return { def: { ...d, pass: m.liquidityPass, fail: m.liquidityFail }, required: true }
    })
}

/**
 * What the gates themselves leave waiting: every required gate that is neither
 * PASS nor FAIL.
 *
 * This was written gate by gate — `UNMEASURABLE && id === 'session'` — so a
 * required COMPUTED gate other than the session window could read
 * UNMEASURABLE and add nothing here. Today every such case also leaves another
 * line waiting (a reward that cannot be measured has no target, and that is
 * listed), which is why it never approved; that was a coincidence of the
 * current gates, not a rule. The next measured gate would not have had it.
 * The rule is now total: a required gate that has not been decided waits.
 */
export function gateWaiting(gates: readonly GateResult[]): string[] {
  const out: string[] = []
  for (const g of gates) {
    if (!g.required || g.status === 'PASS' || g.status === 'FAIL') continue
    if (g.status === 'UNANSWERED') out.push(g.source === 'TRADER' ? `Answer: ${g.title}.` : g.detail)
    else out.push(`${g.title} cannot be measured: ${g.detail}`)
  }
  return out
}

export function evaluateTicket(input: TicketInput): TicketResult {
  const gates: GateResult[] = []
  const waiting: string[] = []

  for (const { def, required } of visibleGates(input)) {
    const a = input.answers[def.id]
    gates.push({
      id: def.id, code: def.code, title: def.title, required, source: 'TRADER',
      status: a ?? 'UNANSWERED',
      detail: a === 'PASS' ? def.pass : a === 'FAIL' ? def.fail : `Unanswered. Pass means: ${def.pass}`,
    })
  }

  // The journal and the plan can only turn these two gates to FAIL. When they
  // do, the gate is measured rather than answered, and the record says so.
  const j = input.journal
  if (j) {
    const first = gates.find((g) => g.id === 'firstAttempt')
    if (first && j.priorAttempts > 0) {
      Object.assign(first, {
        status: 'FAIL', source: 'COMPUTED',
        detail: `The journal in this browser holds ${j.priorAttempts} earlier attempt${j.priorAttempts === 1 ? '' : 's'} at this setup ID. A new idea needs a new higher-timeframe trigger.`,
      })
    }
  }
  const lockReasons = dailyLockReasons(j, input.plan)
  const lock = gates.find((g) => g.id === 'dailyLock')
  if (lock && lockReasons.length) {
    Object.assign(lock, { status: 'FAIL', source: 'COMPUTED', detail: lockReasons.join(' ') })
  }

  const s = sessionGate(input.sessionProfile, input.clock)
  gates.push({ id: 'session', code: 'SESSION_MODEL_MISSING', title: 'Session window', required: true, source: 'COMPUTED', ...s })

  // The plan's own gate, and the only gate the plan can pass.
  gates.push({ id: 'plan', code: 'PLAN_NOT_WRITTEN', title: 'Daily plan', required: true, source: 'COMPUTED', ...planGate(input.plan) })

  // Stand-aside windows the plan declares. This gate exists only to fail or
  // to wait: inside a window it fails, with the clock unknown it cannot be
  // measured, and outside every window it is not on the ticket at all — so it
  // never reads PASS, and the plan cannot answer anything by its absence.
  const p = input.plan
  if (p?.status === 'WRITTEN' && p.windows.length > 0) {
    const now = input.clock?.nowMinutesEt
    const list = p.windows.map((w) => `${w.name} ${clockText(w.start)}–${clockText(w.end)} ET`).join(', ')
    const base = { id: 'eventStandAside' as const, code: 'EVENT_STAND_ASIDE' as const, title: 'Event stand-aside', required: true, source: 'COMPUTED' as const }
    if (!input.clock || now === null || now === undefined || !Number.isFinite(now)) {
      gates.push({ ...base, status: 'UNMEASURABLE', detail: `The ET clock is unknown, so whether now is inside a stand-aside window (${list}) cannot be measured.` })
    } else {
      const inside = p.windows.filter((w) => windowContains(w, now))
      if (inside.length) {
        gates.push({
          ...base, status: 'FAIL',
          detail: `${clockText(now)} ET is inside the plan's stand-aside window for ${inside.map((w) => `${w.name} (${w.time} ET, ${clockText(w.start)}–${clockText(w.end)})`).join(' and ')}.`,
        })
      }
    }
  }

  // Sizing, when there is enough to size.
  let sizing: SizingResult | null = null
  if (input.spec && input.side && input.entry !== null && input.stop !== null) {
    sizing = sizePosition({
      spec: input.spec, side: input.side, entry: input.entry, stop: input.stop,
      targets: input.targets.map((t) => ({ price: t.price, share: t.share })),
      riskBudget: input.riskBudget, costPerUnit: input.costPerUnit, slippageTicks: input.slippageTicks,
      minR: Math.max(input.minR, STRICT_MIN_R),
    })
  }

  let reward: { status: GateStatus; detail: string }
  if (sizing?.verdict === 'MEETS_MIN_R') {
    reward = { status: 'PASS', detail: `Blended net R ${sizing.blendedNetR!.toFixed(2)} meets the ${Math.max(input.minR, STRICT_MIN_R)}R minimum.` }
  } else if (sizing?.verdict === 'BELOW_MIN_R') {
    reward = { status: 'FAIL', detail: `Blended net R ${sizing.blendedNetR!.toFixed(2)} is under the ${Math.max(input.minR, STRICT_MIN_R)}R minimum, after costs.` }
  } else {
    reward = { status: 'UNMEASURABLE', detail: 'Computed once the idea is sized against at least one target.' }
  }
  gates.push({ id: 'reward', code: 'REWARD_UNDER_2R', title: 'Net reward', required: true, source: 'COMPUTED', ...reward })

  // Fields that must be on the ticket before it can be approved.
  if (input.symbol === '' || !input.spec) waiting.push('Choose an instrument.')
  if (input.side === null) waiting.push('Choose a direction.')
  if (input.symbol !== '') {
    const p = contractProblem(input.symbol, input.spec?.unit ?? null, input.contract)
    if (p) waiting.push(p)
  }
  if (input.setupId.trim() === '') waiting.push('Enter a setup / idea ID.')
  if (input.model === null) waiting.push('Choose a model.')
  for (const f of NARRATIVE_FIELDS) {
    if (input.narrative[f.key].trim() === '') waiting.push(`Write the ${f.label.toLowerCase()}.`)
  }
  if (input.entry === null) waiting.push('Enter the entry.')
  if (input.stop === null) waiting.push('Enter the stop.')
  if (input.targets.length === 0) waiting.push('Enter at least one target.')
  input.targets.forEach((t, i) => {
    if (t.kind === null) waiting.push(`Say whether TP${i + 1} is internal or external liquidity.`)
  })
  if (!Number.isFinite(input.minR) || input.minR < STRICT_MIN_R) {
    waiting.push(`The strict minimum is ${STRICT_MIN_R}R. A lower minimum is a relaxed variant and is not offered here.`)
  }
  if (sizing && sizing.verdict !== 'NO_SIZE') {
    for (const e of sizing.errors) waiting.push(`Sizing: ${e}`)
  }

  waiting.push(...gateWaiting(gates))

  const fails = (pred: (g: GateResult) => boolean): Blocker[] =>
    gates.filter((g) => g.required && g.status === 'FAIL' && pred(g)).map((g) => ({ code: g.code, reason: g.detail }))

  const lockIds = new Set(ANSWERED_GATES.filter((d) => d.lock).map((d) => d.id as GateId))
  const lockBlockers = fails((g) => lockIds.has(g.id))
  const allBlockers = fails(() => true)

  const statusOf = (id: GateId) => gates.find((g) => g.id === id)?.status
  const met = (...ids: GateId[]) => ids.every((id) => statusOf(id) === 'PASS')
  const categories: ScoreCategory[] = [
    { name: 'HTF bias / POI', met: met('htfAlignment', 'poiQuality') },
    { name: 'SMT', met: met('smt') },
    { name: 'POI reaction (retest + closed confirmation)', met: met('retest', 'confirmation') },
    { name: 'Displacement + structure shift', met: met('displacement') },
    { name: 'Session timing', met: met('session') },
  ]
  const score = { value: categories.filter((c) => c.met).length, of: 5 as const, categories }

  let state: DecisionState
  let blockers: Blocker[] = []
  if (lockBlockers.length) {
    state = 'BLOCKED'
    blockers = allBlockers
  } else if (input.side === null) {
    state = 'NEUTRAL'
  } else if (allBlockers.length) {
    state = 'BLOCKED'
    blockers = allBlockers
  } else if (sizing?.verdict === 'NO_SIZE') {
    state = 'NO_TRADE'
    waiting.unshift(...sizing.errors)
  } else if (waiting.length) {
    state = 'WAIT_FOR_TRIGGER'
  } else {
    state = 'APPROVED_TRADE'
  }

  return { state, gates, blockers, waiting, score, sizing }
}

export const TICKET_SCHEMA = 'quantflow.ticket/v1' as const

export type TicketRecord = ReturnType<typeof ticketRecord>

/**
 * The ticket as a record: what was decided, on what, and why. It is written
 * for a journal, not sent anywhere, and it says so in `note`.
 */
export function ticketRecord(input: TicketInput, result: TicketResult, createdAt: string, specStatus: string) {
  const s = result.sizing
  return {
    schema: TICKET_SCHEMA,
    createdAt,
    note: 'A ticket records a decision. It places no order. TRADER gates are the trader\'s own observations.',
    state: result.state,
    symbol: input.symbol,
    contract: input.contract.trim().toUpperCase() || null,
    specStatus,
    setupId: input.setupId.trim(),
    direction: input.side,
    model: input.model,
    sessionProfile: input.sessionProfile,
    alsoRequire: input.alsoRequire,
    sessionClock: input.clock ? { state: input.clock.state, nowMinutesEt: input.clock.nowMinutesEt } : null,
    gates: result.gates.map((g) => ({ id: g.id, code: g.code, status: g.status, required: g.required, source: g.source })),
    blockers: result.blockers,
    waiting: result.waiting,
    score: { value: result.score.value, of: result.score.of, rankingOnly: true },
    plan: {
      entry: input.entry,
      stop: input.stop,
      stopPoints: s && s.verdict !== 'INVALID' ? +s.stopPoints.toFixed(6) : null,
      stopTicks: s && s.verdict !== 'INVALID' ? s.stopTicks : null,
      lossPerUnit: s && s.verdict !== 'INVALID' ? s.lossPerUnit : null,
      units: s ? s.units : null,
      plannedRisk: s ? s.plannedRisk : null,
      blendedNetR: s ? s.blendedNetR : null,
      riskBudget: input.riskBudget,
      costPerUnit: input.costPerUnit,
      slippageTicks: input.slippageTicks,
      minR: Math.max(input.minR, STRICT_MIN_R),
      targets: input.targets.map((t, i) => ({
        price: t.price,
        kind: t.kind,
        share: s?.targets[i]?.share ?? t.share ?? null,
        units: s?.targets[i]?.units ?? null,
        netR: s?.targets[i]?.netR ?? null,
      })),
    },
    narrative: input.narrative,
  }
}
