/**
 * USER-IMPORTED 1-MINUTE BARS — a CSV the trader supplied, turned into
 * validated closed `Bar`s, or refused row by row.
 *
 * This is the $0 path to bars: the live bar feed (Phase A) is blocked, so the
 * structure engine and the setup engine are driven by files a person exported
 * from somewhere else. Nothing here is persisted and nothing here fetches.
 *
 * **Format.** A header row, then one row per bar. Required columns, in any
 * order: `timestamp,open,high,low,close`. Optional column: `volume`. Extra
 * columns are refused, because a column this code does not read is a column
 * whose meaning nobody checked.
 *
 * **Timestamps have an explicit convention or the file is refused.** The
 * caller states what the timestamp marks (`OPEN` — the start of the minute —
 * or `CLOSE` — its end), and each value must carry its own zone: epoch
 * milliseconds, or ISO-8601 with `Z` or a numeric offset. A naive local time
 * (`2026-03-02 09:31`) is refused rather than assumed to be New York, because
 * the common guess is wrong for a file exported in another zone, and a bar
 * shifted by an hour still validates.
 *
 * **Refusal, not repair.** A row whose prices do not form a bar, a duplicate
 * minute, or a row out of order is rejected and named by its 1-based line
 * number; the row is never fixed, reordered or dropped silently. Missing
 * volume is `null`, not 0. Gaps between minutes are reported, never filled.
 */
import { createHash } from 'node:crypto';
import { Bar, barRefusals } from './bar';

export type TimestampMarks = 'OPEN' | 'CLOSE';

export interface BarImportOptions {
  symbol: string;
  timestampMarks: TimestampMarks;
  /** Recorded on every bar's `source`. Defaults to nothing: it must be named. */
  source: string;
}

export interface RejectedRow { line: number; reasons: string[] }
export interface BarGap { afterTOpen: number; beforeTOpen: number; missingMinutes: number }

export interface BarDataset {
  status: 'OK';
  provenance: 'USER_IMPORT';
  /** sha256 of the file's bytes exactly as supplied. */
  contentId: string;
  symbol: string;
  tf: '1m';
  timestampMarks: TimestampMarks;
  coverage: { firstTOpen: number; lastClosedAt: number; bars: number } | null;
  gaps: BarGap[];
  rejected: RejectedRow[];
  bars: Bar[];
}

export type BarImportResult = BarDataset | { status: 'REFUSED'; reasons: string[] };

const MINUTE = 60_000;
const REQUIRED = ['timestamp', 'open', 'high', 'low', 'close'] as const;
const OPTIONAL = ['volume'] as const;
const ZONED_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

/** Epoch ms from a zoned timestamp, or a reason it is not one. */
export function parseZonedTimestamp(raw: string): number | string {
  const s = raw.trim();
  if (/^\d{13}$/.test(s)) return Number(s);
  if (!ZONED_ISO.test(s)) return `timestamp ${JSON.stringify(raw)} is neither epoch ms nor ISO-8601 with a zone`;
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? ms : `timestamp ${JSON.stringify(raw)} is not a real instant`;
}

/** A strictly decimal number; '' and anything else is a reason. */
function decimal(raw: string, name: string): number | string {
  const s = raw.trim();
  if (!/^-?\d+(\.\d+)?$/.test(s)) return `${name} ${JSON.stringify(raw)} is not a decimal number`;
  return Number(s);
}

export function importBarsCsv(text: string, opts: BarImportOptions): BarImportResult {
  const refuse: string[] = [];
  if (typeof opts.symbol !== 'string' || opts.symbol.trim() === '') refuse.push('symbol is missing');
  if (opts.timestampMarks !== 'OPEN' && opts.timestampMarks !== 'CLOSE') {
    refuse.push(`timestampMarks must be OPEN or CLOSE, got ${JSON.stringify(opts.timestampMarks)}`);
  }
  if (typeof opts.source !== 'string' || opts.source.trim() === '') refuse.push('source is missing');
  const lines = text.split(/\r?\n/);
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
  if (lines.length === 0) refuse.push('file is empty');
  if (refuse.length > 0) return { status: 'REFUSED', reasons: refuse };

  const header = lines[0].split(',').map((h) => h.trim().toLowerCase());
  for (const r of REQUIRED) if (!header.includes(r)) refuse.push(`header is missing column ${r}`);
  for (const h of header) {
    if (!(REQUIRED as readonly string[]).includes(h) && !(OPTIONAL as readonly string[]).includes(h)) {
      refuse.push(`header has unknown column ${JSON.stringify(h)}`);
    }
  }
  if (new Set(header).size !== header.length) refuse.push('header repeats a column');
  if (refuse.length > 0) return { status: 'REFUSED', reasons: refuse };
  const col = (name: string) => header.indexOf(name);
  const hasVolume = header.includes('volume');

  const rejected: RejectedRow[] = [];
  const bars: Bar[] = [];
  let prev: Bar | null = null;
  for (let i = 1; i < lines.length; i++) {
    const line = i + 1;
    const cells = lines[i].split(',');
    if (cells.length !== header.length) {
      rejected.push({ line, reasons: [`has ${cells.length} cells, header has ${header.length}`] });
      continue;
    }
    const reasons: string[] = [];
    const ts = parseZonedTimestamp(cells[col('timestamp')]);
    if (typeof ts === 'string') reasons.push(ts);
    const nums: Record<string, number> = {};
    for (const k of ['open', 'high', 'low', 'close']) {
      const n = decimal(cells[col(k)], k);
      if (typeof n === 'string') reasons.push(n); else nums[k] = n;
    }
    let v: number | null = null;
    if (hasVolume && cells[col('volume')].trim() !== '') {
      const n = decimal(cells[col('volume')], 'volume');
      if (typeof n === 'string') reasons.push(n); else v = n;
    }
    if (reasons.length > 0) { rejected.push({ line, reasons }); continue; }
    const tOpen = opts.timestampMarks === 'OPEN' ? (ts as number) : (ts as number) - MINUTE;
    if (tOpen % MINUTE !== 0) {
      rejected.push({ line, reasons: [`timestamp is not on a minute boundary`] });
      continue;
    }
    const bar: Bar = {
      symbol: opts.symbol, tf: '1m', tOpen, closedAt: tOpen + MINUTE,
      o: nums.open, h: nums.high, l: nums.low, c: nums.close, v, source: opts.source,
    };
    const own = barRefusals(bar);
    if (own.length > 0) { rejected.push({ line, reasons: own }); continue; }
    if (prev !== null && tOpen === prev.tOpen) {
      rejected.push({ line, reasons: [`duplicates the minute ${new Date(tOpen).toISOString()}`] });
      continue;
    }
    if (prev !== null && tOpen < prev.tOpen) {
      rejected.push({ line, reasons: [`is out of order: ${new Date(tOpen).toISOString()} is before ${new Date(prev.tOpen).toISOString()}`] });
      continue;
    }
    bars.push(bar);
    prev = bar;
  }

  const gaps: BarGap[] = [];
  for (let i = 1; i < bars.length; i++) {
    const missing = (bars[i].tOpen - bars[i - 1].tOpen) / MINUTE - 1;
    if (missing > 0) gaps.push({ afterTOpen: bars[i - 1].tOpen, beforeTOpen: bars[i].tOpen, missingMinutes: missing });
  }

  return {
    status: 'OK',
    provenance: 'USER_IMPORT',
    contentId: createHash('sha256').update(text).digest('hex'),
    symbol: opts.symbol,
    tf: '1m',
    timestampMarks: opts.timestampMarks,
    coverage: bars.length === 0 ? null
      : { firstTOpen: bars[0].tOpen, lastClosedAt: bars[bars.length - 1].closedAt, bars: bars.length },
    gaps,
    rejected,
    bars,
  };
}
