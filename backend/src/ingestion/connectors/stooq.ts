/**
 * Stooq — Free global quotes via CSV (no API key needed)
 * Good for: International indices, commodities, futures
 * Endpoint: https://stooq.com/q/d/l/?s={symbol}&i=d
 */
import axios from 'axios';

const ENABLED = process.env.STOOQ_ENABLED !== 'false';

// Stooq symbol format: lowercase with ^ prefix for indices
const SYMBOLS: Record<string, string> = {
  '^spx': 'SPX',
  '^ndx': 'NDX',
  '^dji': 'DJIA',
  '^vix': 'VIX',
  '^tnx': 'TNX', // 10Y yield
  '^fvx': 'FVX', // 5Y yield
  '^tyx': 'TYX', // 30Y yield
  'gc.f': 'GOLD',
  'si.f': 'SILVER',
  'cl.f': 'OIL',
  'ng.f': 'NATGAS',
  'dx.f': 'DXY',
};

export interface StooqQuote {
  stooqSymbol: string;
  symbol: string;
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  source: 'stooq';
}

const stooqCache = new Map<string, StooqQuote>();
let onStooqUpdate: ((q: StooqQuote) => void) | null = null;

/** Health of the last fetch cycle, reported to /api/health via `onStooqHealth`. */
export interface StooqHealth {
  ok: boolean;
  /** Operator-facing, and public: this reaches the unauthenticated /api/health. */
  reason?: string;
}

let onHealth: ((h: StooqHealth) => void) | null = null;

export function onStooqQuote(handler: (q: StooqQuote) => void): void { onStooqUpdate = handler; }
export function onStooqHealth(handler: (h: StooqHealth) => void): void { onHealth = handler; }
export function getStooqQuotes(): Map<string, StooqQuote> { return stooqCache; }

/**
 * Thrown when the endpoint answers with something that is not the CSV it is
 * supposed to return.
 *
 * Stooq now serves a JavaScript proof-of-work anti-bot challenge in place of
 * the data — HTTP **200**, an HTML body, four lines long. The old parser's
 * only guard was `lines.length < 2`, which that page clears, after which
 * `headers.indexOf('date')` returned -1, every field read as `''`, and
 * `parseFloat('' || '0')` produced a quote with `close: 0` that went straight
 * into the cache. Twelve of them, every ten minutes, with `/api/health`
 * reporting stooq `connected` — SPX, NDX, DJIA and the whole yield curve
 * priced at zero and indistinguishable from data.
 *
 * The challenge is an access control. Solving it is not on the table, and it
 * is not a rights classification either: we have not read Stooq's terms, and
 * an anti-bot page is evidence about access, not a quoted restriction. It is
 * recorded as a source that is down, which is what it is.
 */
class StooqParseError extends Error {}

async function fetchQuote(stooqSym: string): Promise<void> {
  try {
    const { data } = await axios.get(
      `https://stooq.com/q/d/l/?s=${encodeURIComponent(stooqSym)}&i=d`,
      {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        timeout: 6000,
        responseType: 'text',
      }
    );

    const lines = (data as string).trim().split('\n');
    if (lines.length < 2) {
      throw new StooqParseError(
        `${stooqSym}: response had ${lines.length} line(s), expected a CSV header plus rows.`,
      );
    }

    const headers = lines[0].split(',').map((h: string) => h.trim().toLowerCase());
    // The header row is what distinguishes the CSV from the challenge page.
    // Nothing is cached when it is absent: a quote priced at 0 is worse than
    // no quote, because a panel renders it as a number.
    if (!headers.includes('date') || !headers.includes('close')) {
      const looksLikeHtml = /^\s*<(!doctype|html)/i.test(data as string);
      throw new StooqParseError(
        looksLikeHtml
          ? `${stooqSym}: endpoint returned an HTML page, not CSV — Stooq is serving a ` +
            `browser-verification challenge. No quote was cached; a zero price would ` +
            `render as data.`
          : `${stooqSym}: CSV header had no date/close column (got: ${headers.join(', ') || 'nothing'}).`,
      );
    }

    const latest = lines[lines.length - 1].split(',');
    const get = (field: string) => {
      const idx = headers.indexOf(field);
      return idx >= 0 ? latest[idx]?.trim() : '';
    };

    const quote: StooqQuote = {
      stooqSymbol: stooqSym,
      symbol: SYMBOLS[stooqSym] ?? stooqSym.toUpperCase(),
      date: get('date'),
      open: parseFloat(get('open') || '0'),
      high: parseFloat(get('high') || '0'),
      low: parseFloat(get('low') || '0'),
      close: parseFloat(get('close') || '0'),
      volume: parseInt(get('volume') || '0'),
      source: 'stooq',
    };

    if (!(quote.close > 0)) {
      throw new StooqParseError(
        `${stooqSym}: parsed a close of ${quote.close}. Not cached — a zero price is ` +
        `not a price.`,
      );
    }

    stooqCache.set(quote.symbol, quote);
    onStooqUpdate?.(quote);
  } catch (err: any) {
    // Re-thrown so the cycle can report it. The old bare `catch {}` is how a
    // dead source stayed invisible.
    throw err instanceof StooqParseError
      ? err
      : new StooqParseError(`${stooqSym}: ${err?.message ?? 'fetch failed'}`);
  }
}

export async function startStooq(): Promise<void> {
  if (!ENABLED) { console.log('[stooq] Disabled'); return; }

  async function fetchAll(): Promise<void> {
    const failures: string[] = [];
    for (const sym of Object.keys(SYMBOLS)) {
      try {
        await fetchQuote(sym);
      } catch (err: any) {
        failures.push(err?.message ?? String(err));
      }
      await new Promise(r => setTimeout(r, 800)); // 800ms between requests
    }

    const total = Object.keys(SYMBOLS).length;
    if (failures.length === 0) {
      onHealth?.({ ok: true });
    } else {
      // One reason, not twelve: they are the same failure repeated per symbol.
      onHealth?.({
        ok: false,
        reason:
          `${failures.length}/${total} symbols failed. ${failures[0]}` +
          (failures.length > 1 ? ` (+${failures.length - 1} more, same cause)` : ''),
      });
    }
  }

  await fetchAll();
  // Reported on every cycle, not just the first. `startConnector` records what
  // `start()` returned and never looks again, so a source that dies an hour
  // after boot would otherwise keep reporting `connected`.
  // `unref` so a poll timer is never the reason a process cannot exit. The
  // server is held open by its HTTP listener; a test or a one-shot script that
  // starts this connector should be free to finish.
  setInterval(fetchAll, 10 * 60_000).unref(); // every 10 min
  console.log('[stooq] Started — global indices, commodities, futures (no key required)');
}
