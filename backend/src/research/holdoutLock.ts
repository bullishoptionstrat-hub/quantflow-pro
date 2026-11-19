/**
 * HOLDOUT LOCK — a holdout dataset may be read once per frozen plan, and the
 * read is recorded before the bytes are handed back.
 *
 * The lock is a file per (preregistration hash, dataset sha256) in a lock
 * directory, created with `open(..., 'wx')`: the operating system refuses a
 * second create, so two processes racing for the same holdout cannot both
 * win. A second read is refused and names the first one. Nothing here deletes
 * a lock; re-reading a holdout means writing a new plan (a new hash), which is
 * the point.
 *
 * Refused before any claim: a plan `validatePreregistration` does not accept
 * as VALID and FROZEN; text whose sha256 is not one of the plan's holdout
 * datasets (an analysis dataset is named as such). The claim is written
 * before the text is returned, so a crash after the read still counts it.
 *
 * Limit, stated: the lock is only as strong as the directory. Deleting the
 * file, or pointing at another directory, defeats it; the record exists so
 * that doing so is a deliberate act rather than an accident.
 */
import { createHash } from 'node:crypto';
import { closeSync, openSync, readFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { validatePreregistration, type Preregistration } from './preregistration';

export const HOLDOUT_LOCK_VERSION = 'holdout-lock/1';

export interface HoldoutReadRecord {
  version: typeof HOLDOUT_LOCK_VERSION;
  planId: string;
  preregistrationHash: string;
  datasetId: string;
  datasetSha256: string;
  readAt: string;
}

export type HoldoutReadResult =
  | { status: 'READ'; text: string; record: HoldoutReadRecord; lockPath: string }
  | { status: 'REFUSED'; reasons: string[]; priorRead?: HoldoutReadRecord };

export interface HoldoutReadInput {
  plan: unknown;
  text: string;
  lockDir: string;
  nowMs: number;
}

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

export function readHoldoutOnce(input: HoldoutReadInput): HoldoutReadResult {
  const v = validatePreregistration(input.plan, input.nowMs);
  if (v.status !== 'VALID') return { status: 'REFUSED', reasons: v.reasons.map((r) => `plan: ${r}`) };
  if (!v.frozen) return { status: 'REFUSED', reasons: ['plan: a holdout is read only under a FROZEN plan'] };
  if (!Number.isFinite(input.nowMs)) return { status: 'REFUSED', reasons: ['nowMs is not finite'] };
  const plan = input.plan as Preregistration;
  const h = sha(input.text);
  const ref = plan.holdout.find((d) => d.sha256 === h);
  if (ref === undefined) {
    const a = plan.datasets.find((d) => d.sha256 === h);
    return { status: 'REFUSED', reasons: [a ? `text is analysis dataset ${a.id}, not a holdout of ${plan.id}` : `sha256 ${h} is not a holdout dataset of ${plan.id}`] };
  }
  const record: HoldoutReadRecord = {
    version: HOLDOUT_LOCK_VERSION, planId: plan.id, preregistrationHash: v.preregistrationHash,
    datasetId: ref.id, datasetSha256: h, readAt: new Date(input.nowMs).toISOString(),
  };
  const lockPath = join(input.lockDir, `${v.preregistrationHash}.${h}.read.json`);
  let fd: number;
  try {
    fd = openSync(lockPath, 'wx');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
      let prior: HoldoutReadRecord | undefined;
      try { prior = JSON.parse(readFileSync(lockPath, 'utf8')) as HoldoutReadRecord; } catch { prior = undefined; }
      return { status: 'REFUSED', reasons: [`holdout ${ref.id} was already read under this plan${prior ? ` at ${prior.readAt}` : ''}; a second read is refused`], ...(prior ? { priorRead: prior } : {}) };
    }
    return { status: 'REFUSED', reasons: [`lock could not be created at ${lockPath}: ${(e as Error).message}`] };
  }
  try { writeSync(fd, JSON.stringify(record) + '\n'); } finally { closeSync(fd); }
  return { status: 'READ', text: input.text, record, lockPath };
}
