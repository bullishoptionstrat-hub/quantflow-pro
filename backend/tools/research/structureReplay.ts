import 'dotenv/config';
/**
 * npm run research:structure-replay -- --config <config.json> --csv SYM=<file> [--csv PAIR=<file>] [--out <report.json>]
 * Writes the report (or the refusal) as stable JSON; exits 1 on refusal.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { runStructureReplay } from '../../src/research/structureReplay';
import { stableStringify } from '../../src/research/setupReplay';

const args = process.argv.slice(2);
let configPath: string | null = null;
let out: string | null = null;
const csv: Record<string, string> = {};
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  const v = args[i + 1];
  if (a === '--config' && v !== undefined) { configPath = v; i++; }
  else if (a === '--out' && v !== undefined) { out = v; i++; }
  else if (a === '--csv' && v !== undefined && v.includes('=')) {
    csv[v.slice(0, v.indexOf('='))] = readFileSync(v.slice(v.indexOf('=') + 1), 'utf8'); i++;
  } else { console.error(`unrecognised argument: ${a}`); process.exit(2); }
}
if (configPath === null) { console.error('--config is required'); process.exit(2); }
const result = runStructureReplay({ config: JSON.parse(readFileSync(configPath, 'utf8')), csv });
const text = stableStringify(result);
if (out !== null) writeFileSync(out, text); else process.stdout.write(text);
process.exitCode = result.status === 'OK' ? 0 : 1;
