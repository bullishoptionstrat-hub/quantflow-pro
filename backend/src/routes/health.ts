import { Router } from 'express';
import { getIngestionStatus } from '../ingestion/index';

const router = Router();

router.get('/', (_req, res) => {
  const status = getIngestionStatus();
  res.json({
    status: 'ok',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    ingestion: status,
    uptime: Math.floor(process.uptime()),
    memory: {
      heapUsedMB: Math.round(process.memoryUsage().heapUsed / 1_048_576),
      heapTotalMB: Math.round(process.memoryUsage().heapTotal / 1_048_576),
    },
  });
});

export default router;
