/**
 * Writes the SYNTHETIC 1-minute bar fixtures under test/fixtures/bars/.
 *
 * These are a seeded random walk, not market data. They exist so the bar
 * import and the setup replay have a fixed, re-creatable input. Re-running this
 * script reproduces the files byte for byte; do not edit them by hand.
 *
 *   npx tsx tools/fixtures/syntheticBars.ts
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function syntheticCsv(seed: number, base: number, days: string[]): string {
  const rnd = mulberry32(seed);
  const rows = ['timestamp,open,high,low,close,volume'];
  let px = base;
  for (const d of days) {
    // 09:30-16:00 ET in EST (UTC-5) — the fixture dates are chosen in January.
    const open = Date.parse(`${d}T14:30:00Z`);
    for (let m = 0; m < 390; m++) {
      const o = px;
      const c = Math.max(1, o * (1 + (rnd() - 0.5) * 0.004));
      const h = Math.max(o, c) * (1 + rnd() * 0.0015);
      const l = Math.min(o, c) * (1 - rnd() * 0.0015);
      const v = rnd() < 0.02 ? '' : String(Math.floor(1000 + rnd() * 50000));
      rows.push([new Date(open + m * 60_000).toISOString(), o.toFixed(2), h.toFixed(2), l.toFixed(2), c.toFixed(2), v].join(','));
      px = Number(c.toFixed(2));
    }
  }
  return rows.join('\n') + '\n';
}

if (require.main === module) {
  const dir = join(__dirname, '..', '..', 'test', 'fixtures', 'bars');
  const days = ['2026-01-05', '2026-01-06', '2026-01-07'];
  writeFileSync(join(dir, 'SYNTHETIC_SPY_1m.csv'), syntheticCsv(1101, 590, days));
  writeFileSync(join(dir, 'SYNTHETIC_QQQ_1m.csv'), syntheticCsv(2202, 520, days));
}
