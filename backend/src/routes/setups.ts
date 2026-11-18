/**
 * POST /api/setups/replay — the setup replay, run on bars the caller uploads.
 *
 * Calls `runSetupReplay` from `research/setupReplay.ts`: the same function the
 * `research:setup-replay` CLI calls, so the browser and the CLI cannot diverge.
 * Nothing is persisted: the request body is parsed, replayed and answered.
 *
 * Mounted on `requireAuth`, NOT the demo tier. It parses arbitrary user uploads
 * of up to `SETUP_REPLAY_MAX_BYTES` and runs the structure and setup engines over
 * them, which is real CPU per call, and an unauthenticated tier would hand that
 * to anyone who can send the demo header. It is mounted ahead of the global
 * JSON parser with its own body cap and rate bucket, so an unauthenticated
 * caller's body is never parsed at all.
 *
 * Body: { config: { symbols: [A, B], timestampMarks: 'OPEN'|'CLOSE',
 * costs: { roundTripPerUnit }, params? }, csv: { A: string, B: string } }.
 * Nothing has a default: a missing convention or cost is refused by name.
 */
import express, { Router, Request, Response } from 'express';
import { runSetupReplay } from '../research/setupReplay';

/** Whole request body, both CSVs and the config together. */
export const SETUP_REPLAY_MAX_BYTES = 2 * 1024 * 1024;

export function bodyRefusals(body: unknown): string[] {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return ['body: a JSON object with config and csv is required'];
  const b = body as Record<string, unknown>;
  const r: string[] = [];
  for (const k of Object.keys(b)) if (k !== 'config' && k !== 'csv') r.push(`body.${k}: unknown field`);
  if (b.config === undefined) r.push('body.config: required');
  const csv = b.csv;
  if (csv === null || typeof csv !== 'object' || Array.isArray(csv)) r.push('body.csv: an object of symbol to CSV text is required');
  else for (const [k, v] of Object.entries(csv as Record<string, unknown>)) {
    if (typeof v !== 'string') r.push(`body.csv.${k}: must be CSV text`);
  }
  return r;
}

const router = Router();
router.use(express.json({ limit: SETUP_REPLAY_MAX_BYTES }));

router.post('/replay', (req: Request, res: Response) => {
  const pre = bodyRefusals(req.body);
  if (pre.length > 0) return res.status(400).json({ status: 'REFUSED', reasons: pre });
  const result = runSetupReplay({ config: req.body.config, csv: req.body.csv as Record<string, string> });
  return res.status(result.status === 'OK' ? 200 : 400).json(result);
});

/** A body over the cap is refused by name, not with an HTML stack page. */
router.use((err: any, _req: Request, res: Response, next: (e?: unknown) => void) => {
  if (err?.type === 'entity.too.large') return res.status(413).json({ status: 'REFUSED', reasons: [`body: larger than ${SETUP_REPLAY_MAX_BYTES} bytes`] });
  if (err?.type === 'entity.parse.failed') return res.status(400).json({ status: 'REFUSED', reasons: ['body: not valid JSON'] });
  return next(err);
});

export default router;
