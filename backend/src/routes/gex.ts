import { Router, Request, Response } from 'express';
import {
  getGEXLevels, getRealGexSymbols, getZeroDteLevels, GEXLevel,
} from '../ingestion/index';

const router = Router();

/**
 * What a reader has to know to read these numbers, carried with them.
 *
 * Every platform that sells gamma exposure ships the number bare. It is
 * modelled, not observed: a public chain shows greeks, volume and open
 * interest, and shows **nothing** about whether a dealer is long or short any
 * contract. The call-positive / put-negative convention in `gex` *is* the
 * assumption — it expresses a book that is short both — and it is the one
 * assumption nobody states.
 *
 * This is the same move as `synthetic`, `side: AMBIGUOUS` and
 * `INSUFFICIENT_SAMPLE`: say what is not known, next to the thing that depends
 * on it, rather than leaving the reader to discover it.
 */
const ASSUMPTIONS = {
  dealerPositioning:
    'GEX assumes the dealer book is short calls and short puts — that is what ' +
    'the call-positive / put-negative sign convention expresses. Open interest ' +
    'does not say who is on which side of a contract, so this is modelled, not ' +
    'observed, and a real book that differs makes these levels wrong.',
  dex:
    'DEX applies no dealer assumption at all. Delta already carries its own ' +
    'sign, so no convention is imposed and the figure is what the open ' +
    'interest itself is long or short — not "dealer delta exposure".',
  greeks:
    'Gamma and delta are Cboe\'s published per-contract values, under Cboe\'s ' +
    'pricing model and its rate and dividend inputs. Nothing here recomputes ' +
    'them, and nothing here derives a second-order greek from them.',
  secondOrder:
    'Vanna and charm are not published. Deriving them would mean inverting ' +
    'Cboe\'s delta to recover a model this codebase does not have, so they are ' +
    'absent rather than estimated.',
  staleness: 'Cboe publishes this chain on a ~15 minute delay.',
} as const;

/**
 * The gamma flip is not reported, and the previous value was not one.
 *
 * It was `the first strike i where levels[i].gex > 0 and levels[i+1].gex < 0`
 * — the first sign change in an array sorted by strike, weighted by nothing.
 * Measured against a real AAPL chain on 2026-09-15 with spot at 331.75, that
 * rule returned **80** : a strike 76% below spot carrying $1,420 of gamma, out
 * of $1.45bn on the chain. It is not a level anyone would act on and it is not
 * what the label means.
 *
 * The obvious replacement is not obviously right either. Summing GEX across
 * strikes and finding where the running total crosses zero gives 100 on that
 * same chain — still 70% below spot, and the cumulative total crosses zero
 * more than once because the far tails are noisy. The method the vendors
 * describe is a different computation again: re-evaluate total gamma at
 * hypothetical spot levels and find where *that* crosses.
 *
 * Three candidate numbers for one label, and no established basis for choosing
 * between them here. So it is `null` with the reason attached, in the same
 * spirit as `putCallUnavailable` and `INSUFFICIENT_SAMPLE` — a number that
 * cannot be sourced is not published, and a reader is told why rather than
 * shown a confident wrong one.
 */
const FLIP_UNAVAILABLE =
  'Not reported. The previous value was the first per-strike sign change in a ' +
  'strike-sorted array, which on a real chain returned a level 76% below spot ' +
  'carrying 0.0001% of the gamma. No sound method is established here yet: a ' +
  'cumulative-sum crossing and a re-evaluated-spot crossing are different ' +
  'computations and give different answers.';

function totalOf(levels: GEXLevel[], key: 'gex' | 'dex'): number {
  return levels.reduce((sum, l) => sum + l[key], 0);
}

function extremesOf(levels: GEXLevel[], key: 'gex' | 'dex') {
  if (levels.length === 0) return { maxStrike: null, max: null, minStrike: null, min: null };
  const max = levels.reduce((a, l) => (l[key] > a[key] ? l : a));
  const min = levels.reduce((a, l) => (l[key] < a[key] ? l : a));
  return { maxStrike: max.strike, max: max[key], minStrike: min.strike, min: min[key] };
}

// GET /api/gex — gamma and delta exposure by strike
router.get('/', (req: Request, res: Response) => {
  const symbol = ((req.query.symbol as string) || 'SPX').toUpperCase();
  const levels: GEXLevel[] = getGEXLevels(symbol);
  const zeroDte = getZeroDteLevels(symbol);

  // A symbol Cboe has snapshotted, with strikes to show for it. Both halves
  // matter: a snapshot whose gamma aggregation came out empty is not a chain
  // to report, and there is no longer a synthetic path that could fill it.
  const isReal = getRealGexSymbols().includes(symbol) && levels.length > 0;

  res.json({
    symbol,
    levels,
    /**
     * Same aggregation, contracts expiring on the chain's own date only.
     * `null` is the ordinary answer: measured on 2026-09-15, SPY carried 310
     * same-day contracts and SPX 484, while AAPL had none at all. Showing the
     * nearest expiry instead would relabel tomorrow as today for most of the
     * market.
     */
    zeroDte,
    flipStrike: null,
    flipUnavailable: FLIP_UNAVAILABLE,
    keyLevels: {
      gex: extremesOf(levels, 'gex'),
      dex: extremesOf(levels, 'dex'),
      totalGex: levels.length > 0 ? totalOf(levels, 'gex') : null,
      totalDex: levels.length > 0 ? totalOf(levels, 'dex') : null,
    },
    assumptions: ASSUMPTIONS,
    updatedAt: new Date().toISOString(),
    source: isReal ? 'cboe' : null,
    realData: isReal,
    // Why there is nothing, when there is nothing. Previously this case was
    // filled with `Math.random()` and flagged `realData: false`.
    unavailableReason: isReal
      ? null
      : `No Cboe chain has been received for ${symbol}. Nothing is substituted ` +
        `for it: a fabricated gamma profile is indistinguishable from a real one.`,
    realtime: false,
    delayedMinutes: isReal ? 15 : null,
  });
});

// GET /api/gex/symbols — the symbols a chain has actually been received for.
router.get('/symbols', (_req: Request, res: Response) => {
  // Was a hardcoded list of eight, four of which had no chain behind them and
  // were served synthetic levels.
  res.json({ symbols: getRealGexSymbols() });
});

export default router;
