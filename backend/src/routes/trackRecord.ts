/**
 * GET /api/track-record — what this deployment has actually measured.
 *
 * The honest counterpart to every hit-rate claim in this product's category.
 * Four rules are enforced here and are the whole point of the endpoint:
 *
 *   1. A rate computed on fewer than `minSample` graded outcomes is not
 *      published. The row still appears, with `suppressionReason:
 *      "INSUFFICIENT_SAMPLE"` — suppressing the number while showing the
 *      sample is different from hiding the row, which would let a reader
 *      assume the category was never tested.
 *   2. Synthetic signals never enter a rate, and are counted where the reader
 *      can see them.
 *   3. Signals whose decision time is a lower bound (EVENT_TIME_ONLY) are
 *      excluded from rates and counted separately.
 *   4. UNGRADED outcomes are reported, not dropped. They are mostly
 *      AMBIGUOUS-side signals, which are the ones a less careful system would
 *      guess a direction for.
 */
import { Router, Request, Response } from 'express';
import { getStore, getRecorder } from '../persistence';

const router = Router();

router.get('/', async (_req: Request, res: Response) => {
  const store = getStore();
  if (!store) {
    return res.status(503).json({
      error: 'Signal history is not initialised.',
      detail: 'startIngestion() has not run yet, so nothing is being recorded.',
    });
  }

  try {
    const [report, counts, incidents] = await Promise.all([
      store.trackRecord(),
      store.countSignals(),
      store.listIncidents(10),
    ]);

    res.json({
      ...report,
      counts,
      storeKind: store.kind,
      recorder: getRecorder()?.getStats() ?? null,
      // A write collision means two different signals claimed one identity, or
      // one signal's economics changed after emission. Either is a defect in
      // the pipeline, and surfacing it beside the rates is what keeps the
      // rates trustworthy.
      writeIncidents: incidents,
      disclaimer:
        'Descriptive measurement of what followed each signal. Not a forecast, ' +
        'not a recommendation, and not evidence of an edge — these rates can ' +
        'only reject a claim, never establish one.',
    });
  } catch (err) {
    res.status(500).json({
      error: 'Track record query failed.',
      detail: err instanceof Error ? err.message : String(err),
    });
  }
});

export default router;
