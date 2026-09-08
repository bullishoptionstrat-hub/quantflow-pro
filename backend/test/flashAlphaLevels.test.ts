/**
 * FlashAlpha's summary is four strike prices and a regime, and all five were
 * defaulted rather than reported.
 *
 *     gammaFlip: data.gamma_flip ?? 0,
 *     maxPain:   data.max_pain   ?? 0,
 *     callWall:  data.call_wall  ?? 0,
 *     putWall:   data.put_wall   ?? 0,
 *     dealerRegime: data.dealer_regime ?? 'neutral',
 *
 * A gamma flip of 0 is not a weak reading — it is a level that cannot exist on
 * any underlying. This repo already recorded the consequence, in the comment
 * on `/api/gex`: *"a fabricated gamma flip looks exactly like a real one."*
 * The regime is the same defect wearing a string: a response that carried no
 * `dealer_regime` did not say dealers were neutrally positioned.
 *
 * `getFlashGEX` has no consumer today, which is precisely when a fabricator is
 * cheapest to remove — the same reasoning that deleted `buildMockChain`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

function load(payload: unknown) {
  const resolved = require.resolve('../src/ingestion/connectors/flashAlpha');
  delete require.cache[resolved];
  const axios = require('axios');
  const realGet = axios.default?.get ?? axios.get;
  const get = async () => ({ data: payload });
  if (axios.default) axios.default.get = get; else axios.get = get;

  const prev = process.env.FLASHALPHA_API_KEY;
  process.env.FLASHALPHA_API_KEY = 'fa-test-key';
  const mod = require('../src/ingestion/connectors/flashAlpha');
  return {
    ...mod,
    restore() {
      if (axios.default) axios.default.get = realGet; else axios.get = realGet;
      if (prev === undefined) delete process.env.FLASHALPHA_API_KEY;
      else process.env.FLASHALPHA_API_KEY = prev;
      delete require.cache[resolved];
    },
  };
}

/** Drive one fetch without waiting on the 90s-staggered daily batch. */
async function fetchOne(mod: any, symbol = 'SPX') {
  await mod.startFlashAlpha();
  // `startFlashAlpha` schedules its batch on unref'd timers; call the fetch
  // path directly by driving the cache through a second start is not possible,
  // so the batch's first entry (i = 0) fires at 0ms. Yield to it.
  await new Promise((r) => setTimeout(r, 0));
  return mod.getFlashGEX(symbol);
}

const full = {
  gamma_flip: 5800, max_pain: 5750, call_wall: 5900, put_wall: 5700,
  dealer_regime: 'short',
  strikes: [{ strike: 5800, net_gex: 1.2e9, net_dex: 3e8, net_vex: 1e7, call_gamma: 0.03, put_gamma: 0.02 }],
};

test('a complete summary is published as sent', async () => {
  const fa = load(full);
  try {
    const s = await fetchOne(fa);
    assert.ok(s, 'the batch fires its first symbol immediately');
    assert.equal(s.gammaFlip, 5800);
    assert.equal(s.dealerRegime, 'short');
    assert.equal(s.levels[0].gex, 1.2e9);
  } finally { fa.restore(); }
});

test('a gamma flip FlashAlpha did not report is null, not strike zero', async () => {
  const { gamma_flip, max_pain, ...partial } = full;
  const fa = load(partial);
  try {
    const s = await fetchOne(fa);
    assert.equal(s.gammaFlip, null, 'strike 0 is not a level, it is a fabrication');
    assert.equal(s.maxPain, null);
    assert.equal(s.callWall, 5900, 'the levels it did report are unaffected');
  } finally { fa.restore(); }
});

test('an unreported dealer regime is null, not neutral', async () => {
  const { dealer_regime, ...noRegime } = full;
  const fa = load(noRegime);
  try {
    assert.equal((await fetchOne(fa)).dealerRegime, null,
      '"dealers are neutrally positioned" is a market read nobody made');
  } finally { fa.restore(); }
});

test('an unrecognised regime is null rather than passed through', async () => {
  const fa = load({ ...full, dealer_regime: 'sideways' });
  try {
    assert.equal((await fetchOne(fa)).dealerRegime, null);
  } finally { fa.restore(); }
});

test('a level with no strike is dropped, because it cannot be placed', async () => {
  const fa = load({
    ...full,
    strikes: [
      { net_gex: 5e8 },                       // no strike at all
      { strike: 0, net_gex: 5e8 },            // strike zero
      { strike: 5850, net_gex: 7e8 },         // real
    ],
  });
  try {
    const s = await fetchOne(fa);
    assert.equal(s.levels.length, 1);
    assert.equal(s.levels[0].strike, 5850);
  } finally { fa.restore(); }
});

test('a level with a strike but no figure keeps the strike and nulls the figure', async () => {
  // The strike is what places it; the figures are what it says. Losing the
  // second is not a reason to discard the first.
  const fa = load({ ...full, strikes: [{ strike: 5850, net_gex: 7e8 }] });
  try {
    const [lvl] = (await fetchOne(fa)).levels;
    assert.equal(lvl.strike, 5850);
    assert.equal(lvl.gex, 7e8);
    assert.equal(lvl.dex, null);
    assert.equal(lvl.callGamma, null, 'a gamma of 0 is a claim about dealer positioning');
  } finally { fa.restore(); }
});

test('a real zero survives, because a flat level is a reading', async () => {
  const fa = load({ ...full, strikes: [{ strike: 5850, net_gex: 0, net_dex: 0 }] });
  try {
    const [lvl] = (await fetchOne(fa)).levels;
    assert.equal(lvl.gex, 0);
    assert.equal(lvl.dex, 0);
  } finally { fa.restore(); }
});
