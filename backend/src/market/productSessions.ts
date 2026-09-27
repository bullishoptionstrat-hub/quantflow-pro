/**
 * PRODUCT SESSION REGISTRY — may this product trade right now, and in which
 * session?
 *
 * The exchange calendar says whether the exchange holds a session on a date.
 * It cannot say that SPX options trade at 21:00 ET (their global session)
 * while SPY options do not, or that SPX keeps trading after the equity close.
 * Those are product facts, effective-dated, and they live here.
 *
 * **Every window below is UNVERIFIED or SEARCH_ONLY.** The Cboe product pages
 * were refused by this environment's egress policy on 2026-09-27; the SPX
 * schedule is the operator audit's quotation of them and the SPXO rollout is a
 * search result. A rule records what it knows and marks the rest unknown:
 * `outsideWindows: 'UNKNOWN'` means "we have not established this product's
 * extended sessions", and a time outside its known windows answers UNKNOWN —
 * never CLOSED, which would be a claim, and never OPEN, which would be a worse
 * one.
 *
 * On early-close days no product's close is established (does SPX stop at
 * 13:00 or 13:15?), so only the exchange's own hours answer OPEN and the rest
 * of the day is UNKNOWN.
 *
 * Contract-level questions — has THIS series stopped trading because its last
 * trading day ended? — are `contractLifecycle.ts`, which reads this.
 */
import { sessionOn } from '../flow-engine/calendar';
import { addDays, hhmm, marketDateOf, minutesEt } from './civil';
import type { SourceStatus } from '../events/semantics';

export type TradingSessionClass = 'REGULAR' | 'EXTENDED' | 'CURB' | 'GLOBAL' | 'UNKNOWN';
export type ProductSessionState = 'OPEN' | 'CLOSED' | 'LAST_TRADING_DAY_ENDED' | 'UNKNOWN';

export interface SessionWindow {
  sessionClass: Exclude<TradingSessionClass, 'UNKNOWN'>;
  startMinutesEt: number;
  endMinutesEt: number;
  /**
   * The window runs on the calendar evening BEFORE the trade date it belongs
   * to — a global session that opens at 20:15 the night before.
   */
  previousEvening?: boolean;
}

export interface ProductSessionRule {
  productFamily: string;
  roots: readonly string[];
  effectiveFrom: string;
  effectiveTo?: string;
  windows: readonly SessionWindow[];
  /** What a session-day minute outside every window means for this product. */
  outsideWindows: 'CLOSED' | 'UNKNOWN';
  status: SourceStatus;
  source: string;
  readAt: string | null;
  note: string;
}

const SPX_WINDOWS: readonly SessionWindow[] = [
  { sessionClass: 'GLOBAL', startMinutesEt: 20 * 60 + 15, endMinutesEt: 24 * 60, previousEvening: true },
  { sessionClass: 'GLOBAL', startMinutesEt: 0, endMinutesEt: 9 * 60 + 25 },
  { sessionClass: 'REGULAR', startMinutesEt: 9 * 60 + 30, endMinutesEt: 16 * 60 + 15 },
  { sessionClass: 'CURB', startMinutesEt: 16 * 60 + 15, endMinutesEt: 17 * 60 },
];

export const PRODUCT_SESSION_RULES: readonly ProductSessionRule[] = [
  {
    productFamily: 'SPX index options (AM monthly SPX, PM SPXW)',
    roots: ['SPX', 'SPXW'],
    effectiveFrom: '2026-01-01',
    windows: SPX_WINDOWS,
    outsideWindows: 'CLOSED',
    status: 'UNVERIFIED',
    source: 'Cboe SPX product schedule, as quoted by the operator audit of 2026-09-27',
    readAt: null,
    note:
      'Regular 09:30–16:15, curb 16:15–17:00, global 20:15 (prior evening)–09:25. Not read: ' +
      'cboe.com refused by the egress policy on 2026-09-27. The effective-from date is the start ' +
      'of this registry\'s coverage, not the schedule\'s history.',
  },
  {
    productFamily: 'SPX AM-settled weeklies (SPXO)',
    roots: ['SPXO'],
    effectiveFrom: '2026-11-09',
    windows: SPX_WINDOWS,
    outsideWindows: 'CLOSED',
    status: 'SEARCH_ONLY',
    source: 'Cboe SPXO announcement, surfaced by search 2026-09-27',
    readAt: null,
    note:
      'Effective trade date 2026-11-09, subject to regulatory review; reported to share the SPX ' +
      'schedule including global hours. Before that date the root has no rule and answers UNKNOWN.',
  },
  {
    productFamily: 'SPY ETF options',
    roots: ['SPY'],
    effectiveFrom: '2026-01-01',
    // Only the part every source agrees on. Sources conflict on whether SPY
    // options trade to 16:15, and on extended sessions for this name.
    windows: [{ sessionClass: 'REGULAR', startMinutesEt: 9 * 60 + 30, endMinutesEt: 16 * 60 }],
    outsideWindows: 'UNKNOWN',
    status: 'UNVERIFIED',
    source: 'general knowledge; conflicting search results on the 16:15 close (2026-09-27)',
    readAt: null,
    note: '16:00–16:15 and any extended session are not established, so they answer UNKNOWN.',
  },
  {
    productFamily: 'XSP mini-SPX index options',
    roots: ['XSP'],
    effectiveFrom: '2026-01-01',
    windows: [{ sessionClass: 'REGULAR', startMinutesEt: 9 * 60 + 30, endMinutesEt: 16 * 60 }],
    outsideWindows: 'UNKNOWN',
    status: 'UNVERIFIED',
    source: 'general knowledge; nothing read',
    readAt: null,
    note: 'Only the core regular window is recorded; the close and any global session are not established.',
  },
];

export function productRuleFor(root: string, date: string): ProductSessionRule | null {
  return PRODUCT_SESSION_RULES.find((r) =>
    r.roots.includes(root) && r.effectiveFrom <= date &&
    (r.effectiveTo === undefined || date <= r.effectiveTo)) ?? null;
}

export interface ProductSession {
  root: string;
  state: ProductSessionState;
  sessionClass: TradingSessionClass;
  /** The trade date the session belongs to — the next day for an evening global session. */
  tradeDate: string | null;
  rule: ProductSessionRule | null;
  status: SourceStatus;
  basis: string;
}

const isSessionDay = (date: string) => {
  const k = sessionOn(date).kind;
  return k === 'REGULAR' || k === 'EARLY_CLOSE';
};

export function productSessionAt(root: string, atMs: number): ProductSession {
  const date = marketDateOf(atMs);
  const minutes = minutesEt(atMs);
  const unknown = (basis: string, rule: ProductSessionRule | null = null, tradeDate: string | null = date): ProductSession => ({
    root, state: 'UNKNOWN', sessionClass: 'UNKNOWN', tradeDate, rule, status: 'UNVERIFIED', basis,
  });
  if (date === null || minutes === null) return unknown('the instant could not be read in the market timezone');

  // An evening global window belongs to the NEXT calendar date's session, and
  // is only open if that date holds one — so Friday and holiday-eve evenings
  // are shut while Sunday's opens Monday's session.
  const next = addDays(date, 1);
  const eveningRule = next === null ? null : productRuleFor(root, next);
  const evening = eveningRule?.windows.find((w) =>
    w.previousEvening === true && minutes >= w.startMinutesEt && minutes < w.endMinutesEt);
  if (evening !== undefined && eveningRule !== null && next !== null) {
    const s = sessionOn(next);
    if (s.kind === 'UNKNOWN') return unknown(s.basis, eveningRule, next);
    if (isSessionDay(next)) {
      return {
        root, state: 'OPEN', sessionClass: evening.sessionClass, tradeDate: next, rule: eveningRule,
        status: eveningRule.status,
        basis: `${eveningRule.source}: ${evening.sessionClass} ${hhmm(evening.startMinutesEt)} on the evening before ${next}`,
      };
    }
  }

  const rule = productRuleFor(root, date);
  if (rule === null) return unknown(`no session rule is recorded for ${root} on ${date}`);

  const s = sessionOn(date);
  if (s.kind === 'UNKNOWN') return unknown(s.basis, rule);
  if (s.kind === 'WEEKEND' || s.kind === 'HOLIDAY') {
    return {
      root, state: 'CLOSED', sessionClass: 'UNKNOWN', tradeDate: date, rule, status: rule.status,
      basis: `${s.basis}; no session is held and no evening session of the next day has begun`,
    };
  }
  if (s.kind === 'EARLY_CLOSE') {
    const open = s.openHour! * 60 + s.openMinute!;
    const close = s.closeHour! * 60 + s.closeMinute!;
    if (minutes >= open && minutes < close) {
      return {
        root, state: 'OPEN', sessionClass: 'REGULAR', tradeDate: date, rule, status: rule.status,
        basis: `${s.basis}; inside the exchange's own early-close hours`,
      };
    }
    return unknown(`${s.basis}; ${root}'s sessions on an early-close day are not established`, rule);
  }

  const w = rule.windows.find((x) =>
    x.previousEvening !== true && minutes >= x.startMinutesEt && minutes < x.endMinutesEt);
  if (w !== undefined) {
    return {
      root, state: 'OPEN', sessionClass: w.sessionClass, tradeDate: date, rule, status: rule.status,
      basis: `${rule.source}: ${w.sessionClass} ${hhmm(w.startMinutesEt)}–${hhmm(w.endMinutesEt)} ET`,
    };
  }
  if (rule.outsideWindows === 'CLOSED') {
    return {
      root, state: 'CLOSED', sessionClass: 'UNKNOWN', tradeDate: date, rule, status: rule.status,
      basis: `${rule.source}: between sessions`,
    };
  }
  return unknown(`${rule.note}`, rule);
}
