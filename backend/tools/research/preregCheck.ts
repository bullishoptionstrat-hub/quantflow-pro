import 'dotenv/config';
/**
 * npm run research:prereg-check -- <plan.json>      validate a sensitivity-grid pre-registration
 * npm run research:prereg-check -- --template       print the blank template
 * Runs no grid. Exits 1 on refusal.
 */
import { readFileSync } from 'node:fs';
import { preregistrationTemplate, validatePreregistration } from '../../src/research/preregistration';

const arg = process.argv[2];
if (arg === '--template') {
  process.stdout.write(`${JSON.stringify(preregistrationTemplate(), null, 2)}\n`);
} else if (arg === undefined) {
  console.error('usage: research:prereg-check -- <plan.json> | --template');
  process.exitCode = 2;
} else {
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(arg, 'utf8')); }
  catch (e) { console.error(`cannot read ${arg}: ${(e as Error).message}`); process.exit(1); }
  const v = validatePreregistration(parsed, Date.now());
  process.stdout.write(`${JSON.stringify(v, null, 2)}\n`);
  process.exitCode = v.status === 'VALID' ? 0 : 1;
}
