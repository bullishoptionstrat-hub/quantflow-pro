/**
 * CONTRACT LIFECYCLE — when does THIS contract stop trading, and how does it
 * settle?
 *
 * A symbol root does not determine this forever, and the root alone is not
 * even enough today. Standard SPX options are AM-settled: they settle on the
 * expiration date from opening prices, so they stop trading the BUSINESS DAY
 * BEFORE. SPXW options are PM-settled and trade on their expiration day. A
 * universal "expires at 16:00 on the listed date" is wrong for the first by a
 * whole session, and it is exactly what `expiryInstantMs` still assumes for
 * scoring — the gap this registry exists to close, recorded in
 * docs/CONTRACT_LIFECYCLE_MODEL.md rather than papered over here.
 *
 * The rules are effective-dated because the product set moves under them: Cboe
 * has announced SPXO, AM-settled weeklies, from 2026-11-09 (subject to
 * regulatory review). A contract is governed by the rule in force on its
 * expiration date, and a root with no rule in force is UNKNOWN — not a
 * fabricated 16:00 expiry.
 *
 * Every rule is UNVERIFIED or SEARCH_ONLY: the Cboe and OCC product
 * specifications were refused by this environment's egress policy on
 * 2026-09-27. Where a fact is contested or simply unknown (does an expiring
 * SPY option stop at 16:00 or 16:15? does SPX close at 13:00 or 13:15 on a half
 * day?) the rule records the date it is sure of and leaves the TIME null, so a
 * caller gets `DATE_ONLY` rather than a precise-looking instant nobody read.
 */
import { sessionOn } from '../flow-engine/calendar';
import { addDays, instantEt, marketDateOf } from './civil';
import { productSessionAt } from './productSessions';
import type { ProductSessionState } from './productSessions';
import type { SourceStatus } from '../events/semantics';

export type SettlementStyle = 'AM' | 'PM' | 'PHYSICAL' | 'UNKNOWN';

export interface LastTradingRule {
  day: 'EXPIRATION_DAY' | 'PRECEDING_BUSINESS_DAY' | 'UNKNOWN';
  /** Wall-clock ET on that day, or null when it is not established. */
  time: { hour: number; minute: number } | null;
}

export interface ContractLifecycleRule {
  productFamily: string;
  roots: readonly string[];
  settlementStyle: SettlementStyle;
  expirationRule: string;
  lastTradingRule: LastTradingRule;
  settlementReference: 'OPENING_PRICES' | 'CLOSING_VALUE' | 'PHYSICAL_DELIVERY' | 'UNKNOWN';
  effectiveFrom: string;
  effectiveTo?: string;
  status: SourceStatus;
  source: string;
  sourceReadAt: string | null;
  note: string;
}

export const CONTRACT_LIFECYCLE_RULES: readonly ContractLifecycleRule[] = [
  {
    productFamily: 'SPX standard (AM-settled)',
    roots: ['SPX'],
    settlementStyle: 'AM',
    expirationRule: 'monthly, third Friday; a holiday on that day moves the expiration earlier',
    lastTradingRule: { day: 'PRECEDING_BUSINESS_DAY', time: { hour: 16, minute: 15 } },
    settlementReference: 'OPENING_PRICES',
    effectiveFrom: '2026-01-01',
    status: 'UNVERIFIED',
    source: 'Cboe SPX product specification, as summarised by the operator audit of 2026-09-27',
    sourceReadAt: null,
    note:
      'AM settlement from opening prices on the expiration date, so trading ends the business day ' +
      'before, at that day\'s regular close. Not read: cboe.com refused by the egress policy.',
  },
  {
    productFamily: 'SPXW (PM-settled)',
    roots: ['SPXW'],
    settlementStyle: 'PM',
    expirationRule: 'every listed expiration date',
    lastTradingRule: { day: 'EXPIRATION_DAY', time: { hour: 16, minute: 0 } },
    settlementReference: 'CLOSING_VALUE',
    effectiveFrom: '2026-01-01',
    status: 'UNVERIFIED',
    source: 'general knowledge of Cboe SPXW rules; nothing read',
    sourceReadAt: null,
    note:
      'Expiring series recalled as closing at 16:00 ET while other SPXW series trade to 16:15. ' +
      'Recalled, not read.',
  },
  {
    productFamily: 'SPXO (AM-settled weeklies)',
    roots: ['SPXO'],
    settlementStyle: 'AM',
    expirationRule: 'weekly; first listed expirations reported as 2026-11-18 and 2026-12-16',
    lastTradingRule: { day: 'PRECEDING_BUSINESS_DAY', time: null },
    settlementReference: 'UNKNOWN',
    effectiveFrom: '2026-11-09',
    status: 'SEARCH_ONLY',
    source: 'Cboe SPXO announcement, surfaced by search 2026-09-27',
    sourceReadAt: null,
    note:
      'Effective 2026-11-09 subject to regulatory review. AM settlement implies trading ends the ' +
      'business day before; the time and the settlement reference were not established.',
  },
  {
    productFamily: 'SPY ETF options (physically settled)',
    roots: ['SPY'],
    settlementStyle: 'PHYSICAL',
    expirationRule: 'every listed expiration date',
    lastTradingRule: { day: 'EXPIRATION_DAY', time: null },
    settlementReference: 'PHYSICAL_DELIVERY',
    effectiveFrom: '2026-01-01',
    status: 'UNVERIFIED',
    source: 'general knowledge; conflicting search results on the expiration-day close (2026-09-27)',
    sourceReadAt: null,
    note: 'Sources conflict on 16:00 vs 16:15 for expiring series, so the time is not recorded.',
  },
  {
    productFamily: 'XSP mini-SPX index options',
    roots: ['XSP'],
    settlementStyle: 'UNKNOWN',
    expirationRule: 'not established',
    lastTradingRule: { day: 'UNKNOWN', time: null },
    settlementReference: 'UNKNOWN',
    effectiveFrom: '2026-01-01',
    status: 'UNVERIFIED',
    source: 'nothing read',
    sourceReadAt: null,
    note: 'Registered so that XSP answers UNKNOWN by rule rather than by omission.',
  },
];

export type LifecycleState =
  /** Last trading date and time both established. */
  | 'KNOWN'
  /** The date is established; the time on it is not. */
  | 'DATE_ONLY'
  | 'UNKNOWN';

export interface ContractLifecycle {
  root: string;
  expiry: string;
  state: LifecycleState;
  rule: ContractLifecycleRule | null;
  settlementStyle: SettlementStyle;
  lastTradingDate: string | null;
  lastTradingInstantMs: number | null;
  status: SourceStatus;
  reasons: string[];
}

export function lifecycleRuleFor(root: string, expiry: string): ContractLifecycleRule | null {
  return CONTRACT_LIFECYCLE_RULES.find((r) =>
    r.roots.includes(root) && r.effectiveFrom <= expiry &&
    (r.effectiveTo === undefined || expiry <= r.effectiveTo)) ?? null;
}

/** The last session day strictly before `date`, or null when the calendar cannot say. */
function precedingBusinessDay(date: string): { date: string | null; why?: string } {
  let d: string | null = date;
  for (let i = 0; i < 10; i++) {
    d = d === null ? null : addDays(d, -1);
    if (d === null) return { date: null, why: 'date arithmetic failed' };
    const s = sessionOn(d);
    if (s.kind === 'UNKNOWN') return { date: null, why: s.basis };
    if (s.kind === 'REGULAR' || s.kind === 'EARLY_CLOSE') return { date: d };
  }
  return { date: null, why: 'no session day within ten days before the expiration' };
}

export function contractLifecycle(root: string, expiry: string): ContractLifecycle {
  const unknown = (reasons: string[], rule: ContractLifecycleRule | null = null): ContractLifecycle => ({
    root, expiry, state: 'UNKNOWN', rule, settlementStyle: rule?.settlementStyle ?? 'UNKNOWN',
    lastTradingDate: null, lastTradingInstantMs: null, status: 'UNVERIFIED', reasons,
  });
  if (addDays(expiry, 0) === null) return unknown([`expiry "${expiry}" is not an ISO calendar date`]);

  const rule = lifecycleRuleFor(root, expiry);
  if (rule === null) return unknown([`no lifecycle rule is in force for ${root} on ${expiry}`]);
  if (rule.lastTradingRule.day === 'UNKNOWN') return unknown([`${rule.productFamily}: ${rule.note}`], rule);

  const s = sessionOn(expiry);
  if (s.kind === 'UNKNOWN') return unknown([s.basis], rule);
  if (s.kind === 'WEEKEND' || s.kind === 'HOLIDAY') {
    // A shifted expiration is listed on the shifted date. A contract "expiring"
    // on a closed day is a vendor artifact, and choosing which neighbouring day
    // it meant is a guess.
    return unknown([`${s.basis}; no contract settles on a day without a session`], rule);
  }

  let lastTradingDate: string;
  if (rule.lastTradingRule.day === 'EXPIRATION_DAY') {
    lastTradingDate = expiry;
  } else {
    const p = precedingBusinessDay(expiry);
    if (p.date === null) return unknown([`preceding business day: ${p.why}`], rule);
    lastTradingDate = p.date;
  }

  const reasons = [`${rule.productFamily}: last trading day is the ${
    rule.lastTradingRule.day === 'EXPIRATION_DAY' ? 'expiration day' : 'business day before expiration'}`];
  const t = rule.lastTradingRule.time;
  const lastDay = sessionOn(lastTradingDate);
  if (t === null) {
    reasons.push(`${rule.productFamily}: the time on that day is not established`);
  } else if (lastDay.kind === 'EARLY_CLOSE') {
    reasons.push(`${lastTradingDate} is an early-close day; ${rule.productFamily}'s close on it is not established`);
  }
  const instant = t !== null && lastDay.kind === 'REGULAR' ? instantEt(lastTradingDate, t.hour, t.minute) : null;

  return {
    root, expiry, rule, settlementStyle: rule.settlementStyle,
    state: instant === null ? 'DATE_ONLY' : 'KNOWN',
    lastTradingDate,
    lastTradingInstantMs: instant,
    status: rule.status,
    reasons,
  };
}

/**
 * May this contract trade at this instant? Product session first, contract
 * lifecycle over it: a contract past its last trading moment is
 * LAST_TRADING_DAY_ENDED whatever the product's session is doing.
 */
export function contractSessionAt(root: string, expiry: string, atMs: number): {
  state: ProductSessionState;
  basis: string;
} {
  const life = contractLifecycle(root, expiry);
  if (life.state === 'UNKNOWN' || life.lastTradingDate === null) {
    return { state: 'UNKNOWN', basis: life.reasons.join('; ') };
  }
  const date = marketDateOf(atMs);
  if (date === null) return { state: 'UNKNOWN', basis: 'the instant could not be read in the market timezone' };
  if (date > life.lastTradingDate) {
    return { state: 'LAST_TRADING_DAY_ENDED', basis: `last trading day was ${life.lastTradingDate}` };
  }
  if (date === life.lastTradingDate) {
    if (life.lastTradingInstantMs !== null && atMs >= life.lastTradingInstantMs) {
      return { state: 'LAST_TRADING_DAY_ENDED', basis: life.reasons.join('; ') };
    }
    if (life.lastTradingInstantMs === null) {
      // The day is known and the minute is not: inside the exchange's own
      // regular hours the contract certainly still trades; after them nothing
      // here can say whether it does.
      const product = productSessionAt(root, atMs);
      if (product.state === 'OPEN' && product.sessionClass === 'REGULAR') {
        const s = sessionOn(date);
        const close = s.closeHour !== null && s.closeMinute !== null ? instantEt(date, s.closeHour, s.closeMinute) : null;
        if (close !== null && atMs < close) return { state: 'OPEN', basis: product.basis };
      }
      return { state: 'UNKNOWN', basis: life.reasons.join('; ') };
    }
  }
  const product = productSessionAt(root, atMs);
  return { state: product.state, basis: product.basis };
}
