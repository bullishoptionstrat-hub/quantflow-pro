/**
 * AUCTION / PROFILE DETECTORS: volume and TPO profile, POC, value area,
 * initial balance and its extensions, single prints, and prior-day value
 * levels the sweep detector can use.
 *
 * **Every definition below is a versioned hypothesis, not a finding.** Auction
 * market theory has no peer-reviewed evidence of an edge (docs/RESEARCH_2026-11-18.md);
 * these are the textbook constructions written down exactly so they can be
 * measured. Every parameter is untuned.
 *
 * Definitions (`profile-rules/1`):
 *
 *   Session. For each market date D with bars: UNKNOWN (past `COVERAGE`) →
 *   PROFILE_UNMEASURABLE with the calendar's reason, known at the first bar
 *   dated D. WEEKEND / HOLIDAY → nothing. REGULAR / EARLY_CLOSE → bounds from
 *   `regularSessionInstants(D)` (13:00 on a half day); RTH bars are those with
 *   `tOpen >= open` and `closedAt <= close`. The session's profile is known at
 *   the close of the first bar whose `closedAt >= close` (the levels.ts rule).
 *
 *   Bins. A price p is in bin `k = floor(p / binSize)`; bin k spans
 *   `[k·binSize, (k+1)·binSize)`. A bar touches every bin from `bin(l)` to
 *   `bin(h)` inclusive. `binSize` has NO default: a tick-sized bin for one
 *   instrument is meaningless for another, and a default would be invented.
 *
 *   TPO profile. RTH is cut into periods of `tpoMinutes` from the open. A bin's
 *   TPO count is the number of periods in which some RTH bar touched it.
 *
 *   Volume profile. Each RTH bar's volume is split EQUALLY across the bins it
 *   touched (an assumption: a bar does not say where in its range it traded).
 *   If any RTH bar has `v === null` the volume profile is `null` and
 *   `volumeMissingBars` says how many — a missing volume is never a zero.
 *
 *   POC. The bin with the largest count. Ties: the bin nearest the centre of
 *   the profile's bin range, then the lower bin. Price = the bin's midpoint.
 *
 *   Value area. Start at the POC; repeatedly compare the next bin above with
 *   the next bin below (one bin each side, not pairs) and add the larger; on a
 *   tie add both. Stop once the area holds at least `valueAreaPct` of the
 *   total. VAH = upper edge of the top bin, VAL = lower edge of the bottom bin.
 *
 *   Single prints. Runs of contiguous TPO bins with a count of exactly 1,
 *   excluding any run that touches the profile's top or bottom bin (those are
 *   tails, not single prints).
 *
 *   Initial balance. RTH bars with `closedAt <= open + ibMinutes`. Known at the
 *   close of the first bar whose `closedAt >= open + ibMinutes`. COMPLETE when
 *   every expected bar is present, INCOMPLETE otherwise. Not computed when the
 *   session closes at or before `open + ibMinutes`.
 *
 *   IB extension. For a COMPLETE IB only: the first later RTH bar whose high
 *   exceeds IBH (UP) / low undercuts IBL (DOWN), known at that bar's close.
 *   The session profile records the session's full extension in IB-range
 *   multiples, known with the profile.
 *
 *   Prior-day value levels. `levelsFromProfiles` turns COMPLETE profiles into
 *   sweep levels: VAH as a HIGH-side level, VAL as a LOW-side one, from the
 *   basis the caller names. The POC is neither side and is not a sweep level.
 */
import { createHash } from 'node:crypto';
import { Bar, TIMEFRAME_MS } from '../market/bar';
import { marketDateOf } from '../market/civil';
import { regularSessionInstants } from '../market/session';
import { sessionOn } from '../flow-engine/calendar';
import { EventBase, cite, refOf, requireSeries } from './types';
import type { SweepLevel } from './sweep';

/** Bump on any change to what this file computes. `profile.test.ts` pins the source. */
export const PROFILE_RULES_VERSION = 'profile-rules/1';

export interface ProfileParams {
  /** Price width of one bin. Required: no default exists that fits every instrument. */
  binSize: number;
  /** Share of the profile the value area must hold. Choice: 0.70 (convention). Untuned. */
  valueAreaPct: number;
  /** Length of one TPO period in minutes. Choice: 30. Untuned. */
  tpoMinutes: number;
  /** Length of the initial balance in minutes. Choice: 60. Untuned. */
  ibMinutes: number;
}

export const DEFAULT_PROFILE_PARAMS: Readonly<Omit<ProfileParams, 'binSize'>> = Object.freeze({
  valueAreaPct: 0.7,
  tpoMinutes: 30,
  ibMinutes: 60,
});

/** A profile wider than this many bins is refused rather than allocated. */
export const MAX_BINS = 20_000;

export function profileParamRefusals(p: Partial<ProfileParams>): string[] {
  const r: string[] = [];
  if (typeof p.binSize !== 'number' || !Number.isFinite(p.binSize) || !(p.binSize > 0)) {
    r.push(`binSize must be a positive finite number, got ${p.binSize}`);
  }
  if (typeof p.valueAreaPct !== 'number' || !(p.valueAreaPct > 0 && p.valueAreaPct <= 1)) {
    r.push(`valueAreaPct must be in (0, 1], got ${p.valueAreaPct}`);
  }
  for (const k of ['tpoMinutes', 'ibMinutes'] as const) {
    if (!Number.isInteger(p[k]) || (p[k] as number) < 1) r.push(`${k} must be an integer of at least 1, got ${p[k]}`);
  }
  const known = new Set(['binSize', 'valueAreaPct', 'tpoMinutes', 'ibMinutes']);
  for (const k of Object.keys(p)) if (!known.has(k)) r.push(`unknown parameter ${k}`);
  return r;
}

export class ProfileParamsError extends Error {
  constructor(public readonly reasons: string[]) {
    super(`profile parameters refused: ${reasons.join('; ')}`);
  }
}

/** Defaults overlaid with the caller's choices; `binSize` must be supplied. */
export function resolveProfileParams(p: Partial<ProfileParams>): ProfileParams {
  const full = { ...DEFAULT_PROFILE_PARAMS, ...p } as ProfileParams;
  const reasons = profileParamRefusals(full);
  if (reasons.length > 0) throw new ProfileParamsError(reasons);
  return full;
}

export function profileMethodVersionOf(p: ProfileParams): string {
  const keys = (Object.keys(p) as (keyof ProfileParams)[]).sort();
  const canonical = JSON.stringify({ rules: PROFILE_RULES_VERSION, params: keys.map((k) => [k, p[k]]) });
  return `${PROFILE_RULES_VERSION}:${createHash('sha256').update(canonical).digest('hex').slice(0, 16)}`;
}

// ── Pure profile arithmetic ─────────────────────────────────────────────────

export interface ValueArea { poc: number; vah: number; val: number; total: number; pocBin: number }

const binOf = (price: number, size: number): number => Math.floor(price / size);

/**
 * POC and value area over a dense count array whose index 0 is bin `lowBin`.
 * Null when nothing was counted.
 */
export function valueAreaOf(counts: readonly number[], lowBin: number, binSize: number, pct: number): ValueArea | null {
  let total = 0;
  for (const c of counts) total += c;
  if (!(total > 0)) return null;
  const centre = (counts.length - 1) / 2;
  let poc = 0;
  for (let i = 1; i < counts.length; i++) {
    if (counts[i] > counts[poc]) poc = i;
    else if (counts[i] === counts[poc] && Math.abs(i - centre) < Math.abs(poc - centre)) poc = i;
  }
  let lo = poc, hi = poc, area = counts[poc];
  const target = pct * total;
  while (area < target && (lo > 0 || hi < counts.length - 1)) {
    const up = hi < counts.length - 1 ? counts[hi + 1] : -1;
    const down = lo > 0 ? counts[lo - 1] : -1;
    if (up > down) { hi++; area += up; }
    else if (down > up) { lo--; area += down; }
    else { hi++; lo--; area += up + down; }
  }
  return {
    pocBin: lowBin + poc,
    poc: (lowBin + poc + 0.5) * binSize,
    vah: (lowBin + hi + 1) * binSize,
    val: (lowBin + lo) * binSize,
    total,
  };
}

/** Interior runs of count === 1, as `[low edge, high edge]`. */
export function singlePrintsOf(counts: readonly number[], lowBin: number, binSize: number): { low: number; high: number }[] {
  const out: { low: number; high: number }[] = [];
  let i = 0;
  while (i < counts.length) {
    if (counts[i] !== 1) { i++; continue; }
    let j = i;
    while (j + 1 < counts.length && counts[j + 1] === 1) j++;
    if (i > 0 && j < counts.length - 1) out.push({ low: (lowBin + i) * binSize, high: (lowBin + j + 1) * binSize });
    i = j + 1;
  }
  return out;
}

// ── Events ───────────────────────────────────────────────────────────────────

export interface ProfileBin { low: number; tpo: number; volume: number | null }

export interface InitialBalance {
  high: number;
  low: number;
  endsAt: number;
  status: 'COMPLETE' | 'INCOMPLETE';
  present: number;
  expected: number;
}

export interface SessionProfileEvent extends EventBase {
  kind: 'SESSION_PROFILE';
  sessionDate: string;
  sessionKind: 'REGULAR' | 'EARLY_CLOSE';
  status: 'COMPLETE' | 'INCOMPLETE';
  coverage: { present: number; expected: number; openAt: number; closeAt: number };
  binSize: number;
  bins: ProfileBin[];
  tpo: ValueArea;
  /** Null when any RTH bar carried no volume. */
  volume: ValueArea | null;
  volumeMissingBars: number;
  singlePrints: { low: number; high: number }[];
  /** Null when the session is too short for an IB or the IB is incomplete. */
  ibExtension: { up: number; down: number } | null;
}

export interface InitialBalanceEvent extends EventBase {
  kind: 'INITIAL_BALANCE';
  sessionDate: string;
  ib: InitialBalance;
}

export interface IbExtensionEvent extends EventBase {
  kind: 'IB_EXTENSION';
  sessionDate: string;
  direction: 'UP' | 'DOWN';
  /** The IB boundary that was exceeded. */
  boundary: number;
  /** How far the breaking bar went beyond it, in IB-range multiples. */
  multiple: number;
}

export interface ProfileUnmeasurableEvent extends EventBase {
  kind: 'PROFILE_UNMEASURABLE';
  sessionDate: string;
  status: 'UNMEASURABLE';
  reason: string;
}

export type ProfileEvent = SessionProfileEvent | InitialBalanceEvent | IbExtensionEvent | ProfileUnmeasurableEvent;

export function detectProfiles(bars: readonly Bar[], overrides: Partial<ProfileParams>): ProfileEvent[] {
  requireSeries(bars);
  const params = resolveProfileParams(overrides);
  const methodVersion = profileMethodVersionOf(params);
  const out: ProfileEvent[] = [];
  if (bars.length === 0) return out;
  const { symbol, tf } = bars[0];
  const step = TIMEFRAME_MS[tf];

  const runs: { date: string; from: number; to: number }[] = [];
  for (let i = 0; i < bars.length; i++) {
    const date = marketDateOf(bars[i].tOpen);
    if (date === null) continue;
    const last = runs[runs.length - 1];
    if (last !== undefined && last.date === date) last.to = i;
    else runs.push({ date, from: i, to: i });
  }

  const firstClosingAtOrAfter = (from: number, t: number): number => {
    for (let k = from; k < bars.length; k++) if (bars[k].closedAt >= t) return k;
    return -1;
  };
  const unmeasurable = (date: string, at: Bar, reason: string, evidence = [refOf(at)]): ProfileUnmeasurableEvent => ({
    id: `PROFILE_UNMEASURABLE:${symbol}:${tf}:${date}`,
    kind: 'PROFILE_UNMEASURABLE', symbol, tf,
    knownAt: at.closedAt, methodVersion, evidence,
    sessionDate: date, status: 'UNMEASURABLE', reason,
  });

  for (const run of runs) {
    const session = sessionOn(run.date);
    if (session.kind === 'WEEKEND' || session.kind === 'HOLIDAY') continue;
    // UNKNOWN (past COVERAGE) has no published bounds: unmeasurable, with the calendar's reason.
    const bounds = regularSessionInstants(run.date);
    if (!bounds.ok || session.kind === 'UNKNOWN') {
      out.push(unmeasurable(run.date, bars[run.from], bounds.ok ? session.basis : bounds.why));
      continue;
    }

    const rthIdx: number[] = [];
    for (let k = run.from; k <= run.to; k++) {
      if (bars[k].tOpen >= bounds.open && bars[k].closedAt <= bounds.close) rthIdx.push(k);
    }

    // ── Initial balance (known before the session ends) ──
    const ibEnd = bounds.open + params.ibMinutes * 60_000;
    let ib: InitialBalance | null = null;
    let ibResolver = -1;
    if (ibEnd < bounds.close) {
      ibResolver = firstClosingAtOrAfter(run.from, ibEnd);
      const ibBars = rthIdx.filter((k) => bars[k].closedAt <= ibEnd);
      if (ibResolver !== -1 && ibBars.length > 0) {
        let h = -Infinity, l = Infinity;
        for (const k of ibBars) { h = Math.max(h, bars[k].h); l = Math.min(l, bars[k].l); }
        const expected = Math.floor((ibEnd - bounds.open) / step);
        ib = { high: h, low: l, endsAt: ibEnd, status: ibBars.length === expected ? 'COMPLETE' : 'INCOMPLETE', present: ibBars.length, expected };
        out.push({
          id: `INITIAL_BALANCE:${symbol}:${tf}:${run.date}`,
          kind: 'INITIAL_BALANCE', symbol, tf,
          knownAt: bars[ibResolver].closedAt, methodVersion,
          evidence: cite(ibBars.map((k) => refOf(bars[k])), [refOf(bars[ibResolver])]),
          sessionDate: run.date, ib,
        });
        if (ib.status === 'COMPLETE' && ib.high > ib.low) {
          const range = ib.high - ib.low;
          const ibEv = ibBars.map((k) => refOf(bars[k]));
          for (const dir of ['UP', 'DOWN'] as const) {
            const k = rthIdx.find((x) => (dir === 'UP' ? bars[x].h > ib!.high : bars[x].l < ib!.low));
            if (k === undefined) continue;
            const b = bars[k];
            out.push({
              id: `IB_EXTENSION:${dir}:${symbol}:${tf}:${run.date}`,
              kind: 'IB_EXTENSION', symbol, tf,
              knownAt: b.closedAt, methodVersion,
              evidence: cite(ibEv, [refOf(b)]),
              sessionDate: run.date, direction: dir,
              boundary: dir === 'UP' ? ib.high : ib.low,
              multiple: (dir === 'UP' ? b.h - ib.high : ib.low - b.l) / range,
            });
          }
        }
      }
    }

    // ── The session profile (known once the session is over) ──
    const resolver = firstClosingAtOrAfter(run.from, bounds.close);
    if (resolver === -1) continue;
    const resolvedBy = bars[resolver];
    if (rthIdx.length === 0) {
      out.push(unmeasurable(run.date, resolvedBy, `no bar dated ${run.date} lies inside its published regular session`,
        cite([refOf(bars[run.from])], [refOf(resolvedBy)])));
      continue;
    }
    let lowBin = Infinity, highBin = -Infinity;
    for (const k of rthIdx) { lowBin = Math.min(lowBin, binOf(bars[k].l, params.binSize)); highBin = Math.max(highBin, binOf(bars[k].h, params.binSize)); }
    const n = highBin - lowBin + 1;
    if (n > MAX_BINS) {
      out.push(unmeasurable(run.date, resolvedBy, `the session spans ${n} bins of ${params.binSize}, more than ${MAX_BINS}`,
        cite([refOf(bars[rthIdx[0]])], [refOf(resolvedBy)])));
      continue;
    }
    const tpo = new Array<number>(n).fill(0);
    const vol = new Array<number>(n).fill(0);
    let volumeMissingBars = 0;
    const periodMs = params.tpoMinutes * 60_000;
    // Last period index in which each bin was touched; a bin is counted once per period.
    const lastPeriod = new Array<number>(n).fill(-1);
    for (const k of rthIdx) {
      const b = bars[k];
      const from = binOf(b.l, params.binSize) - lowBin;
      const to = binOf(b.h, params.binSize) - lowBin;
      const period = Math.floor((b.tOpen - bounds.open) / periodMs);
      if (b.v === null) volumeMissingBars++;
      const share = b.v === null ? 0 : b.v / (to - from + 1);
      for (let i = from; i <= to; i++) {
        if (lastPeriod[i] !== period) { tpo[i]++; lastPeriod[i] = period; }
        vol[i] += share;
      }
    }
    const tpoVa = valueAreaOf(tpo, lowBin, params.binSize, params.valueAreaPct);
    if (tpoVa === null) continue; // unreachable: every RTH bar touches at least one bin
    const volVa = volumeMissingBars > 0 ? null : valueAreaOf(vol, lowBin, params.binSize, params.valueAreaPct);

    let sessHigh = -Infinity, sessLow = Infinity;
    for (const k of rthIdx) { sessHigh = Math.max(sessHigh, bars[k].h); sessLow = Math.min(sessLow, bars[k].l); }
    const ibExtension = ib !== null && ib.status === 'COMPLETE' && ib.high > ib.low
      ? { up: Math.max(0, sessHigh - ib.high) / (ib.high - ib.low), down: Math.max(0, ib.low - sessLow) / (ib.high - ib.low) }
      : null;

    const expected = Math.floor((bounds.close - bounds.open) / step);
    out.push({
      id: `SESSION_PROFILE:${symbol}:${tf}:${run.date}`,
      kind: 'SESSION_PROFILE', symbol, tf,
      knownAt: resolvedBy.closedAt, methodVersion,
      evidence: cite([refOf(bars[rthIdx[0]]), refOf(bars[rthIdx[rthIdx.length - 1]])], [refOf(resolvedBy)]),
      sessionDate: run.date,
      sessionKind: session.kind,
      status: rthIdx.length === expected ? 'COMPLETE' : 'INCOMPLETE',
      coverage: { present: rthIdx.length, expected, openAt: bounds.open, closeAt: bounds.close },
      binSize: params.binSize,
      bins: tpo.map((c, i) => ({ low: (lowBin + i) * params.binSize, tpo: c, volume: volumeMissingBars > 0 ? null : vol[i] })),
      tpo: tpoVa,
      volume: volVa,
      volumeMissingBars,
      singlePrints: singlePrintsOf(tpo, lowBin, params.binSize),
      ibExtension,
    });
  }
  return out;
}

/**
 * COMPLETE session profiles as sweep levels: VAH (HIGH side) and VAL (LOW
 * side) from the named basis. An INCOMPLETE profile, or a VOLUME basis with
 * missing volume, yields nothing rather than a level computed from part of a day.
 */
export function levelsFromProfiles(events: readonly ProfileEvent[], basis: 'VOLUME' | 'TPO'): SweepLevel[] {
  const out: SweepLevel[] = [];
  for (const e of events) {
    if (e.kind !== 'SESSION_PROFILE' || e.status !== 'COMPLETE') continue;
    const va = basis === 'VOLUME' ? e.volume : e.tpo;
    if (va === null) continue;
    out.push({ id: `VAH:${basis}:${e.id}`, name: `PD_VAH_${basis}`, side: 'HIGH', price: va.vah, knownAt: e.knownAt, evidence: e.evidence });
    out.push({ id: `VAL:${basis}:${e.id}`, name: `PD_VAL_${basis}`, side: 'LOW', price: va.val, knownAt: e.knownAt, evidence: e.evidence });
  }
  return out;
}
