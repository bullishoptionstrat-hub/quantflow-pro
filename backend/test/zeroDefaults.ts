/**
 * Where does this source substitute a zero for a field a vendor did not send?
 *
 * One implementation, shared by `missingIsNotZero.test.ts` (coinGecko, cboe)
 * and `absentQuoteIsNotZero.test.ts` (the four chain connectors), because two
 * guards for one rule drift to different strengths — and both of them had.
 *
 * The chain guard required the field name to sit immediately left of the
 * operator, so it missed `data.bid?.[i] ?? 0` and `parseFloat(opt['bid'] ?? 0)`.
 * The older guard banned the bare `?? 0` string but first deleted every line
 * *ending* in `?? 0,` — which is an object literal's field, which is how
 * coinGecko wrote the defect it was added for — and never looked at `|| 0`.
 *
 * So: find the operator, walk backwards over balanced brackets to the
 * expression being defaulted, and ask whether that expression names a reading.
 */

/** A `?? 0` / `|| 0` site: the expression being defaulted, and its text. */
export interface ZeroDefault {
  operand: string;
  site: string;
}

export function zeroDefaults(src: string): ZeroDefault[] {
  const sites: ZeroDefault[] = [];
  const op = /(\?\?|\|\|)\s*0(?![\d.])/g;
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
    sites.push({ operand, site: `${operand} ${m[0].replace(/\s+/g, ' ')}` });
  }
  return sites;
}

/**
 * Words naming a *reading* — a price, a size, a greek, a ratio — where zero is
 * a value the vendor could have sent, so it cannot also mean "absent".
 *
 * The list is deliberately short. A zero default on an array length or a loop
 * bound is not this defect, and banning `?? 0` outright across whole files
 * fails the next person writing an honest one — that is why the rule is scoped
 * to field names at all. Do not add a word without a case in the honest table
 * of `absentQuoteIsNotZero.test.ts`; the connectors have no live `?? 0` sites,
 * so that table is the only coverage the over-breadth half of this rule has.
 */
export const READING_WORDS = new Set([
  'bid', 'ask', 'last', 'price', 'strike', 'volume', 'size', 'oi',
  'openinterest', 'interest', 'iv', 'volatility', 'delta', 'gamma', 'theta',
  'vega', 'change', 'cap', 'high', 'low', 'spot', 'mid', 'premium',
  'underlying', 'ratio',
]);

/** `q.bidPrice` -> ['bid', 'price']; `data.optionSymbol?.length` -> []. */
export function readingWordsIn(expr: string): string[] {
  return expr
    .split(/[^A-Za-z0-9_$]+/)
    .flatMap((t) => t.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[\s_]+/))
    .map((w) => w.toLowerCase())
    .filter((w) => READING_WORDS.has(w));
}

/** The reading-valued zero defaults in a connector's source, as `file: site`. */
export function zeroFilledReadings(file: string, src: string): string[] {
  return zeroDefaults(src)
    .filter(({ operand }) => readingWordsIn(operand).length > 0)
    .map(({ site }) => `${file}: ${site}`);
}
