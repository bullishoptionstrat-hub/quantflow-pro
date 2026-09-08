/**
 * Where does this source substitute a made-up value for one a vendor did not
 * send?
 *
 * One implementation, shared by every guard that asks the question, because
 * two guards for one rule drift to different strengths — and both of the ones
 * this repo had did. The chain guard required the field name to sit adjacent
 * to the operator, so it missed `data.bid?.[i] ?? 0`. The older guard banned
 * the bare `?? 0` string but first deleted every line *ending* in `?? 0,` —
 * an object literal's field, which is how coinGecko wrote the defect it was
 * added for — and never looked at `|| 0`.
 *
 * So: find the operator, walk backwards over balanced brackets to the
 * expression being defaulted, and report the pair.
 *
 * **The literal is not always zero.** Scanning only for `?? 0` was itself a
 * hand-written list of one: `heatScore` fabricated a 30-day expiry with
 * `input.daysToExpiry ?? 30`, and FlashAlpha published a dealer regime nobody
 * reported with `data.dealer_regime ?? 'neutral'`. A default is a claim
 * whatever value it invents, so numeric defaults of every value are reported
 * here and the guard decides what to do with each.
 *
 * String defaults are deliberately **not** scanned. In this codebase they are
 * overwhelmingly labels and error text — `err?.message ?? 'fetch failed'`,
 * `exchange ?? 'UNKNOWN'` — and a ledger that made every one of those an
 * exception to justify would be rubber-stamped within a week, which is worth
 * less than no ledger. The one string default that was a market claim is fixed
 * in `flashAlpha.ts` and named in its own test.
 */

/** A `?? <literal>` / `|| <literal>` site: what is defaulted, and to what. */
export interface LiteralDefault {
  /** The expression left of the operator, e.g. `data.bid?.[i]`. */
  operand: string;
  /** The literal it falls back to, e.g. `0` or `30`. */
  literal: string;
  /** `?? 0` or `|| 30` — the operator with its literal. */
  op: string;
  /** Stable identity: `<operand> <op>`. Survives reformatting and line moves. */
  site: string;
}

/**
 * Every numeric-literal default in a source.
 *
 * `src` should have comments stripped; `stripComments` below is the spelling
 * every caller uses.
 */
export function literalDefaults(src: string): LiteralDefault[] {
  const sites: LiteralDefault[] = [];
  const op = /(\?\?|\|\|)\s*(-?\d+(?:\.\d+)?)(?![\w.])/g;
  for (let m = op.exec(src); m; m = op.exec(src)) {
    let i = m.index - 1;
    while (i >= 0 && /\s/.test(src[i])) i--;
    const end = i + 1;
    let depth = 0;
    while (i >= 0) {
      const c = src[i];
      if (c === ')' || c === ']') { depth++; i--; continue; }
      if (c === '(' || c === '[') { if (depth === 0) break; depth--; i--; continue; }
      if (depth > 0) { i--; continue; }
      if (/[A-Za-z0-9_$.?'"]/.test(c)) { i--; continue; }
      break;
    }
    const operand = src.slice(i + 1, end);
    const opText = `${m[1]} ${m[2]}`;
    sites.push({ operand, literal: m[2]!, op: opText, site: `${operand} ${opText}` });
  }
  return sites;
}

/** Comments removed, so a `?? 0` quoted in a docstring is not a finding. */
export const stripComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');

/**
 * Words naming a *reading* — a price, a size, a greek, a ratio — where zero is
 * a value the vendor could have sent, so it cannot also mean "absent".
 *
 * This is a **hint for a reviewer**, not a gate. It was a gate once, and being
 * a hand-written word list it failed the same way the hand-written file list
 * did: it did not know `net_gex`, `max_pain`, `iv30`, `close`, Finnhub's `d`
 * and `dp`, or `monthlyDailyAverage`, and so passed five connectors that were
 * all publishing invented numbers. The ledger in `defaultedReadings.test.ts`
 * is the gate now — every site is a finding until someone writes down why it
 * is not — and this list only decides how loudly a new one is described.
 */
export const READING_WORDS = new Set([
  'bid', 'ask', 'last', 'price', 'strike', 'volume', 'size', 'oi',
  'openinterest', 'interest', 'iv', 'volatility', 'delta', 'gamma', 'theta',
  'vega', 'change', 'cap', 'high', 'low', 'spot', 'mid', 'premium',
  'underlying', 'ratio', 'gex', 'dex', 'vex', 'pain', 'wall', 'flip',
]);

/** `q.bidPrice` -> ['bid', 'price']; `data.optionSymbol?.length` -> []. */
export function readingWordsIn(expr: string): string[] {
  return expr
    .split(/[^A-Za-z0-9_$]+/)
    .flatMap((t) => t.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[\s_]+/))
    .map((w) => w.toLowerCase())
    .filter((w) => READING_WORDS.has(w));
}
