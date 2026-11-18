import 'dotenv/config';
/**
 * npm run research:grid -- <plan.json> <config.json> SYMBOL=file.csv [SYMBOL=file.csv ...]
 * Runs a sensitivity grid only from a FROZEN, VALID pre-registration whose
 * analysis datasets are exactly the files supplied (by SHA-256). Exits 1 on refusal.
 */
import { readFileSync } from 'node:fs';
import { runSensitivityGrid } from '../../src/research/sensitivityGrid';
import { stableStringify } from '../../src/research/setupReplay';

const [planPath, configPath, ...files] = process.argv.slice(2);
if (planPath === undefined || configPath === undefined || files.length === 0) {
  console.error('usage: research:grid -- <plan.json> <config.json> SYMBOL=file.csv ...');
  process.exit(2);
}
const csv: Record<string, string> = {};
for (const f of files) {
  const i = f.indexOf('=');
  if (i <= 0) { console.error(`expected SYMBOL=file.csv, got ${f}`); process.exit(2); }
  csv[f.slice(0, i)] = readFileSync(f.slice(i + 1), 'utf8');
}
const r = runSensitivityGrid({
  plan: JSON.parse(readFileSync(planPath, 'utf8')), config: JSON.parse(readFileSync(configPath, 'utf8')), csv, nowMs: Date.now(),
});
process.stdout.write(stableStringify(r));
process.exitCode = r.status === 'OK' ? 0 : 1;
