/**
 * FEED WINDOW — is a market-data feed inside the hours it says it supports?
 *
 * This is a statement about the FEED, not about any product or venue. The
 * operator's audit of 2026-09-27 reports that OPRA extended its supported
 * hours to 07:30–17:00 ET effective 2026-09-21, and that the notice itself
 * warns (a) participation in extended hours differs by participant, and (b)
 * regular-session quotes from exchanges not participating in an extended
 * session may remain present 16:00–16:15 and should be disregarded. So "the
 * feed window is open" says nothing about whether a given contract can trade,
 * and a quote seen in it is not necessarily a live market.
 *
 * **Nothing below was read in a primary document.** opraplan.com was refused
 * by this environment's egress policy on 2026-09-27, so every rule is
 * UNVERIFIED and carries its source as quoted, not as read. The window before
 * 2026-09-21 is not recorded at all, and dates before the first rule answer
 * UNKNOWN rather than being assumed to have had some default window.
 *
 * Two further limits, stated rather than guessed:
 *   - whether overnight sessions (Cboe's global trading hours) are carried by
 *     OPRA outside this window is not established here, so OUTSIDE_FEED_WINDOW
 *     means "outside the stated window", not "no OPRA message can exist now";
 *   - how the window behaves on an early-close day is not established, so on
 *     those days anything outside the exchange's own hours is UNKNOWN.
 */
import { sessionOn } from '../flow-engine/calendar';
import { hhmm, marketDateOf, minutesEt } from './civil';
import type { SourceStatus } from '../events/semantics';

export type FeedSessionState = 'SUPPORTED' | 'OUTSIDE_FEED_WINDOW' | 'UNKNOWN';

export interface FeedWindowRule {
  feed: 'OPRA';
  effectiveFrom: string;
  effectiveTo?: string;
  startMinutesEt: number;
  endMinutesEt: number;
  status: SourceStatus;
  source: string;
  /** When the primary document was read; null when it was not. */
  readAt: string | null;
  note: string;
}

export const FEED_WINDOW_RULES: readonly FeedWindowRule[] = [
  {
    feed: 'OPRA',
    effectiveFrom: '2026-09-21',
    startMinutesEt: 7 * 60 + 30,
    endMinutesEt: 17 * 60,
    status: 'UNVERIFIED',
    source: 'OPRA extended-hours notice, as quoted by the operator audit of 2026-09-27',
    readAt: null,
    note:
      'Primary notice not read (opraplan.com refused by the egress policy on 2026-09-27). ' +
      'Reported to say extended-hours participation differs by participant, and that ' +
      'regular-session quotes from nonparticipating exchanges may remain 16:00–16:15 and should be disregarded.',
  },
];

export interface FeedSession {
  feed: 'OPRA';
  state: FeedSessionState;
  date: string | null;
  rule: FeedWindowRule | null;
  basis: string;
  status: SourceStatus;
}

function ruleFor(feed: 'OPRA', date: string): FeedWindowRule | null {
  return FEED_WINDOW_RULES.find((r) =>
    r.feed === feed && r.effectiveFrom <= date && (r.effectiveTo === undefined || date <= r.effectiveTo)) ?? null;
}

export function feedSessionAt(feed: 'OPRA', atMs: number): FeedSession {
  const date = marketDateOf(atMs);
  const minutes = minutesEt(atMs);
  const unknown = (basis: string, rule: FeedWindowRule | null = null): FeedSession => ({
    feed, state: 'UNKNOWN', date, rule, basis, status: 'UNVERIFIED',
  });
  if (date === null || minutes === null) return unknown('the instant could not be read in the market timezone');

  const rule = ruleFor(feed, date);
  if (rule === null) return unknown(`no ${feed} window rule is recorded for ${date}`);

  const s = sessionOn(date);
  if (s.kind === 'UNKNOWN') return unknown(s.basis, rule);
  if (s.kind === 'WEEKEND' || s.kind === 'HOLIDAY') {
    return unknown(`${s.basis}; whether the feed carries anything on a non-session day is not established`, rule);
  }
  const window = `${hhmm(rule.startMinutesEt)}–${hhmm(rule.endMinutesEt)} ET`;
  if (s.kind === 'EARLY_CLOSE') {
    const open = s.openHour! * 60 + s.openMinute!;
    const close = s.closeHour! * 60 + s.closeMinute!;
    if (minutes >= open && minutes < close) {
      return {
        feed, state: 'SUPPORTED', date, rule, status: rule.status,
        basis: `${s.basis}; inside the exchange's own hours, which any feed window contains`,
      };
    }
    return unknown(`${s.basis}; how the ${window} window behaves on an early-close day is not established`, rule);
  }
  const inside = minutes >= rule.startMinutesEt && minutes < rule.endMinutesEt;
  return {
    feed,
    state: inside ? 'SUPPORTED' : 'OUTSIDE_FEED_WINDOW',
    date, rule, status: rule.status,
    basis: `${rule.source}: ${window}, effective ${rule.effectiveFrom}; ${inside ? 'inside' : 'outside'} it`,
  };
}
