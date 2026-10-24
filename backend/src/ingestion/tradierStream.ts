/**
 * Tradier's options path: which contracts to subscribe to, and how a timesale
 * becomes a print.
 *
 * Three defects made the Tradier stream unable to deliver a single options
 * print, whatever the account was entitled to. None was visible, because the
 * session mint has never succeeded from this repo, so the code past it has
 * never run.
 *
 *   1. **It subscribed to underlyings.** The subscription sent
 *      `['SPY', 'QQQ', 'SPX', …]`. Tradier's stream takes "equity or option"
 *      symbols and streams events *for the symbols subscribed*, so that is a
 *      subscription to SPY's own trades — and `processMarketTick` drops every
 *      event whose symbol is not shaped like an option contract. A funded
 *      account would have streamed equity ticks into a filter that discards
 *      them, and reported `connected`.
 *   2. **It read `trade` events and dropped `timesale`.** A timesale carries
 *      `last`, not `price`, so the `!data.price` guard rejected every one.
 *      The `trade` events that survived carry no bid or ask, so even had an
 *      option print arrived, every one would have been AMBIGUOUS. The timesale
 *      is the record that carries the quote alongside the execution — and its
 *      `cancel` / `correction` flags, which the old path never read.
 *   3. **The root became the underlying.** The parser took the OCC root as the
 *      symbol, so an SPXW contract was filed under an underlying called "SPXW"
 *      — and building identity from the underlying instead would merge an
 *      AM-settled SPX monthly with the PM-settled SPXW weekly sharing its date
 *      and strike, which are different contracts.
 *
 * What is established and what is not. Tradier's documentation, as surfaced
 * by search on 2026-10-24 (the hosts are refused by this environment's egress
 * policy), shows the subscription taking equity or option symbols, a timesale
 * payload with `bid`, `ask`, `last`, `size`, `date`, `seq`, `exch`, `cancel`,
 * `correction` and `session`, and no published per-session symbol limit — with
 * a request not to subscribe to "an entire exchange's worth". The chain fields
 * read below (`symbol`, `underlying`, `root_symbol`, `strike`, `option_type`,
 * `expiration_date`) are Tradier's documented chain shape, not measured: no
 * production token has been held here. Every mapping in this file is
 * therefore SEARCH_ONLY until a live session runs it, and the unit tests drive
 * the documented shapes rather than the vendor.
 */
import type { RawPrint } from './flowEngineAdapter';
import { expiryInstantMs } from '../flow-engine/expiry';
import { describeHttpError } from './httpError';

/**
 * Which contracts are subscribed. A stated rule, because it is a scoping
 * decision about the record: a signal on a contract outside the universe is
 * never observed, so the track record describes this universe and no other.
 * It is published on `/api/health` for that reason.
 *
 * The numbers are a first, conservative cut chosen to stay well inside a limit
 * Tradier does not publish: the two nearest expirations, strikes within 5% of
 * the underlying's last price, and at most 100 contracts per underlying,
 * nearest-to-spot first.
 */
export const UNIVERSE_RULE: UniverseRule = Object.freeze({
  expirationsPerUnderlying: 2,
  strikeBand: 0.05,
  maxPerUnderlying: 100,
});

export interface UniverseRule {
  readonly expirationsPerUnderlying: number;
  readonly strikeBand: number;
  readonly maxPerUnderlying: number;
}

/**
 * The rule as the deployment configured it, or the problems that stop it.
 *
 * Each field has an environment variable (declared in `render.yaml`) and the
 * default above when unset. A value that is set and unreadable — `0`, `ten`,
 * a band of `5` meaning five percent — is a PROBLEM, not a fallback: the
 * universe decides what the record can ever contain, so a typo silently
 * replaced with the default would change the study's coverage with nothing on
 * any surface saying so. The caller refuses to subscribe while there are
 * problems, and says why on `/api/health`.
 */
export function universeRuleFromEnv(env: NodeJS.ProcessEnv): { rule: UniverseRule; problems: string[] } {
  const problems: string[] = [];
  // Each variable is read by its literal name (`env.X`) so the Blueprint drift
  // check can see that the code reads what `render.yaml` declares.
  const read = (name: string, raw: string | undefined, fallback: number, ok: (n: number) => boolean, what: string): number => {
    if (raw === undefined || raw.trim() === '') return fallback;
    const n = Number(raw.trim());
    if (!Number.isFinite(n) || !ok(n)) {
      problems.push(`${name}=${JSON.stringify(raw)} is not ${what}`);
      return fallback;
    }
    return n;
  };
  const rule: UniverseRule = {
    expirationsPerUnderlying: read('TRADIER_UNIVERSE_EXPIRATIONS', env.TRADIER_UNIVERSE_EXPIRATIONS, UNIVERSE_RULE.expirationsPerUnderlying,
      (n) => Number.isInteger(n) && n >= 1 && n <= 12, 'a whole number of expirations from 1 to 12'),
    strikeBand: read('TRADIER_UNIVERSE_STRIKE_BAND', env.TRADIER_UNIVERSE_STRIKE_BAND, UNIVERSE_RULE.strikeBand,
      (n) => n > 0 && n <= 0.5, 'a fraction of spot above 0 and at most 0.5 (0.05 is 5%)'),
    maxPerUnderlying: read('TRADIER_UNIVERSE_MAX_PER_UNDERLYING', env.TRADIER_UNIVERSE_MAX_PER_UNDERLYING, UNIVERSE_RULE.maxPerUnderlying,
      (n) => Number.isInteger(n) && n >= 1 && n <= 1000, 'a whole number of contracts from 1 to 1000'),
  };
  return { rule, problems };
}

/**
 * What the universe does NOT cover, in words, published beside it. A record
 * built from this stream describes this subset of the options market and
 * nothing wider; a hit rate computed from it is not a statement about options
 * flow in general.
 */
export function coverageStatement(rule: UniverseRule, underlyings: readonly string[]): string {
  return `Observes only ${underlyings.join(', ')}; for each, only the ${rule.expirationsPerUnderlying} nearest `
    + `listed expiration(s) and strikes within ${(rule.strikeBand * 100).toFixed(1)}% of the last price, `
    + `at most ${rule.maxPerUnderlying} contracts nearest that price. Longer-dated contracts, far `
    + `out-of-the-money strikes and every other underlying are never observed, so a signal on them `
    + `cannot appear in the record. The universe is rebuilt every 30 minutes, so it follows the price.`;
}

export interface UniverseContract {
  /** The OCC symbol Tradier streams under, e.g. `SPXW261016C05500000`. */
  symbol: string;
  underlying: string;
  root: string;
  strike: number;
  right: 'C' | 'P';
  expiry: string;
}

/** A chain row as Tradier documents it. Every field is optional until read. */
export interface TradierChainRow {
  symbol?: unknown;
  underlying?: unknown;
  root_symbol?: unknown;
  strike?: unknown;
  option_type?: unknown;
  expiration_date?: unknown;
}

const OCC = /^([A-Z][A-Z0-9]{0,5})(\d{6})([CP])(\d{8})$/;
const ROOT = /^[A-Z][A-Z0-9]{0,5}$/;

/** Tradier returns a bare object where a one-element array is meant. */
export function asArray<T>(x: T | T[] | null | undefined): T[] {
  if (x === null || x === undefined) return [];
  return Array.isArray(x) ? x : [x];
}

/** The `n` nearest listed expirations on or after `today` (YYYY-MM-DD). */
export function nearestExpirations(dates: readonly string[], today: string, n: number): string[] {
  return [...new Set(dates)]
    .filter((d) => !Number.isNaN(expiryInstantMs(d)) && d >= today)
    .sort()
    .slice(0, n);
}

/**
 * Read one chain row into a contract, or `null` when any part of it cannot be
 * established. The row's own fields are cross-checked against its OCC symbol:
 * a symbol that disagrees with the strike, right or expiry printed beside it
 * is not a contract this code can name.
 */
export function contractFromRow(row: TradierChainRow): UniverseContract | null {
  const symbol = typeof row.symbol === 'string' ? row.symbol.trim() : '';
  const m = OCC.exec(symbol);
  if (!m) return null;
  const [, occRoot, yymmdd, occRight, strike8] = m;
  const underlying = typeof row.underlying === 'string' ? row.underlying.trim().toUpperCase() : '';
  const root = typeof row.root_symbol === 'string' ? row.root_symbol.trim().toUpperCase() : occRoot!;
  const strike = typeof row.strike === 'number' ? row.strike : Number(row.strike);
  const right = row.option_type === 'call' ? 'C' : row.option_type === 'put' ? 'P' : null;
  const expiry = typeof row.expiration_date === 'string' ? row.expiration_date : '';
  if (!ROOT.test(underlying) || !ROOT.test(root) || root !== occRoot) return null;
  if (!(strike > 0) || right === null || right !== occRight) return null;
  if (Number.isNaN(expiryInstantMs(expiry))) return null;
  if (expiry.slice(2).split('-').join('') !== yymmdd) return null;
  if (Math.round(strike * 1000) !== Number(strike8)) return null;
  return { symbol, underlying, root, strike, right, expiry };
}

/**
 * The rule applied to one underlying's chain: strikes within the band of
 * `spot`, nearest first, capped. Ties keep calls before puts and the lower
 * strike first, so the same chain always yields the same universe.
 */
export function selectContracts(
  rows: readonly TradierChainRow[], spot: number, rule: UniverseRule = UNIVERSE_RULE,
): { contracts: UniverseContract[]; unreadable: number } {
  if (!(spot > 0)) return { contracts: [], unreadable: 0 };
  let unreadable = 0;
  const inBand: UniverseContract[] = [];
  for (const r of rows) {
    const c = contractFromRow(r);
    if (!c) { unreadable++; continue; }
    if (Math.abs(c.strike - spot) / spot <= rule.strikeBand) inBand.push(c);
  }
  inBand.sort((a, b) =>
    Math.abs(a.strike - spot) - Math.abs(b.strike - spot)
    || a.expiry.localeCompare(b.expiry)
    || a.strike - b.strike
    || a.right.localeCompare(b.right));
  return { contracts: inBand.slice(0, rule.maxPerUnderlying), unreadable };
}

/** A GET against Tradier's REST API, injected so the builder runs without a network. */
export type TradierGet = (path: string, params: Record<string, string>) => Promise<any>;

export interface UniverseReport {
  rule: UniverseRule;
  builtAt: number;
  contracts: number;
  perUnderlying: Record<string, number>;
  /** Underlyings that contributed nothing, and why. A universe missing a name is a coverage fact. */
  failures: Record<string, string>;
  unreadableRows: number;
}

/** Build the universe for `underlyings`, one quote request and per-expiry chain requests. */
export async function buildUniverse(
  get: TradierGet, underlyings: readonly string[], today: string, rule: UniverseRule = UNIVERSE_RULE,
): Promise<{ contracts: Map<string, UniverseContract>; report: UniverseReport }> {
  const contracts = new Map<string, UniverseContract>();
  const report: UniverseReport = {
    rule, builtAt: Date.now(), contracts: 0, perUnderlying: {}, failures: {}, unreadableRows: 0,
  };

  let spots = new Map<string, number>();
  try {
    const q = await get('/v1/markets/quotes', { symbols: underlyings.join(',') });
    spots = new Map(asArray<any>(q?.quotes?.quote)
      .map((r) => [String(r?.symbol ?? '').toUpperCase(), Number(r?.last)] as [string, number])
      .filter(([s, p]) => s.length > 0 && p > 0));
  } catch (err) {
    for (const u of underlyings) report.failures[u] = `quote request failed: ${describeHttpError(err)}`;
    return { contracts, report };
  }

  for (const u of underlyings) {
    const spot = spots.get(u);
    if (spot === undefined) { report.failures[u] = 'no last price in the quote response'; continue; }
    try {
      const ex = await get('/v1/markets/options/expirations', { symbol: u });
      const dates = nearestExpirations(asArray<string>(ex?.expirations?.date), today, rule.expirationsPerUnderlying);
      if (dates.length === 0) { report.failures[u] = 'no listed expiration on or after today'; continue; }
      const rows: TradierChainRow[] = [];
      for (const d of dates) {
        const ch = await get('/v1/markets/options/chains', { symbol: u, expiration: d });
        rows.push(...asArray<TradierChainRow>(ch?.options?.option));
      }
      const { contracts: picked, unreadable } = selectContracts(rows, spot, rule);
      report.unreadableRows += unreadable;
      if (picked.length === 0) { report.failures[u] = 'no readable contract within the strike band'; continue; }
      for (const c of picked) contracts.set(c.symbol, c);
      report.perUnderlying[u] = picked.length;
    } catch (err) {
      report.failures[u] = `chain request failed: ${describeHttpError(err)}`;
    }
  }
  report.contracts = contracts.size;
  return { contracts, report };
}

export type TimesaleRefusal = 'NOT_TIMESALE' | 'CANCEL' | 'CORRECTION' | 'NOT_SUBSCRIBED' | 'MALFORMED';

const flag = (v: unknown) => v === true || v === 'true';
const num = (v: unknown): number | undefined => {
  if (v === null || v === undefined || v === '') return undefined;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : undefined;
};

/**
 * One streamed event, as a print or as the reason it is not one.
 *
 * Cancels and corrections are refused here rather than ingested. This path
 * enters the engine through `ingestPrint`, which has no notion of a later
 * record withdrawing an earlier one — that is Event Model V2's job, and this
 * stream is not wired through it yet. Ingesting a cancel as a trade would
 * count a busted print twice over; refusing it, counted, is the honest
 * minimum until it is.
 *
 * A timesale's own `date` is the trade time; a record without one is refused
 * rather than stamped with receipt time, which would assert a trade instant
 * the vendor did not state. Its `bid`/`ask` are published under the same
 * instant: the payload offers no separate quote time, and the engine refuses
 * only a quote stamped *after* the trade.
 */
export function timesaleToPrint(
  data: any, universe: ReadonlyMap<string, UniverseContract>,
): { print: RawPrint } | { refused: TimesaleRefusal } {
  if (data?.type !== 'timesale') return { refused: 'NOT_TIMESALE' };
  if (flag(data.cancel)) return { refused: 'CANCEL' };
  if (flag(data.correction)) return { refused: 'CORRECTION' };
  const c = universe.get(String(data.symbol ?? ''));
  if (!c) return { refused: 'NOT_SUBSCRIBED' };
  const price = num(data.last);
  const size = num(data.size);
  const ts = num(data.date);
  if (!(price! > 0) || !(size! > 0) || !Number.isInteger(size) || !(ts! > 0)) return { refused: 'MALFORMED' };
  const bid = num(data.bid);
  const ask = num(data.ask);
  return {
    print: {
      id: `tradier-${c.symbol}-${ts}-${data.seq ?? ''}`,
      ts,
      symbol: c.underlying,
      root: c.root,
      expiry: c.expiry,
      strike: c.strike,
      right: c.right,
      price: price!,
      size: size!,
      exchange: typeof data.exch === 'string' && data.exch ? data.exch : 'UNKNOWN',
      bid,
      ask,
      quoteTs: bid !== undefined && ask !== undefined ? ts : undefined,
      source: 'tradier',
    },
  };
}

/** The subscription frame: option contracts, timesales only. */
export function subscriptionFrame(symbols: readonly string[], sessionid: string): string {
  return JSON.stringify({ symbols: [...symbols], sessionid, linebreak: true, filter: ['timesale'] });
}

// ─── Live validation ─────────────────────────────────────────────────────────

/**
 * Whether the stream is delivering what it claims to, judged on what arrived.
 *
 * A connected socket is not evidence of working market data: F-23 was a
 * stream that would have reported `connected` while delivering nothing usable.
 * So before a single Tradier signal enters the append-only record, the prints
 * themselves are checked — over a rolling window, so a feed that degrades
 * mid-session loses its standing rather than keeping one it earned earlier.
 *
 * The thresholds are stated rather than tuned: they are the first cut, chosen
 * to catch a broken mapping (no quotes, crossed books, prices nowhere near the
 * quote, timestamps in the wrong unit or a different day) rather than to grade
 * a feed's quality. Every one is published with what was observed.
 */
export const VALIDATION_RULE = Object.freeze({
  /** Prints needed before any verdict other than AWAITING_DATA. */
  minPrints: 50,
  /** Rolling window the checks are computed over. */
  window: 500,
  /** Share of prints that must carry a two-sided quote (side inference needs one). */
  minQuoted: 0.8,
  /** Share of quoted prints whose book may be crossed (bid > ask). */
  maxCrossed: 0.01,
  /** Share of quoted prints whose price must sit in [bid/2, ask*2] — a broken mapping lands far outside. */
  minPlausiblePrice: 0.95,
  /** Share of prints whose trade time must be within this of receipt. */
  minTimely: 0.95,
  maxClockSkewMs: 5 * 60_000,
  /** Refused records (unsubscribed or malformed) as a share of all timesales. */
  maxRefusedShare: 0.05,
});

export type ValidationState = 'NOT_STARTED' | 'AWAITING_DATA' | 'VALIDATED' | 'FAILING';

export interface ValidationCheck {
  name: string;
  pass: boolean;
  observed: string;
  required: string;
}

export interface ValidationReport {
  state: ValidationState;
  /** Why a Tradier signal is or is not admitted to the record right now. */
  recording: 'ADMITTED' | 'HELD';
  printsSeen: number;
  checks: ValidationCheck[];
  universe: { contracts: number; problems: string[] };
  basis: string;
}

interface Sample { quoted: boolean; crossed: boolean; plausible: boolean; timely: boolean }

export class TradierValidator {
  private samples: Sample[] = [];
  private refused = 0;
  private total = 0;
  private universeProblems: string[] = ['no universe has been built'];
  private universeSize = 0;

  constructor(private readonly rule = VALIDATION_RULE) {}

  /** The universe itself must be sane before any print is judged. */
  observeUniverse(contracts: ReadonlyMap<string, UniverseContract>, today: string): void {
    const problems: string[] = [];
    if (contracts.size === 0) problems.push('the universe is empty');
    for (const [sym, c] of contracts) {
      if (sym !== c.symbol || contractFromRow({
        symbol: c.symbol, underlying: c.underlying, root_symbol: c.root, strike: c.strike,
        option_type: c.right === 'C' ? 'call' : 'put', expiration_date: c.expiry,
      }) === null) problems.push(`${sym} is not a well-formed contract`);
      else if (c.expiry < today) problems.push(`${sym} expired before ${today}`);
      if (problems.length >= 5) break;
    }
    this.universeProblems = problems;
    this.universeSize = contracts.size;
  }

  observeRefusal(kind: TimesaleRefusal): void {
    if (kind === 'NOT_TIMESALE') return;
    this.total++;
    if (kind === 'NOT_SUBSCRIBED' || kind === 'MALFORMED') this.refused++;
  }

  observePrint(p: RawPrint, receivedAt: number): void {
    this.total++;
    const quoted = p.bid !== undefined && p.ask !== undefined && p.ask > 0;
    const crossed = quoted && p.bid! > p.ask!;
    const plausible = quoted && p.price >= p.bid! / 2 && p.price <= p.ask! * 2;
    const timely = p.ts !== undefined && Math.abs(receivedAt - p.ts) <= this.rule.maxClockSkewMs;
    this.samples.push({ quoted, crossed, plausible, timely });
    if (this.samples.length > this.rule.window) this.samples.shift();
  }

  report(): ValidationReport {
    const r = this.rule;
    const n = this.samples.length;
    const share = (k: keyof Sample, of = this.samples) => (of.length ? of.filter((x) => x[k]).length / of.length : 0);
    const quoted = this.samples.filter((x) => x.quoted);
    const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
    const refusedShare = this.total ? this.refused / this.total : 0;
    const checks: ValidationCheck[] = [
      { name: 'universe', pass: this.universeProblems.length === 0,
        observed: this.universeProblems.length ? this.universeProblems.join('; ') : `${this.universeSize} well-formed, unexpired contracts`,
        required: 'a non-empty universe of well-formed, unexpired contracts' },
      { name: 'quoted', pass: share('quoted') >= r.minQuoted, observed: pct(share('quoted')), required: `>= ${pct(r.minQuoted)} of prints carry bid and ask` },
      { name: 'uncrossed', pass: quoted.length > 0 && share('crossed', quoted) <= r.maxCrossed, observed: pct(share('crossed', quoted)), required: `<= ${pct(r.maxCrossed)} of quoted prints have bid > ask` },
      { name: 'plausible-price', pass: quoted.length > 0 && share('plausible', quoted) >= r.minPlausiblePrice, observed: pct(share('plausible', quoted)), required: `>= ${pct(r.minPlausiblePrice)} of quoted prints priced within [bid/2, ask*2]` },
      { name: 'timely', pass: share('timely') >= r.minTimely, observed: pct(share('timely')), required: `>= ${pct(r.minTimely)} of prints stamped within ${r.maxClockSkewMs / 60_000} min of receipt` },
      { name: 'identities', pass: refusedShare <= r.maxRefusedShare, observed: pct(refusedShare), required: `<= ${pct(r.maxRefusedShare)} of timesales unsubscribed or malformed` },
    ];
    let state: ValidationState;
    if (this.universeSize === 0 && this.total === 0) state = 'NOT_STARTED';
    else if (!checks[0]!.pass) state = 'FAILING';
    else if (n < r.minPrints) state = 'AWAITING_DATA';
    else state = checks.every((c) => c.pass) ? 'VALIDATED' : 'FAILING';
    return {
      state,
      recording: state === 'VALIDATED' ? 'ADMITTED' : 'HELD',
      printsSeen: n,
      checks,
      universe: { contracts: this.universeSize, problems: this.universeProblems },
      basis: `Judged on the last ${r.window} prints; no verdict before ${r.minPrints}. A connected stream is not `
        + `evidence of working market data, so Tradier signals are held out of the append-only record until `
        + `this reads VALIDATED, and held again if it stops doing so.`,
    };
  }
}
