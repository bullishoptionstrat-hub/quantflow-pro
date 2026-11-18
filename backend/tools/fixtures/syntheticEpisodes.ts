/**
 * Writes the SYNTHETIC EPISODE bar fixtures under test/fixtures/bars/:
 * EPISODE_SPY_1m.csv, EPISODE_QQQ_1m.csv and episodes.manifest.json.
 *
 * Why it exists. The plain random walks (`syntheticBars.ts`) never take a
 * Sweep and Reclaim idea past displacement: the engine requires the fair-value
 * gap to be formed by the bar that confirmed the displacement, and a walk
 * almost never does that. So the replay → outcome → ticket path had only ever
 * run on a constructed idea. This file plants the entry pattern and nothing
 * after it.
 *
 * What is planted, and what is not:
 * - One EPISODE per day at a seeded minute. Up to and including its TRIGGER
 *   bar it is a fixed template of bars (scaled by the symbol's price and a
 *   seeded unit size): a decline to a swing low, a bounce that becomes the
 *   dealing range's high, a sweep of that low and a close back above it, a
 *   displacement whose third bar leaves a bullish fair-value gap, a touch of
 *   the gap and a later close above it. QQQ gets the same template with the
 *   sweep bar's low ABOVE its previous swing low, which is what makes the
 *   SMT divergence.
 * - Everything after the trigger, and everything between episodes, is the
 *   same seeded random walk as `syntheticBars.ts` (`walkBar`). The generator
 *   never reads the idea's stop or target and never conditions on what comes
 *   after the trigger: outcomes are whatever the walk does. A test asserts
 *   that the bars after each trigger are exactly the unconditioned walk.
 * - The template is designed to reach ACTIONABLE under the DEFAULT setup
 *   parameters. It is not evidence about the rules, about markets, or about
 *   any outcome: it is a fixture to exercise code paths.
 *
 * Re-running reproduces the files byte for byte; never edit them by hand.
 *
 *   npx tsx tools/fixtures/syntheticEpisodes.ts
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Ohlc { o: number; h: number; l: number; c: number }

/** One random-walk bar from `px`. Consumes exactly four draws. */
export function walkBar(rnd: () => number, px: number): Ohlc & { v: string } {
  const o = px;
  const c = Math.max(1, o * (1 + (rnd() - 0.5) * 0.004));
  const h = Math.max(o, c) * (1 + rnd() * 0.0015);
  const l = Math.min(o, c) * (1 - rnd() * 0.0015);
  const v = rnd() < 0.02 ? '' : String(Math.floor(1000 + rnd() * 50000));
  return { o, h, l, c, v };
}

/**
 * The template in units of `u`, relative to the swept swing low at 0.
 * [open, high, low, close]. The last row is the TRIGGER bar.
 * `qqq` raises the sweep bar's low above 0, so QQQ makes a higher low where
 * SPY makes a lower one.
 */
export function template(qqq: boolean): [number, number, number, number][] {
  const rows: [number, number, number, number][] = [];
  // Decline from +10 to the swing low at 0: every bar a lower high and lower low.
  for (let k = 0; k < 10; k++) {
    const top = 10 - k;
    rows.push([top, top + 0.1, top - 1, top - 0.9]);
  }
  rows.push([1.1, 1.2, 0, 0.3]);              // the swing low at 0
  // Bounce to +8: higher highs and higher lows.
  for (const top of [2, 4, 6, 8]) rows.push([top - 1.7, top, top - 1.9, top - 0.2]);
  // Decline from +8 back to +0.6, lower highs and lower lows, staying above 0.
  for (const top of [7.6, 6, 4.4, 2.8, 1.6]) rows.push([top, top + 0.1, top - 1.4, top - 1.3]);
  rows.push([0.3, 0.7, qqq ? 0.2 : -1, 0.5]); // SWEEP: below 0 and back above (QQQ: a higher low)
  rows.push([0.5, 0.8, 0.45, 0.8]);           // b: small body
  rows.push([0.8, 3.6, 0.8, 3.5]);            // c: DISPLACEMENT; low(c) > high(sweep) leaves the gap
  rows.push([3.5, 3.7, 0.75, 1.0]);           // TOUCH of the gap, with a higher high
  rows.push([1.0, 3.8, 0.7, 0.78]);           // closes under the gap top, higher high again
  rows.push([0.78, 3.9, 0.72, 1.1]);          // TRIGGER: a later close above the gap top
  return rows;
}

export interface EpisodeMark { day: string; startMinute: number; triggerMinute: number; triggerTOpen: string }

export interface EpisodeOut { csv: string; episodes: EpisodeMark[] }

/**
 * One symbol's file. `episodeRnd` draws only the episode minute and unit, and
 * is shared by both symbols so their episodes align; `walkRnd` is the symbol's
 * own walk.
 */
export function episodeCsv(walkSeed: number, base: number, unitFraction: number, days: string[], qqq: boolean, episodeSeed: number): EpisodeOut {
  const walk = mulberry32(walkSeed);
  const ep = mulberry32(episodeSeed);
  const tpl = template(qqq);
  const rows = ['timestamp,open,high,low,close,volume'];
  const episodes: EpisodeMark[] = [];
  let px = base;
  for (const d of days) {
    // 09:30-16:00 ET in EST (UTC-5): the fixture dates are in January.
    const open = Date.parse(`${d}T14:30:00Z`);
    const start = 60 + Math.floor(ep() * 200);
    const unitScale = 0.8 + ep() * 0.4;
    const u = px * unitFraction * unitScale;
    let zero = 0;
    for (let m = 0; m < 390; m++) {
      let bar: Ohlc & { v: string };
      const k = m - start;
      if (k >= 0 && k < tpl.length) {
        // The template is anchored so its first open is the walk's price.
        if (k === 0) zero = px - tpl[0]![0] * u;
        const [o, h, l, c] = tpl[k]!;
        bar = { o: zero + o * u, h: zero + h * u, l: zero + l * u, c: zero + c * u, v: String(10000 + k) };
      } else {
        bar = walkBar(walk, px);
      }
      rows.push([new Date(open + m * 60_000).toISOString(), bar.o.toFixed(2), bar.h.toFixed(2), bar.l.toFixed(2), bar.c.toFixed(2), bar.v].join(','));
      px = Number(bar.c.toFixed(2));
    }
    episodes.push({ day: d, startMinute: start, triggerMinute: start + tpl.length - 1, triggerTOpen: new Date(open + (start + tpl.length - 1) * 60_000).toISOString() });
  }
  return { csv: rows.join('\n') + '\n', episodes };
}

export const EPISODE_DAYS = ['2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08', '2026-01-09'];
export const EPISODE_SEEDS = { spyWalk: 3101, qqqWalk: 3202, episodes: 3303 } as const;
export const UNIT_FRACTION = 0.001;

export function buildEpisodeFixtures() {
  const spy = episodeCsv(EPISODE_SEEDS.spyWalk, 590, UNIT_FRACTION, EPISODE_DAYS, false, EPISODE_SEEDS.episodes);
  const qqq = episodeCsv(EPISODE_SEEDS.qqqWalk, 520, UNIT_FRACTION, EPISODE_DAYS, true, EPISODE_SEEDS.episodes);
  return { spy, qqq };
}

if (require.main === module) {
  const dir = join(__dirname, '..', '..', 'test', 'fixtures', 'bars');
  const { spy, qqq } = buildEpisodeFixtures();
  writeFileSync(join(dir, 'EPISODE_SPY_1m.csv'), spy.csv);
  writeFileSync(join(dir, 'EPISODE_QQQ_1m.csv'), qqq.csv);
  writeFileSync(join(dir, 'episodes.manifest.json'), JSON.stringify({
    kind: 'SYNTHETIC_EPISODES', generator: 'backend/tools/fixtures/syntheticEpisodes.ts',
    seeds: EPISODE_SEEDS, unitFraction: UNIT_FRACTION, days: EPISODE_DAYS, episodes: spy.episodes,
  }, null, 2) + '\n');
}
