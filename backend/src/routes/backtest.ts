/**
 * POST /api/backtest — how a scanner filter's signals actually performed.
 *
 * Tradytics' pitch, in this architecture: a filter over `signal_history`
 * joined to `signal_outcomes`, graded once by the grader and read back through
 * the same sample-gated, honesty-flagged tally that answers
 * `/api/track-record`. Roadmap 4.1–4.3. The store does the work; this route's
 * only job is to turn a request body into a validated `ScannerFilter` and
 * refuse a malformed one rather than quietly ignoring the bad field.
 *
 * POST, not GET: a filter is a small structured document (sets, numeric bounds,
 * a time window), and cramming it into a query string is where the empty-array
 * and type-coercion ambiguities this validator exists to reject would creep
 * back in.
 *
 * The four rules of `/api/track-record` are inherited, not re-stated: a rate
 * under n=30 is suppressed with the sample still shown, synthetic / event-time
 * / rights-refused signals are excluded and counted, and UNGRADED outcomes stay
 * in the denominator. A backtest cannot bypass them because it reaches them
 * through the same shared tally.
 */
import { Router, Request, Response } from 'express';
import { getStore } from '../persistence';
import type { ScannerFilter } from '../persistence/backtest';

const router = Router();

/** Fields whose presence-but-emptiness the caller almost never means. */
const STRING_SET_FIELDS = ['kinds', 'underlyings', 'sides'] as const;
const NUMBER_FIELDS = ['minPremium', 'minSize', 'minScore', 'from', 'to'] as const;

/**
 * Parse and validate a request body into a `ScannerFilter`, or return the
 * reason it is not one.
 *
 * Validation refuses rather than coerces, for the reason the whole product
 * refuses rather than coerces: a filter with a garbage field silently dropped
 * returns a confident answer to a question the caller did not ask. Three
 * refusals in particular:
 *
 *   - a string-set field present but not a non-empty array of strings — an
 *     empty `kinds: []` matches nothing, so a backtest built from it is
 *     confidently empty for a reason the caller cannot see;
 *   - a numeric field that is not a finite number — `NaN >= x` is always false,
 *     so a fat-fingered `minScore: "abc"` would silently match nothing;
 *   - `from` after `to` — an inverted window, which matches nothing and is
 *     almost certainly a transposition.
 */
function parseFilter(body: unknown): { filter: ScannerFilter } | { error: string } {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'Body must be a JSON object describing a scanner filter.' };
  }
  const b = body as Record<string, unknown>;
  const filter: ScannerFilter = {};

  for (const f of STRING_SET_FIELDS) {
    if (b[f] === undefined) continue;
    const v = b[f];
    if (!Array.isArray(v) || v.length === 0 || !v.every((x) => typeof x === 'string' && x.trim() !== '')) {
      return {
        error: `"${f}" must be a non-empty array of non-empty strings. An empty set ` +
          `matches nothing; omit the field to mean "any".`,
      };
    }
    filter[f] = v as string[];
  }

  for (const f of NUMBER_FIELDS) {
    if (b[f] === undefined) continue;
    const v = b[f];
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      return { error: `"${f}" must be a finite number.` };
    }
    filter[f] = v;
  }

  if (b.isoOnly !== undefined) {
    if (typeof b.isoOnly !== 'boolean') return { error: '"isoOnly" must be a boolean.' };
    filter.isoOnly = b.isoOnly;
  }

  if (filter.from !== undefined && filter.to !== undefined && filter.from > filter.to) {
    return { error: '"from" is after "to": the time window is inverted and matches nothing.' };
  }

  return { filter };
}

router.post('/', async (req: Request, res: Response) => {
  const store = getStore();
  if (!store) {
    return res.status(503).json({
      error: 'Signal history is not initialised.',
      detail: 'startIngestion() has not run yet, so nothing is being recorded.',
    });
  }

  const parsed = parseFilter(req.body);
  if ('error' in parsed) {
    return res.status(400).json({ error: 'Invalid scanner filter.', detail: parsed.error });
  }

  try {
    const report = await store.backtest(parsed.filter);
    res.json({
      ...report,
      storeKind: store.kind,
      disclaimer:
        'Descriptive measurement of what followed the signals this filter selected. ' +
        'Not a forecast, not a recommendation, and not evidence of an edge — these ' +
        'rates can only reject a claim about the filter, never establish one. A rate ' +
        'shown here was graded once, when the outcome was recorded; this did not ' +
        're-grade anything.',
    });
  } catch (err) {
    res.status(500).json({
      error: 'Backtest query failed.',
      detail: err instanceof Error ? err.message : String(err),
    });
  }
});

export default router;
