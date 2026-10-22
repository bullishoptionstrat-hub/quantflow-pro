/**
 * H-001-v2 §A's dated windows, as frozen on 2026-09-27 in
 * `research/hypotheses/H-001-v2-aggressive-call-buying-spy.md`.
 *
 * The analysis is handed data and never chooses dates, so most of it has no
 * need to know these. One place does: an exploratory endpoint whose horizon
 * runs past the last confirmatory day. A decision on 2026-06-30 has its D1
 * exit on 2026-07-01, the first day of a holdout §A says is "not accessed for
 * H-001-v2 at all" — and whether that quote is read would otherwise depend on
 * whether the caller happened to load it. A test reads the frozen file and
 * holds these constants to its §A table, so they cannot drift from it.
 */

export interface DateWindow {
  /** Inclusive, YYYY-MM-DD. */
  from: string;
  to: string;
}

export const H001_CONFIRMATORY: Readonly<DateWindow> = Object.freeze({ from: '2026-01-02', to: '2026-06-30' });
export const H001_HOLDOUT: Readonly<DateWindow> = Object.freeze({ from: '2026-07-01', to: '2026-08-14' });

/** ISO dates compare as strings, so the window test needs no clock. */
export function inWindow(date: string, w: Readonly<DateWindow>): boolean {
  return date >= w.from && date <= w.to;
}
