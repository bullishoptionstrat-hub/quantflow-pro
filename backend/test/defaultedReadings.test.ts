/**
 * Every invented default in `src/` is a finding until someone writes down why
 * it is not.
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
 * ── And then this file kept one of its own ──────────────────────────────────
 *
 * The version that replaced those two scanned `src/ingestion/` and said so, in
 * writing: thirteen sites registered against thirty-one across `src/`, "so the
 * eighteen elsewhere are *unguarded by this rule*, not judged clean by it".
 *
 * That was honest and it was still a hand-drawn boundary, which is the thing
 * this file exists to argue against. Walking the eighteen found the same
 * defect the connectors had, in the module least able to afford it:
 * `supabaseStore.count()` ended `return count ?? 0`, and PostgREST returns
 * `count: null` **with no error** whenever the response carries no
 * `Content-Range`. An unanswered count was published as `total: 0` on
 * `/api/track-record` — a deployment that has recorded nothing, which is
 * precisely the failure the persistence module exists to make impossible to
 * have by accident. It is fixed, and `unansweredCount.test.ts` holds it.
 *
 * So the scope is now `src/`, entire. What is left is not a directory
 * boundary but a statement about two expressions, below.
 *
 * ── The rule ────────────────────────────────────────────────────────────────
 *
 * The default here is **failure**. Every `?? <literal>` / `|| <literal>` under
 * `src/` is reported unless it appears in `LEDGER` below with a reason, and
 * every `LEDGER` entry whose site no longer exists is reported too. Nobody has
 * to remember to add a file: new code trips this by existing.
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
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { literalDefaults, readingWordsIn, stripComments } from './zeroDefaults';

const SRC = join(__dirname, '..', 'src');

/**
 * The two expressions that are exempt by shape rather than by entry.
 *
 * Nine of the eighteen sites outside `src/ingestion/` default a **setting** or
 * a **request parameter**, and both are a different act from inventing a
 * reading: nobody misreported anything. An operator left `PORT` unset; a
 * caller omitted `?limit=`. Registering nine near-identical entries is how a
 * ledger becomes something nobody reads, which is the failure mode this file
 * warns about for string defaults and would have walked straight into here.
 *
 * **This is a hand-written list, and the reason it is allowed to be one is its
 * failure direction.** A list of files fails *silent* — an unexamined file
 * passes, which is how eleven connectors went unaudited. A pattern that is too
 * narrow fails *loud*: the site is simply unmatched, and an unmatched site is
 * a finding that someone has to answer. The dangerous error is a pattern that
 * is too **broad**, because that one is silent again — which is what the
 * `does not exempt a vendor reading` test below exists to pin, and why these
 * match a named source of input rather than anything about the literal.
 */
const NOT_A_READING: Array<{ pattern: RegExp; kind: string }> = [
  {
    pattern: /\bprocess\.env\b/,
    kind:
      'configuration — a variable this deployment did not set. The fallback ' +
      'is the documented default, not a claim about the market.',
  },
  {
    pattern: /\breq\.query\b/,
    kind:
      'a request parameter the caller omitted. The route chooses a page size; ' +
      'no source failed to report one.',
  },
];

const exemption = (operand: string) =>
  NOT_A_READING.find((e) => e.pattern.test(operand));

/**
 * Each key is `<path under src>: <expression> <operator> <literal>`
 * — deliberately not a line number, which every edit invalidates, and not the
 * raw source line, which reformatting does.
 */
const LEDGER: Record<string, string> = {
  // ── Guarded: the zero is read back and rejected within a few lines, so it
  // is a way of spelling "skip", not a value that reaches anyone.
  'ingestion/connectors/cboeOptions.ts: numeric(d.close) ?? 0':
    'Spot for the chain, gated on `if (!(spot > 0)) return null` on the next ' +
    'line. Every GEX figure is scaled by spot squared, so a snapshot without ' +
    'one is refused rather than partially published.',
  'ingestion/connectors/cboeOptions.ts: rawOi ?? 0':
    'The GEX aggregation needs a number it can multiply and gates on ' +
    '`oi > 0 && gamma !== 0`. The unusual-activity list, which *publishes* ' +
    'open interest, reads `rawOi` itself and keeps the null — one read, two ' +
    'paths, different requirements.',
  'ingestion/connectors/cboeOptions.ts: numeric(r.gamma) ?? 0':
    'Same aggregation, gated on `gamma !== 0`. A contract with no gamma is ' +
    'not weighed rather than weighed at zero.',
  'ingestion/connectors/cboeOptions.ts: numeric(r.volume) ?? 0':
    'Gated on `volume > 0` before the row can become an unusual contract.',
  'ingestion/connectors/cboeOptions.ts: numeric(r.last_trade_price) ?? 0':
    'Gated on `last > 0` on the same condition. Notional is `volume * last * ' +
    '100`, so a row with no last price would price the day at $0.',

  // ── Not a vendor field: nothing was omitted by anyone, so there is nothing
  // to misreport.
  'ingestion/connectors/reddit.ts: d.bearish || 1':
    'A divide-by-zero guard on `(bullish - bearish) / total`, where both are ' +
    'keyword counts this connector accumulated itself and are always defined. ' +
    'Posts mentioning a ticker with no directional keyword score 0, which is ' +
    'the honest reading, rather than NaN.',
  'ingestion/index.ts: unparsedFrames[source] ?? 0':
    'Initialising a counter on first increment. Counting from zero is what a ' +
    'counter does.',
  'ingestion/index.ts: a.ts ?? 0':
    'A sort comparator over seeded prints, giving an undefined timestamp a ' +
    'stable position rather than NaN. Nothing is published from it.',
  'ingestion/index.ts: b.ts ?? 0':
    'The other side of that same comparison. Both operands need the default ' +
    'or the sort is asymmetric, which is a different bug from this one.',

  // ── Deliberately synthetic, and labelled as such on the wire.
  'ingestion/index.ts: spotMap[symbol] ?? 100':
    'Inside `generateSyntheticGEX`, whose whole output is served with ' +
    "`source: 'synthetic'` and `realData: false`, and which the frontend " +
    'declines to draw. A fabricated number inside an declared fabricator is ' +
    'the honest case this repo already settled on for demo mode.',

  // ── Scoring inputs whose default cannot change an outcome. Recorded rather
  // than restructured: the reasoning is what needs to be checkable.
  'ingestion/heatScore.ts: input.exchangeCount ?? 1':
    'A print happened on at least one exchange, so one is a floor rather than ' +
    'an invention. It feeds a SWEEP bonus of `(count - 1) * 5`, which is 0 here.',
  'ingestion/heatScore.ts: input.iv ?? 0':
    'Reaches only `if (iv > 100 && daysToExpiry < 5) score -= 10`, the cheap- ' +
    'lotto penalty. An unknown IV cannot support that judgement, and 0 is how ' +
    'this expression spells "do not apply it". Never displayed: the wire IV ' +
    'comes from `toWireEvent`, which publishes null.',
  'ingestion/heatScore.ts: input.daysToExpiry ?? 30':
    'The same branch and the same effect — 30 fails `< 5`, so the penalty is ' +
    'not applied to an expiry nobody reported. The number is arbitrary and ' +
    'that is the argument against it; it is registered rather than changed ' +
    'because every alternative is equally arbitrary and this one is inert.',

  // ── The flow engine. Note this is the *vendored* copy: it is held
  // byte-identical to `quantflow-modules/flow-engine` by `vendorMirror.test.ts`,
  // so a fix to any of these is two edits, not one. All three are registered
  // rather than changed.
  'flow-engine/engine.ts: this.repeatHits.get(repeatKey) ?? 0':
    'A miss on the repeat-hit map means this contract and side have not been ' +
    'seen in the window, and zero prior hits is the true reading of that — ' +
    'not a substitute for one. The map is written only by this class.',
  'flow-engine/score.ts: input.repeatHits ?? 0':
    'The receiving end of the same count. `b.repeats` is a laddered bonus ' +
    'starting at `hits >= 1`, so an absent count scores 0 and can only ' +
    'withhold credit, never award it.',
  'flow-engine/score.ts: dayVol ?? 0':
    'An unknown day volume makes `volAfter` just this trade, which is the ' +
    'smallest value it could take, so the vol-over-OI band it lands in can ' +
    'only be lower. It matches the `unknown OI never inflates the score` rule ' +
    'stated three lines below it: a missing reading may cost a signal points ' +
    'and may never earn it any.',

  // ── Counters and set membership. A key absent from a map the process built
  // itself was counted zero times, which is a fact rather than a stand-in.
  'persistence/recorder.ts: this.stats.refusalsByDataset[k] ?? 0':
    'Initialising a per-dataset refusal counter on its first increment. The ' +
    'object is private to the recorder and the zero is the count before this ' +
    'refusal, which is what it was.',
  'persistence/supabaseStore.ts: counts.get(o.signal_key) ?? 0':
    'The same `+ 1` idiom, building a per-signal outcome tally from rows this ' +
    'query just returned. First sighting of a key means none counted yet.',
  'persistence/supabaseStore.ts: counts.get(r.signalKey) ?? 0':
    'Reads that tally back to find signals with fewer than four graded ' +
    'horizons. A signal absent from the map has no outcome rows at all, so ' +
    'zero is its real count and the row belongs in the ungraded list.',

  // ── Defended by the schema rather than by the code.
  'persistence/supabaseStore.ts: d.latency_ms ?? 0':
    'The column is `latency_ms integer not null default 0` in ' +
    'migrations/20260829120000_signal_history.sql, and every path into this ' +
    "mapper selects `*`, so no row this store wrote can reach it null. Kept " +
    'as a type-narrowing convenience with the schema as the actual guarantee ' +
    '— if that column ever becomes nullable, this line starts inventing a ' +
    'zero-latency decision and the entry stops being true.',

  // ── Caller-supplied options. Same act as a request parameter, but the
  // operand names a local `opts` bag and so cannot be recognised by shape.
  'enrichment/firecrawl/client.ts: opts.limit ?? 5':
    'How many search results to ask Firecrawl for when the caller did not ' +
    'say. It is an argument to the request, not a value read back out of the ' +
    'response — nothing is being reported as 5.',
  'enrichment/firecrawl/enrichment.service.ts: opts.documentTtlSeconds ?? 6':
    'The `6` is the first token of `6 * 3600` — a six-hour cache TTL for ' +
    'regulatory documents, chosen by the service when its constructor was ' +
    'given no override. A cache lifetime is a policy, not a measurement.',
  'enrichment/firecrawl/enrichment.service.ts: opts.newsTtlSeconds ?? 15':
    'Likewise the `15` of `15 * 60`: news context is re-fetched every fifteen ' +
    'minutes absent an override. Shorter than the document TTL because news ' +
    'moves and FINRA pages do not.',
};

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [];
  });
}

/** Every numeric-literal default under `src/`, keyed for the ledger. */
function scan(): Map<string, string> {
  const found = new Map<string, string>();
  for (const p of walk(SRC)) {
    const rel = p.slice(SRC.length + 1).split('\\').join('/');
    for (const d of literalDefaults(stripComments(readFileSync(p, 'utf8')))) {
      found.set(`${rel}: ${d.site}`, d.operand);
    }
  }
  return found;
}

test('no code in src/ invents a number without a registered reason', () => {
  const found = scan();
  const unregistered = [...found.entries()]
    .filter(([key, operand]) => !(key in LEDGER) && !exemption(operand))
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

test('the shape exemptions are load-bearing, so each one must still match', () => {
  // An exemption nothing matches is an exemption that quietly stopped
  // applying — the same rot the stale-entry test catches in the ledger. If
  // `req.query` defaults are all gone one day, this fails and the rule gets
  // narrower on purpose rather than by neglect.
  const operands = [...scan().values()];
  for (const { pattern, kind } of NOT_A_READING) {
    assert.ok(operands.some((o) => pattern.test(o)),
      `nothing in src/ matches ${pattern} any more — delete the exemption ` +
      `rather than leaving a standing permission for "${kind}"`);
  }
});

test('an exemption does not exempt a vendor reading', () => {
  // The failure direction that matters. A pattern too narrow leaves a site
  // unmatched, and unmatched is a finding somebody answers. A pattern too
  // broad is silent, and silence is what this whole file was written against
  // — so the expressions that must never be exempt are named here.
  const MUST_BE_FINDINGS = [
    'q.bidPrice',
    'numeric(r.gamma)',
    'data.gamma_flip',
    'count',                        // supabaseStore's, the one this widening found
    'num(data?.d)',
    'parseInt(q.volume)',
    'opt[\'day-volume\']',
  ];
  for (const operand of MUST_BE_FINDINGS) {
    assert.equal(exemption(operand), undefined,
      `${operand} would be waved through by a shape exemption`);
  }

  // And the two that are exempt, in the forms they actually appear in — both
  // wrapped in a parse, which is why the patterns look for the source of the
  // value and not for the whole expression.
  assert.ok(exemption('Number(process.env.PORT)'));
  assert.ok(exemption("parseInt(process.env.TRUST_PROXY_HOPS || '1', 10)"));
  assert.ok(exemption('parseFloat(req.query.minPremium as string)'));
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
    // The one the widening found, in the form it was written.
    ['    return count ?? 0;', 'count'],
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
  // `count` is the same lesson from the widening — no reading word in it at
  // all, and it was publishing a fabricated track record.
  assert.deepEqual(readingWordsIn('count'), []);
});
