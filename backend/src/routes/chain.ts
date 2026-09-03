import { Router, Request, Response } from 'express';
import axios from 'axios';
import { describeHttpError } from '../ingestion/httpError';

/**
 * The option chain, from Tradier or not at all.
 *
 * This route used to answer every failure with a fabricated chain.
 * `buildMockChain` produced twenty strikes of `Math.random()` — bids, asks,
 * volume, open interest, gamma, theta, vega and **implied volatility** — around
 * a hardcoded 2024 spot map (SPY 580, NVDA 140, TSLA 250, SPX 5800), and it was
 * returned in three cases: no `TRADIER_TOKEN`, a Tradier error of any kind, and
 * — for `/expirations` — with **no marker at all**, since that response shape
 * carries no `source` field. A revoked token, a rate limit or a timeout
 * produced a complete chain of invented prices behind `requireAuth`, which is
 * the tier this repo reserves for entitled vendor data.
 *
 * That is the finding `deadSources.test.ts` exists for, applied to a route
 * rather than a connector: **a source that is down must never present itself as
 * data.** Stooq's browser-challenge page became twelve quotes priced at zero;
 * Cboe's 403 became a put/call ratio of 0.00 in green. This was the same shape
 * with more digits.
 *
 * The numbers were not even internally consistent. `bid` and `ask` drew
 * *independent* random terms, so ask came in below bid — a crossed market — on
 * roughly half the strikes; `Math.max(0, …)` flattened a whole wing to a zero
 * bid and a zero ask; and a call's `delta` is `0.5 - (k - spot) / (spot * 0.1)`,
 * which is unbounded below, so far-OTM calls carried deltas past -3. The spot
 * map disagreed with the frontend's deleted one about NVDA by a factor of ten,
 * because one was written before the split and one after.
 *
 * Deleted rather than flagged, like `generateSeedFlow`, `generateDarkPool` and
 * the ticker tape's `generateQuotes` before it. Flagging would not have helped:
 * `/api/chain` sits on plain `requireAuth` and is never served to demo traffic,
 * so the mock could only ever reach a signed-in reader who had every reason to
 * think the chain was real. Nothing in the frontend calls this route today,
 * which is exactly when a fabricator is cheapest to remove.
 */

const router = Router();

const TRADIER_TOKEN = process.env.TRADIER_TOKEN || '';
const TRADIER_BASE = 'https://api.tradier.com/v1';

/**
 * No credential is a configuration answer, not an outage, and it names the
 * variable that fixes it — the same contract `markNoCredentials()` gives every
 * connector on `/api/health`.
 */
function noCredentials(res: Response): void {
  res.status(503).json({
    error: 'chain_unavailable',
    reason: 'No options chain vendor is configured.',
    credential: 'TRADIER_TOKEN',
  });
}

/** The vendor's own words, scrubbed of anything credential-shaped. */
function vendorFailed(res: Response, err: unknown): void {
  const reason = describeHttpError(err);
  console.error('[chain] tradier error:', reason);
  res.status(502).json({ error: 'chain_unavailable', reason, source: 'tradier' });
}

// GET /api/chain?symbol=SPY&expiration=2025-01-17
router.get('/', async (req: Request, res: Response) => {
  const symbol = ((req.query.symbol as string) || 'SPY').toUpperCase();
  const expiration = (req.query.expiration as string) || '';

  if (!TRADIER_TOKEN) return noCredentials(res);

  try {
    const url = `${TRADIER_BASE}/markets/options/chains`;
    const { data } = await axios.get(url, {
      headers: { Authorization: `Bearer ${TRADIER_TOKEN}`, Accept: 'application/json' },
      params: { symbol, expiration, greeks: 'true' },
      timeout: 8000,
    });

    const options = data?.options?.option ?? [];
    const calls = options.filter((o: any) => o.option_type === 'call');
    const puts = options.filter((o: any) => o.option_type === 'put');

    const strikes = [...new Set(options.map((o: any) => o.strike))].sort(
      (a: any, b: any) => (a as number) - (b as number)
    );

    res.json({ symbol, expiration, strikes, calls, puts, source: 'tradier' });
  } catch (err: unknown) {
    vendorFailed(res, err);
  }
});

// GET /api/chain/expirations?symbol=SPY
router.get('/expirations', async (req: Request, res: Response) => {
  const symbol = ((req.query.symbol as string) || 'SPY').toUpperCase();

  if (!TRADIER_TOKEN) return noCredentials(res);

  try {
    const { data } = await axios.get(`${TRADIER_BASE}/markets/options/expirations`, {
      headers: { Authorization: `Bearer ${TRADIER_TOKEN}`, Accept: 'application/json' },
      params: { symbol, includeAllRoots: 'true' },
      timeout: 5000,
    });

    const dates = data?.expirations?.date ?? [];
    res.json({ symbol, expirations: Array.isArray(dates) ? dates : [dates], source: 'tradier' });
  } catch (err: unknown) {
    // `generateExpirations()` answered here, rolling eight Fridays forward from
    // today. Unlike the chain it carried no `source`, so the response was
    // indistinguishable from Tradier's — and an expiration Tradier does not
    // list is a chain request that will fail, or worse, quietly return nothing.
    vendorFailed(res, err);
  }
});

export default router;
