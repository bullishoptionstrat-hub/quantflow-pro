import { specFor } from '@/lib/contractSpecs'
import type { Side } from '@/lib/riskSize'
import type { TicketInput } from '@/lib/tradeTicket'

/**
 * A replay idea carried to the trade ticket.
 *
 * The setup engine names an idea by its content hash, and that hash is reused
 * as the ticket's setup ID, so the journal's one-attempt rule (`firstAttempt`)
 * applies to engine ideas exactly as it does to typed ones.
 *
 * The link is **tighten-only**. It fills fields the trader could have typed —
 * instrument, direction, setup ID, entry, stop, one target price — and only
 * where the ticket is still empty. It answers no gate, picks no model, writes
 * no narrative, says nothing about whether the target is internal or external
 * liquidity, and supplies no budget, cost or slippage. So a ticket opened from
 * an idea evaluates exactly like the same ticket typed by hand: it can wait,
 * block or size, but it cannot pass a gate the trader has not passed.
 *
 * Only an idea that reached ACTIONABLE, with a finite entry, invalidation and
 * target on the right sides of each other, is linkable. Its prices come from
 * imported history, not a live quote, and the ticket says so.
 */

export const IDEA_LINK_VERSION = '1' as const

export interface ReplayIdeaLike {
  ideaId: string
  setup: string
  side: string
  symbol: string
  entry?: number | null
  invalidation?: number | null
  target?: number | null
  history: { state: string; knownAt: number }[]
}

export interface IdeaPrefill {
  ideaId: string
  setup: string
  side: Side
  /** The idea's symbol when it is a contract-spec preset; '' otherwise. */
  symbol: string
  /** The symbol the replay ran on, kept for the note even when not a preset. */
  replaySymbol: string
  entry: number
  stop: number
  target: number
  /** When the idea became ACTIONABLE, on the imported bars' clock. */
  actionableAt: number
  setupMethodVersion: string
}

const HASH = /^[0-9a-f]{64}$/
const SYMBOL = /^[A-Z0-9.]{1,10}$/
const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** Why the geometry is unusable, or null when it is a well-formed trade. */
export function geometryProblem(side: Side, entry: number, stop: number, target: number): string | null {
  if (side === 'LONG' && !(stop < entry && entry < target)) return 'A LONG idea needs stop < entry < target.'
  if (side === 'SHORT' && !(target < entry && entry < stop)) return 'A SHORT idea needs target < entry < stop.'
  return null
}

/** The prefill for an idea, or the reason it cannot be linked. */
export function ideaPrefill(idea: ReplayIdeaLike, setupMethodVersion: string): IdeaPrefill | { reason: string } {
  if (!HASH.test(idea.ideaId)) return { reason: 'The idea has no content-hash ID.' }
  const actionable = idea.history.find((t) => t.state === 'ACTIONABLE')
  if (!actionable) return { reason: 'Only an idea that reached ACTIONABLE can open a ticket.' }
  if (idea.side !== 'LONG' && idea.side !== 'SHORT') return { reason: 'The idea has no direction.' }
  const { entry, invalidation, target } = idea
  if (!fin(entry) || !fin(invalidation) || !fin(target)) return { reason: 'The idea is missing its entry, invalidation or target.' }
  const g = geometryProblem(idea.side, entry, invalidation, target)
  if (g) return { reason: g }
  const sym = idea.symbol.trim().toUpperCase()
  if (!SYMBOL.test(sym)) return { reason: 'The idea has no readable symbol.' }
  return {
    ideaId: idea.ideaId, setup: idea.setup, side: idea.side,
    symbol: specFor(sym) ? sym : '', replaySymbol: sym,
    entry, stop: invalidation, target,
    actionableAt: actionable.knownAt, setupMethodVersion,
  }
}

/** The ticket URL query for a prefill. */
export function ideaLinkQuery(p: IdeaPrefill): string {
  const q = new URLSearchParams({
    idea: IDEA_LINK_VERSION, ideaId: p.ideaId, setup: p.setup, side: p.side, symbol: p.replaySymbol,
    entry: String(p.entry), stop: String(p.stop), target: String(p.target),
    at: String(p.actionableAt), method: p.setupMethodVersion,
  })
  return `/ticket?${q.toString()}`
}

/**
 * Read a prefill back off the ticket's URL. Null when no idea link is present;
 * an error when one is present and anything in it fails the same checks the
 * link was built with — a hand-edited URL is refused, not half-applied.
 */
export function parseIdeaLink(search: URLSearchParams): IdeaPrefill | { error: string } | null {
  if (!search.has('idea')) return null
  if (search.get('idea') !== IDEA_LINK_VERSION) return { error: `Unknown idea link version ${search.get('idea')}.` }
  const num = (k: string): number | null => {
    const v = search.get(k)
    if (v === null || v.trim() === '') return null
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  const at = num('at')
  const p = ideaPrefill({
    ideaId: search.get('ideaId') ?? '',
    setup: search.get('setup') ?? '',
    side: search.get('side') ?? '',
    symbol: search.get('symbol') ?? '',
    entry: num('entry'), invalidation: num('stop'), target: num('target'),
    history: at === null ? [] : [{ state: 'ACTIONABLE', knownAt: at }],
  }, search.get('method') ?? '')
  if ('reason' in p) return { error: `Idea link refused: ${p.reason}` }
  if (p.setup.trim() === '' || p.setupMethodVersion.trim() === '') return { error: 'Idea link refused: it does not name its setup and method version.' }
  return p
}

/** Ticket fields the link may touch. Everything else is the trader's alone. */
export type PrefillableField = 'symbol' | 'side' | 'setupId' | 'entry' | 'stop' | 'targets'

/**
 * Apply a prefill to a ticket input, filling only fields that are still empty.
 * The page uses the same rule on its string state; this is the form the
 * tighten-only invariant is tested against.
 */
export function withIdeaPrefill(input: TicketInput, p: IdeaPrefill): TicketInput {
  const preset = p.symbol === '' ? undefined : specFor(p.symbol)
  const takeSymbol = input.symbol === '' && preset !== undefined
  return {
    ...input,
    symbol: takeSymbol ? p.symbol : input.symbol,
    spec: takeSymbol ? { tickSize: preset!.tickSize, tickValue: preset!.tickValue, unit: preset!.unit, micro: preset!.micro } : input.spec,
    side: input.side ?? p.side,
    setupId: input.setupId.trim() === '' ? p.ideaId : input.setupId,
    entry: input.entry ?? p.entry,
    stop: input.stop ?? p.stop,
    // Kind stays null: whether the target is internal or external liquidity is
    // the trader's call, and the ticket waits for it.
    targets: input.targets.length ? input.targets : [{ price: p.target, kind: null }],
  }
}

/** One line for the ticket saying where the prefilled numbers came from. */
export function prefillNote(p: IdeaPrefill): string {
  const when = new Date(p.actionableAt).toISOString().replace('T', ' ').slice(0, 16)
  const sym = p.symbol === '' ? ` ${p.replaySymbol} is not a preset, so choose the instrument.` : ''
  return `Prefilled from replay idea ${p.ideaId.slice(0, 12)}… (${p.setup} ${p.side}, ACTIONABLE ${when} UTC on imported bars, ${p.setupMethodVersion}). These prices are history, not a live quote. No gate is answered by the engine.${sym}`
}
