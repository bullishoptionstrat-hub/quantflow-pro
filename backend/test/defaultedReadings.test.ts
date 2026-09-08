/**
 * Every invented default in the ingestion layer is a finding until someone
 * writes down why it is not.
 *
 * ── What this replaces ──────────────────────────────────────────────────────
 *
 * The rule "a field the vendor did not send is not a zero" was enforced by two
 * guards, each driven by a **hand-written list of files**:
 *
 *     missingIsNotZero.test.ts     ['coinGecko.ts', 'cboe.ts']
 *     absentQuoteIsNotZero.test.ts ['marketData.ts', 'yahoo.ts',
 *                                   'tastytrade.ts', 'schwab.ts']
 *
 * Six files of seventeen. The other eleven were not clean, they were
 * unexamined, and the audit that produced this file found invented numbers in
 * five of them — a gamma flip at strike 0, a market-wide options volume of 0
 * on an unauthenticated endpoint, a spot board that could not say a change was
 * unreported, an open interest of 0 rendered as fact, and a strike-0 contract
 * classified as a deep-ITM buy.
 *
 * The chain list did assert its own completeness, but only against "a
 * connector reaching `onFlowEvent` with a bid" — so `occ.ts`, which publishes
 * no flow events, and `index.ts`, which is not a connector at all, could never
 * have been caught by it. A list that checks itself is still a list.
 *
 * ── The rule ────────────────────────────────────────────────────────────────
 *
 * The default here is **failure**. Every `?? <number>` / `|| <number>` under
 * `src/ingestion/` is reported unless it appears in `LEDGER` below with a
 * reason, and every `LEDGER` entry whose site no longer exists is reported
 * too. Nobody has to remember to add a file: new code trips this by existing.
 *
 * The ledger is a ratchet. Entries should leave it as code is fixed; an entry
 * arriving is a decision someone made in writing and a reviewer can argue
 * with. Do not add one to make this pass — the entry is the argument, and
 * "guarded on the next line" is a real argument while "it is probably fine" is
 * not.
 *
 * ── Why numeric literals only ───────────────────────────────────────────────
 *
 * String defaults in this codebase are overwhelmingly labels and error text —
 * `err?.message ?? 'fetch failed'`, `exchange ?? 'UNKNOWN'` — and a ledger
 * requiring an entry for each would be rubber-stamped within a week, which is
 * worth less than no ledger. The one string default that was a market claim,
 * FlashAlpha's `dealer_regime ?? 'neutral'`, is fixed and covered by
 * `flashAlphaLevels.test.ts`.
 *
 * Scope is `src/ingestion/` because that is where vendor data enters. Route
 * handlers default query parameters (`parseInt(req.query.limit) || 50`), which
 * is a different act: the caller omitted it, no source misreported it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { literalDefaults, readingWordsIn, stripComments } from './zeroDefaults';

const INGESTION = join(__dirname, '..', 'src', 'ingestion');

/**
 * Each key is `<path under src/ingestion>: <expression> <operator> <literal>`
 * — deliberately not a line number, which every edit invalidates, and not the
 * raw source line, which reformatting does.
 */
const LEDGER: Record<string, string> = {
  // ── Guarded: the zero is read back and rejected within a few lines, so it
  // is a way of spelling "skip", not a value that reaches anyone.
  'connectors/cboeOptions.ts: numeric(d.close) ?? 0':
    'Spot for the chain, gated on `if (!(spot > 0)) return null` on the next ' +
    'line. Every GEX figure is scaled by spot squared, so a snapshot without ' +
    'one is refused rather than partially published.',
  'connectors/cboeOptions.ts: rawOi ?? 0':
    'The GEX aggregation needs a number it can multiply and gates on ' +
    '`oi > 0 && gamma !== 0`. The unusual-activity list, which *publishes* ' +
    'open interest, reads `rawOi` itself and keeps the null — one read, two ' +
    'paths, different requirements.',
  'connectors/cboeOptions.ts: numeric(r.gamma) ?? 0':
    'Same aggregation, gated on `gamma !== 0`. A contract with no gamma is ' +
    'not weighed rather than weighed at zero.',
  'connectors/cboeOptions.ts: numeric(r.volume) ?? 0':
    'Gated on `volume > 0` before the row can become an unusual contract.',
  'connectors/cboeOptions.ts: numeric(r.last_trade_price) ?? 0':
    'Gated on `last > 0` on the same condition. Notional is `volume * last * ' +
    '100`, so a row with no last price would price the day at $0.',

  // ── Not a vendor field: nothing was omitted by anyone, so there is nothing
  // to misreport.
  'connectors/reddit.ts: d.bearish || 1':
    'A divide-by-zero guard on `(bullish - bearish) / total`, where both are ' +
    'keyword counts this connector accumulated itself and are always defined. ' +
    'Posts mentioning a ticker with no directional keyword score 0, which is ' +
    'the honest reading, rather than NaN.',
  'index.ts: unparsedFrames[source] ?? 0':
    'Initialising a counter on first increment. Counting from zero is what a ' +
    'counter does.',
  'index.ts: a.ts ?? 0':
    'A sort comparator over seeded prints, giving an undefined timestamp a ' +
    'stable position rather than NaN. Nothing is published from it.',
  'index.ts: b.ts ?? 0':
    'The other side of that same comparison. Both operands need the default ' +
    'or the sort is asymmetric, which is a different bug from this one.',

  // ── Deliberately synthetic, and labelled as such on the wire.
  'index.ts: spotMap[symbol] ?? 100':
    'Inside `generateSyntheticGEX`, whose whole output is served with ' +
    "`source: 'synthetic'` and `realData: false`, and which the frontend " +
    'declines to draw. A fabricated number inside an declared fabricator is ' +
    'the honest case this repo already settled on for demo mode.',

  // ── Scoring inputs whose default cannot change an outcome. Recorded rather
  // than restructured: the reasoning is what needs to be checkable.
  'heatScore.ts: input.exchangeCount ?? 1':
    'A print happened on at least one exchange, so one is a floor rather than ' +
    'an invention. It feeds a SWEEP bonus of `(count - 1) * 5`, which is 0 here.',
  'heatScore.ts: input.iv ?? 0':
    'Reaches only `if (iv > 100 && daysToExpiry < 5) score -= 10`, the cheap- ' +
    'lotto penalty. An unknown IV cannot support that judgement, and 0 is how ' +
    'this expression spells "do not apply it". Never displayed: the wire IV ' +
    'comes from `toWireEvent`, which publishes null.',
  'heatScore.ts: input.daysToExpiry ?? 30':
    'The same branch and the same effect — 30 fails `< 5`, so the penalty is ' +
    'not applied to an expiry nobody reported. The number is arbitrary and ' +
    'that is the argument against it; it is registered rather than changed ' +
    'because every alternative is equally arbitrary and this one is inert.',
};

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [];
  });
}

/** Every numeric-literal default under `src/ingestion/`, keyed for the ledger. */
function scan(): Map<string, string> {
  const found = new Map<string, string>();
  for (const p of walk(INGESTION)) {
    const rel = p.slice(INGESTION.length + 1).split('\\').join('/');
    for (const d of literalDefaults(stripComments(readFileSync(p, 'utf8')))) {
      found.set(`${rel}: ${d.site}`, d.operand);
    }
  }
  return found;
}

test('no ingestion code invents a number without a registered reason', () => {
  const found = scan();
  const unregistered = [...found.entries()]
    .filter(([key]) => !(key in LEDGER))
    .map(([key, operand]) =>
      readingWordsIn(operand).length
        ? `${key}   <-- names a market reading (${readingWordsIn(operand).join(', ')})`
        : key);

  assert.deepEqual(unregistered, [],
    'A default is a claim: it is indistinguishable from a value the vendor ' +
    'actually sent. Fix it — make the field nullable, or drop the row — or ' +
    'add it to LEDGER with the reason it is safe. The `<--` marker means the ' +
    'expression names a price, a size or a greek, where the bar is highest.\n' +
    unregistered.join('\n'));
});

test('the ledger describes code that still exists', () => {
  // Without this the ledger rots: a site gets fixed, its excuse stays, and the
  // next reader finds a written justification for code that is not there —
  // then trusts the rest of the file slightly less. Same reason
  // `absentQuoteIsNotZero` asserts its own connector list is complete.
  const found = scan();
  const stale = Object.keys(LEDGER).filter((key) => !found.has(key));
  assert.deepEqual(stale, [],
    'these ledger entries no longer match any code — delete them, or fix the ' +
    `key if the expression was rewritten: ${stale.join(', ')}`);
});

test('every ledger entry gives an actual reason', () => {
  // "n/a", "ok", "legacy" would each pass the two tests above while defeating
  // the point of them, which is that the entry is the argument.
  for (const [key, reason] of Object.entries(LEDGER)) {
    assert.ok(reason.length > 40, `${key} needs a real justification, not "${reason}"`);
  }
});

test('the scanner recognises the forms this audit actually found', () => {
  // A guard checked once, by hand, against the one form the checker happened
  // to type is how the previous version of this rule passed while catching
  // almost nothing. These are the literal lines deleted from the connectors,
  // so the scanner cannot silently stop travelling.
  const DEFECTS: Array<[string, string]> = [
    ['bid: data.bid?.[i] ?? 0,', 'data.bid?.[i]'],
    ["const bid = parseFloat(opt['bid'] ?? 0);", "opt['bid']"],
    ["const size = opt['day-volume'] ?? 0;", "opt['day-volume']"],
    ['const bid = num(opt.bid) ?? 0;', 'num(opt.bid)'],
    ['const bid = Number(opt.bid) || 0;', 'Number(opt.bid)'],
    ['bid: q.bidPrice ?? 0,', 'q.bidPrice'],
    ['const oi = Number(r.open_interest) || 0;', 'Number(r.open_interest)'],
    ['gammaFlip: data.gamma_flip ?? 0,', 'data.gamma_flip'],
    ['volume: parseInt(q.volume ?? 0),', 'q.volume'],
    ['days_to_expiry: input.daysToExpiry ?? 30,', 'input.daysToExpiry'],
  ];
  for (const [line, operand] of DEFECTS) {
    const [site] = literalDefaults(line);
    assert.ok(site, `no default seen at all in: ${line}`);
    assert.equal(site.operand, operand, `wrong operand read from: ${line}`);
  }

  // A non-zero literal is the same defect. Scanning only for `?? 0` was itself
  // a hand-written list, of one value.
  assert.equal(literalDefaults('x: a.dte ?? 30,')[0]?.literal, '30');
  assert.equal(literalDefaults('x: a.px ?? -1,')[0]?.literal, '-1');
  assert.equal(literalDefaults('x: a.px ?? 0.5,')[0]?.literal, '0.5');

  // And what it must not read as a default: a comparison, a literal that is
  // part of a longer number, a default written into a signature.
  assert.deepEqual(literalDefaults('if (a || b > 0) {}'), []);
  assert.deepEqual(literalDefaults('const x = a ?? 0.0.toString'), []);
});

test('a reading name is a louder finding, but not the gate', () => {
  // `READING_WORDS` was the gate once and, being a hand-written word list,
  // failed the way the hand-written file list did: it did not know `net_gex`,
  // `iv30`, `max_pain`, `monthlyDailyAverage`, or Finnhub's `d` and `dp`, so
  // five connectors published invented numbers past it. It decides how a new
  // finding is described now; the ledger decides whether it is one.
  assert.ok(readingWordsIn('q.bidPrice').includes('bid'));
  assert.ok(readingWordsIn('data.gamma_flip').includes('gamma'));
  assert.deepEqual(readingWordsIn('data.optionSymbol?.length'), []);
  // The point: this returns nothing, and the site is still a finding, because
  // the ledger is keyed on the site rather than on the word list.
  assert.deepEqual(readingWordsIn('num(data?.d)'), []);
});
