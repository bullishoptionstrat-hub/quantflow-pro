import { Router } from 'express';
import { getIngestionStatus, getSignalHistoryStatus } from '../ingestion/index';
import { getEnrichmentStatus } from '../enrichment/index';
import { marketSessionAt } from '../market/session';

const router = Router();

router.get('/', (_req, res) => {
  const status = getIngestionStatus();
  res.json({
    status: 'ok',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    ingestion: status,
    // Reported separately from `ingestion.sources`: enrichment is not a tape
    // source and never contributes a print — it answers requests on demand.
    enrichment: getEnrichmentStatus(),
    // Whether anything is actually being kept. A deployment can look entirely
    // healthy while discarding every signal it classifies, and that failure is
    // invisible until someone asks for a track record months later.
    history: getSignalHistoryStatus(),
    /**
     * Whether the market is open, from the published calendar rather than from
     * a weekday-and-clock guess. Served here because `/api/health` is the one
     * unauthenticated payload the browser can read on every page — including
     * `/login`, where the sidebar also mounts.
     */
    session: marketSessionAt(Date.now()),
    uptime: Math.floor(process.uptime()),
    memory: {
      heapUsedMB: Math.round(process.memoryUsage().heapUsed / 1_048_576),
      heapTotalMB: Math.round(process.memoryUsage().heapTotal / 1_048_576),
    },
  });
});

export default router;
