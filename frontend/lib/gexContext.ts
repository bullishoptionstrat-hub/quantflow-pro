/**
 * GEX reference levels for the ticket — context, never a gate.
 *
 * Everything here is read from `GET /api/gex` for an instrument's **own**
 * chain and nothing else: SPY reads SPY's, QQQ reads QQQ's. Nothing here is
 * passed to `evaluateTicket`, and a test holds the ticket's verdict identical
 * with and without it. These are levels to look at, not answers to a gate.
 *
 * Definitions, named in the UI exactly as written here. No vendor's brand
 * term is used for any of them: "Max call OI strike" says what was computed,
 * where a brand name would claim a method nobody here has checked.
 *
 *  - **Max call OI strike** — the strike with the largest call open interest
 *    in the chain, all expiries together, with that open interest.
 *  - **Max put OI strike** — the same, put side.
 *  - **Same-day (0DTE) max call / put OI strike** — the same rule over the
 *    backend's same-day lens: contracts expiring on the chain's own trading
 *    date. When the backend sends `zeroDte: null` the chain has no same-day
 *    expiry, which is the ordinary answer for most symbols, and that is what
 *    is shown. The nearest expiry is never put in its place: that would
 *    relabel tomorrow as today.
 *  - **Net GEX sign (modelled)** — the sign of the backend's `totalGex`:
 *    POSITIVE, NEGATIVE, ZERO, or UNKNOWN when it sent none. It is the sign of
 *    a sum computed under a stated dealer-positioning assumption (dealers long
 *    the calls and short the puts in open interest). Open interest does not
 *    say who holds which side, so it is a modelled sign and not a fact about
 *    the market's regime.
 *  - **Distance** — `strike − spot` in dollars and as a percentage of spot,
 *    where spot is the price the same chain carried (`/api/gex` `spot`). With
 *    no spot from the chain there is no distance: no other price is borrowed.
 *
 * Open interest as published per strike by `/api/gex` counts only contracts
 * that carried both open interest and a non-zero gamma — the GEX
 * aggregation's own filter. A contract Cboe sent with zero gamma is not in it.
 *
 * **Tie rule.** Equal open interest goes to the strike nearest the chain's
 * spot; still tied (equidistant), or no spot to measure from, the lower
 * strike.
 *
 * **Missing open interest.** A strike whose open interest is not a finite
 * number is skipped, never read as zero. A side with no positive open
 * interest anywhere has no level, and says so.
 */
import type { GEXLevel, GEXResponse } from './types'

/** Futures whose reference index has a chain, but no measured basis to map it. */
const FUTURES_INDEX: Record<string, 'SPX' | 'NDX'> = { ES: 'SPX', MES: 'SPX', NQ: 'NDX', MNQ: 'NDX' }

/** Instruments whose own chain `/api/gex` serves. */
const OWN_CHAIN: Record<string, 'SPY' | 'QQQ'> = { SPY: 'SPY', QQQ: 'QQQ' }

export const FUTURES_UNMEASURABLE =
  'SPX/NDX levels need a measured basis to map onto futures; none is available.'

export type GexChainChoice =
  /** No instrument chosen. */
  | { kind: 'NONE' }
  /** The instrument's own chain. */
  | { kind: 'CHAIN'; chain: 'SPY' | 'QQQ' }
  /** A chain exists for the index, and mapping it here would be a guess. */
  | { kind: 'UNMEASURABLE'; index: 'SPX' | 'NDX'; reason: string }
  /** No option chain is read for this instrument at all. */
  | { kind: 'NOT_APPLICABLE'; reason: string }

/**
 * Which chain, if any, belongs to an instrument.
 *
 * ES is not SPX times a constant: the basis between them moves with rates,
 * dividends and time to the future's expiry, and nothing here measures it. So
 * a future on an index is UNMEASURABLE rather than given the index's strikes
 * shifted by a guess.
 */
export function gexChainFor(symbol: string): GexChainChoice {
  if (symbol === '') return { kind: 'NONE' }
  const own = OWN_CHAIN[symbol]
  if (own) return { kind: 'CHAIN', chain: own }
  const index = FUTURES_INDEX[symbol]
  if (index) return { kind: 'UNMEASURABLE', index, reason: FUTURES_UNMEASURABLE }
  if (symbol === 'CUSTOM') {
    return { kind: 'NOT_APPLICABLE', reason: 'A custom instrument has no option chain to read.' }
  }
  return { kind: 'NOT_APPLICABLE', reason: `This terminal reads no option chain for ${symbol}.` }
}

export interface Distance {
  /** strike − spot */
  dollars: number
  /** (strike − spot) / spot × 100 */
  pct: number
}

export interface OiStrike {
  strike: number
  oi: number
  /** From the chain's own spot; `null` when the chain carried none. */
  distance: Distance | null
}

export type ZeroDteContext =
  | { status: 'PRESENT'; expiry: string; contractCount: number | null; maxCallOi: OiStrike | null; maxPutOi: OiStrike | null }
  /** The backend said `zeroDte: null`: the chain has no same-day expiry. */
  | { status: 'NONE' }
  /** The backend did not send the lens at all. */
  | { status: 'UNPUBLISHED' }

export type GexSign = 'POSITIVE' | 'NEGATIVE' | 'ZERO' | 'UNKNOWN'

export interface GexContext {
  symbol: string
  /** A real chain with levels. When false, every level below is null. */
  available: boolean
  unavailableReason: string | null
  source: string | null
  /** The delay the backend publishes for this chain. */
  delayedMinutes: number | null
  /** The chain's own as-of, epoch ms, or null when unknown. */
  asOfMs: number | null
  asOfVendor: string | null
  spot: number | null
  spotField: string | null
  rights: { datasetId: string; display: string; mode: string } | null
  maxCallOi: OiStrike | null
  maxPutOi: OiStrike | null
  zeroDte: ZeroDteContext
  netGex: { sign: GexSign; total: number | null }
  /** The backend's own statement of the dealer-positioning assumption. */
  assumption: string | null
}

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n)

/** The chain's spot, or null. Zero and negatives are not prices. */
function spotOf(r: GEXResponse): number | null {
  return finite(r.spot) && r.spot > 0 ? r.spot : null
}

function distanceOf(strike: number, spot: number | null): Distance | null {
  if (spot === null) return null
  return { dollars: strike - spot, pct: ((strike - spot) / spot) * 100 }
}

/** On equal open interest, does strike `a` win over strike `b`? */
function winsTie(a: number, b: number, spot: number | null): boolean {
  if (spot !== null) {
    const da = Math.abs(a - spot)
    const db = Math.abs(b - spot)
    if (da !== db) return da < db
  }
  return a < b
}

/** The strike with the largest open interest on one side, by the stated rules. */
export function maxOiStrike(levels: readonly GEXLevel[], side: 'call' | 'put', spot: number | null): OiStrike | null {
  let best: { strike: number; oi: number } | null = null
  for (const l of levels) {
    const oi = side === 'call' ? l.callOI : l.putOI
    if (!finite(oi) || oi <= 0 || !finite(l.strike)) continue
    if (best === null || oi > best.oi || (oi === best.oi && winsTie(l.strike, best.strike, spot))) {
      best = { strike: l.strike, oi }
    }
  }
  return best && { ...best, distance: distanceOf(best.strike, spot) }
}

export function netGexSign(total: unknown): GexSign {
  if (!finite(total)) return 'UNKNOWN'
  return total > 0 ? 'POSITIVE' : total < 0 ? 'NEGATIVE' : 'ZERO'
}

function zeroDteOf(r: GEXResponse, spot: number | null): ZeroDteContext {
  if (r.zeroDte === undefined) return { status: 'UNPUBLISHED' }
  if (r.zeroDte === null) return { status: 'NONE' }
  const z = r.zeroDte
  const levels = Array.isArray(z.levels) ? z.levels : []
  return {
    status: 'PRESENT',
    expiry: z.expiry,
    contractCount: finite(z.contractCount) ? z.contractCount : null,
    maxCallOi: maxOiStrike(levels, 'call', spot),
    maxPutOi: maxOiStrike(levels, 'put', spot),
  }
}

export function gexContext(r: GEXResponse): GexContext {
  const levels = Array.isArray(r.levels) ? r.levels : []
  const available = r.realData === true && levels.length > 0
  const spot = available ? spotOf(r) : null
  const asOfMs = available && typeof r.asOf === 'string' ? Date.parse(r.asOf) : NaN
  return {
    symbol: r.symbol,
    available,
    unavailableReason: available ? null : (r.unavailableReason ?? 'The backend has no chain for this symbol.'),
    source: available ? r.source : null,
    delayedMinutes: available && finite(r.delayedMinutes) ? r.delayedMinutes : null,
    asOfMs: Number.isFinite(asOfMs) ? asOfMs : null,
    asOfVendor: available ? (r.asOfVendor ?? null) : null,
    spot,
    spotField: available ? (r.spotField ?? null) : null,
    rights: available ? (r.rights ?? null) : null,
    maxCallOi: available ? maxOiStrike(levels, 'call', spot) : null,
    maxPutOi: available ? maxOiStrike(levels, 'put', spot) : null,
    zeroDte: available ? zeroDteOf(r, spot) : { status: 'UNPUBLISHED' },
    netGex: available
      ? { sign: netGexSign(r.keyLevels?.totalGex), total: finite(r.keyLevels?.totalGex) ? r.keyLevels.totalGex : null }
      : { sign: 'UNKNOWN', total: null },
    assumption: r.assumptions?.dealerPositioning ?? null,
  }
}

const ET_PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
})

/** `YYYY-MM-DD HH:MM:SS ET` for an instant. */
export function etDateTime(ms: number): string {
  const p = Object.fromEntries(ET_PARTS.formatToParts(new Date(ms)).map((x) => [x.type, x.value]))
  const hour = String(Number(p.hour) % 24).padStart(2, '0')
  return `${p.year}-${p.month}-${p.day} ${hour}:${p.minute}:${p.second} ET`
}

/**
 * How old the chain's as-of is on this browser's clock. A stamp ahead of the
 * clock is said to be ahead, not shown as a negative age.
 */
export function ageText(asOfMs: number, nowMs: number): string {
  const ms = nowMs - asOfMs
  if (ms < 0) return "ahead of this browser's clock"
  const min = Math.floor(ms / 60_000)
  if (min < 1) return 'under 1 min old'
  if (min < 60) return `${min} min old`
  const h = Math.floor(min / 60)
  if (h < 48) return `${h} h ${String(min % 60).padStart(2, '0')} min old`
  return `${Math.floor(h / 24)} d ${h % 24} h old`
}

/** `+$12.30 (+1.62%)` — signed, from the chain's own spot. */
export function distanceText(d: Distance): string {
  const sign = (n: number) => (n > 0 ? '+' : n < 0 ? '−' : '')
  const abs = Math.abs(d.dollars).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return `${sign(d.dollars)}$${abs} (${sign(d.pct)}${Math.abs(d.pct).toFixed(2)}%) from spot`
}
