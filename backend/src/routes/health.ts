import { Router } from 'express';
import { getIngestionStatus, getSignalHistoryStatus } from '../ingestion/index';
import { resolveDataMode } from '../config/dataMode';
import { PROVIDERS, missingEnvFor } from '../providers/registry';
import { quotaSnapshot } from '../providers/quota';
import { getEnrichmentStatus } from '../enrichment/index';

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
    // Reported separately from `ingestion.sources`: enrichment is not a tape
    // source and never contributes a print — it answers requests on demand.
    enrichment: getEnrichmentStatus(),
    // Whether anything is actually being kept. A deployment can look entirely
    // healthy while discarding every signal it classifies, and that failure is
    // invisible until someone asks for a track record months later.
    history: getSignalHistoryStatus(),
    uptime: Math.floor(process.uptime()),
    memory: {
      heapUsedMB: Math.round(process.memoryUsage().heapUsed / 1_048_576),
      heapTotalMB: Math.round(process.memoryUsage().heapTotal / 1_048_576),
    },
  });
});

/**
 * GET /api/health/providers — declared capabilities vs live quota state.
 * Surfaces which limits are VERIFIED and which are being enforced
 * pessimistically because they never were.
 */
router.get('/providers', (_req, res) => {
  const quota = Object.fromEntries(quotaSnapshot().map((q) => [q.providerId, q]));
  res.json({
    providers: PROVIDERS.map((p) => ({
      id: p.id,
      displayName: p.displayName,
      capabilities: p.capabilities,
      priority: p.priority,
      latency: p.latency,
      estimatedDelaySeconds: p.estimatedDelaySeconds ?? null,
      limitVerified: p.rateLimit.verification.state === 'verified',
      limitNote:
        p.rateLimit.verification.state === 'verified'
          ? p.rateLimit.verification.source
          : p.rateLimit.verification.reason,
      blockedOnFreeTier: p.blockedOnFreeTier ?? false,
      blockedReason: p.blockedReason ?? null,
      missingEnv: missingEnvFor(p),
      configured: missingEnvFor(p).length === 0 && !p.blockedOnFreeTier,
      tosNotes: p.tosNotes ?? null,
      quota: quota[p.id] ?? null,
    })),
    updatedAt: new Date().toISOString(),
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
