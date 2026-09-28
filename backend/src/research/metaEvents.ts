/**
 * The unit of analysis H-001-v2 freezes: one META-EVENT, not one print and
 * not one engine signal (INV-RESEARCH-002).
 *
 * Twenty prints of one sweep are one piece of information, and so are three
 * signals from one order split across strikes. Counting each as an
 * observation multiplies a single economic event into a sample, which shrinks
 * every interval by a factor nobody earned — pseudo-replication, the quietest
 * way a hit rate gets flattering.
 *
 * The rule, per trading day: sort qualifying signals by `decisionAt`; the
 * first defines a meta-event at t₁; every signal with decisionAt in
 * [t₁, t₁ + window) is absorbed; the first at or after t₁ + window starts the
 * next. Outcome windows measured from each meta-event's first signal
 * therefore never overlap — so no stretch of the underlying is counted twice.
 *
 * Grouping is by market date, so a meta-event never spans two sessions.
 */
import { marketDateOf } from '../market/civil';

export interface Qualifying {
  signalId: string;
  decisionAt: number;
}

export interface MetaEvent {
  /** The market date the meta-event belongs to. */
  date: string;
  /** When it starts: its first signal's decisionAt, and where its outcome is measured from. */
  startsAt: number;
  signalIds: string[];
}

export function groupMetaEvents(signals: readonly Qualifying[], windowMs: number): MetaEvent[] {
  if (!(Number.isFinite(windowMs) && windowMs > 0)) throw new RangeError('the meta-event window must be a positive duration');
  const byDate = new Map<string, Qualifying[]>();
  for (const s of signals) {
    const date = marketDateOf(s.decisionAt);
    // An unreadable instant has no session to belong to, and a sample is not
    // the place to guess one.
    if (date === null) throw new RangeError(`signal ${s.signalId} has an unreadable decision time`);
    const list = byDate.get(date) ?? [];
    list.push(s);
    byDate.set(date, list);
  }
  const out: MetaEvent[] = [];
  for (const date of [...byDate.keys()].sort()) {
    const day = byDate.get(date)!.sort((a, b) => a.decisionAt - b.decisionAt || (a.signalId < b.signalId ? -1 : 1));
    let current: MetaEvent | null = null;
    for (const s of day) {
      if (current === null || s.decisionAt >= current.startsAt + windowMs) {
        current = { date, startsAt: s.decisionAt, signalIds: [] };
        out.push(current);
      }
      current.signalIds.push(s.signalId);
    }
  }
  return out;
}
