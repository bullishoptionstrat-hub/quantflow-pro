import { Router } from 'express';
import { getIngestionStatus } from '../ingestion/index';
import { resolveDataMode } from '../config/dataMode';

const router = Router();

/**
 * GET /api/health
 *
 * Reports real, measured per-source staleness — not a hardcoded status string.
 * `dataMode` is surfaced so the frontend can render a DEMO banner without
 * having to infer provenance from the data itself.
 */
router.get('/', (_req, res) => {
  const status = getIngestionStatus();

  res.json({
    status: 'ok',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    dataMode: resolveDataMode(),
    ingestion: status,
    // Promoted to the top level: this is the contract the UI badge reads.
    sourceHealth: status.sourceHealth,
    overall: status.overall,
    uptime: Math.floor(process.uptime()),
    memory: {
      heapUsedMB: Math.round(process.memoryUsage().heapUsed / 1_048_576),
      heapTotalMB: Math.round(process.memoryUsage().heapTotal / 1_048_576),
    },
  });
});

/** GET /api/health/sources — per-source staleness only, for lightweight polling. */
router.get('/sources', (_req, res) => {
  const status = getIngestionStatus();
  res.json({
    dataMode: resolveDataMode(),
    overall: status.overall,
    sources: status.sourceHealth,
    updatedAt: new Date().toISOString(),
  });
});

export default router;
