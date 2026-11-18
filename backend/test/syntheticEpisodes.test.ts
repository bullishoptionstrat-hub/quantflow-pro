/**
 * The planted-episode fixture: the one input on which the setup replay reaches
 * ACTIONABLE, so replay → outcome → ticket runs end to end on engine output.
 *
 * What is held here:
 * - the committed files are the generator's output, byte for byte;
 * - the walk the episodes sit in is the plain fixture walk (`syntheticBars.ts`),
 *   and every bar after a trigger is that walk unconditioned — the generator
 *   plants the entry and never what follows it;
 * - every ACTIONABLE idea is a planted trigger, and every planted trigger whose
 *   reward gate passes is ACTIONABLE (nothing reaches it by accident);
 * - each ACTIONABLE idea is graded from the bars after its ACTIONABLE close;
 * - the recorded report is what the CLI produces today.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildEpisodeFixtures, walkBar, mulberry32, template, EPISODE_DAYS, EPISODE_SEEDS } from '../tools/fixtures/syntheticEpisodes';
import { syntheticCsv } from '../tools/fixtures/syntheticBars';
import { runSetupReplay, stableStringify } from '../src/research/setupReplay';

const FIX = join(__dirname, 'fixtures', 'bars');
const read = (f: string) => readFileSync(join(FIX, f), 'utf8');
const config = JSON.parse(read('episodes.config.json'));
const csv = { SPY: read('EPISODE_SPY_1m.csv'), QQQ: read('EPISODE_QQQ_1m.csv') };
const manifest = JSON.parse(read('episodes.manifest.json'));

type Idea = { ideaId: string; symbol: string; side: string; history: { state: string; knownAt: number; bar: string }[] };
const result = runSetupReplay({ config, csv });
assert.equal(result.status, 'OK');
const report = (result as { report: any }).report;
const ideas: Idea[] = report.runs.flatMap((r: { ideas: Idea[] }) => r.ideas);
const actionable = ideas.filter((i) => i.history.some((t) => t.state === 'ACTIONABLE'));
const triggerCloses = new Set<number>(manifest.episodes.map((e: { triggerTOpen: string }) => Date.parse(e.triggerTOpen) + 60_000));

test('the committed episode files are the generator output, byte for byte', () => {
  const { spy, qqq } = buildEpisodeFixtures();
  assert.equal(csv.SPY, spy.csv, 'EPISODE_SPY_1m.csv was edited by hand');
  assert.equal(csv.QQQ, qqq.csv, 'EPISODE_QQQ_1m.csv was edited by hand');
  assert.deepEqual(manifest.episodes, spy.episodes);
  assert.deepEqual(manifest.days, EPISODE_DAYS);
  assert.deepEqual(manifest.seeds, EPISODE_SEEDS);
  assert.deepEqual(qqq.episodes, spy.episodes, 'the two symbols plant their episodes on the same minutes');
});

test('walkBar is the plain fixture walk, draw for draw', () => {
  const rnd = mulberry32(1101);
  const rows = syntheticCsv(1101, 590, ['2026-01-05']).trim().split('\n').slice(1);
  let px = 590;
  for (const row of rows.slice(0, 50)) {
    const b = walkBar(rnd, px);
    const [, o, h, l, c, v] = row.split(',');
    assert.deepEqual([b.o.toFixed(2), b.h.toFixed(2), b.l.toFixed(2), b.c.toFixed(2), b.v], [o, h, l, c, v]);
    px = Number(b.c.toFixed(2));
  }
});

test('outside the template every bar is the unconditioned walk: nothing after a trigger is planted', () => {
  // Re-walks each file independently of episodeCsv: one walk stream, advanced
  // only on minutes the manifest says are not template minutes.
  const len = template(false).length;
  for (const [sym, seed] of [['SPY', EPISODE_SEEDS.spyWalk], ['QQQ', EPISODE_SEEDS.qqqWalk]] as const) {
    const rows = csv[sym].trim().split('\n').slice(1);
    const rnd = mulberry32(seed);
    let px = sym === 'SPY' ? 590 : 520;
    let n = 0;
    let checkedAfterTrigger = 0;
    for (const ep of manifest.episodes as { startMinute: number; triggerMinute: number }[]) {
      assert.equal(ep.triggerMinute - ep.startMinute, len - 1);
      for (let m = 0; m < 390; m++, n++) {
        const [, o, h, l, c, v] = rows[n]!.split(',');
        if (m >= ep.startMinute && m <= ep.triggerMinute) { px = Number(c); continue; }
        const b = walkBar(rnd, px);
        assert.deepEqual([b.o.toFixed(2), b.h.toFixed(2), b.l.toFixed(2), b.c.toFixed(2), b.v], [o, h, l, c, v], `${sym} row ${n} is not the walk`);
        if (m > ep.triggerMinute) checkedAfterTrigger++;
        px = Number(b.c.toFixed(2));
      }
    }
    assert.equal(n, rows.length);
    assert.ok(checkedAfterTrigger > 1000);
  }
});

test('the replay reaches ACTIONABLE, and only on planted trigger bars', () => {
  assert.ok(actionable.length >= 5, `expected several ACTIONABLE ideas, got ${actionable.length}`);
  for (const i of actionable) {
    const a = i.history.find((t) => t.state === 'ACTIONABLE')!;
    assert.ok(triggerCloses.has(a.knownAt), `${i.ideaId} became ACTIONABLE at ${new Date(a.knownAt).toISOString()}, not on a planted trigger`);
    assert.equal(i.symbol, 'SPY');
    assert.equal(i.side, 'LONG');
  }
  // Every planted day reached TRIGGER_CONFIRMED; the ones not ACTIONABLE say why.
  for (const close of triggerCloses) {
    const at = ideas.filter((i) => i.history.some((t) => t.state === 'TRIGGER_CONFIRMED' && t.knownAt === close));
    assert.ok(at.length > 0, `no idea reached the planted trigger closing ${new Date(close).toISOString()}`);
  }
});

test('each ACTIONABLE idea is graded, from bars after its ACTIONABLE close', () => {
  const graded = new Map<string, any>(report.outcomes.ideas.map((o: any) => [o.ideaId, o]));
  const spyBars = csv.SPY.trim().split('\n').slice(1).map((r) => Date.parse(r.split(',')[0]!));
  for (const i of actionable) {
    const o = graded.get(i.ideaId);
    assert.ok(o, `${i.ideaId} has no outcome row`);
    assert.notEqual(o.state, 'NOT_GRADED');
    const at = i.history.find((t) => t.state === 'ACTIONABLE')!.knownAt;
    if (o.state === 'TARGET_FIRST' || o.state === 'STOP_FIRST') {
      assert.ok(o.decidedAt > at, 'decided strictly after the ACTIONABLE close: the trigger bar is never read');
      assert.ok(spyBars.includes(o.decidedAt - 60_000), 'decided on the close of a real bar');
      assert.ok(o.barsRead >= 1);
    }
  }
  assert.equal(report.outcomes.summary.hitRate, null, 'below the sample floor nothing is published');
  assert.match(report.outcomes.summary.suppressed, /INSUFFICIENT_SAMPLE/);
});

test('the recorded episode replay is what the CLI produces today', () => {
  assert.equal(readFileSync(join(__dirname, 'fixtures', 'setupReplayEpisodes.json'), 'utf8'), stableStringify(result));
});
