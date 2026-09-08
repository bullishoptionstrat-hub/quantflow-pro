/**
 * OCC market-wide cleared volume, and why a zero here is louder than most.
 *
 * This payload is served on `/api/health`, which `render.yaml` sets as the
 * deployment's health check path and `server.ts` mounts **unauthenticated**.
 * So every figure it carries is published to anyone who can reach the service
 * — the same public-surface rule `sourceErrors` is held to.
 *
 * All seven were `Number(x) || 0`. `Number(undefined) || 0` is `0` and
 * `Number(null) || 0` is `0`, so a renamed key or a field dropped from the OCC
 * free feed would have published a **zeroed options market** rather than
 * failing visibly. And `vsMonthlyAverage` was `monthlyAvg > 0 ? … : 0`, which
 * publishes "today is 0.00x the trailing average" — the strongest single claim
 * on the payload — precisely when the average is the thing it does not have.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

function load(entity: unknown) {
  const resolved = require.resolve('../src/ingestion/connectors/occ');
  delete require.cache[resolved];
  const axios = require('axios');
  const realGet = axios.default?.get ?? axios.get;
  const get = async () => ({ data: { entity } });
  if (axios.default) axios.default.get = get; else axios.get = get;
  const mod = require('../src/ingestion/connectors/occ');
  return {
    ...mod,
    restore() {
      if (axios.default) axios.default.get = realGet; else axios.get = realGet;
      delete require.cache[resolved];
    },
  };
}

const full = {
  totalVolume: 58_000_000, optionsVolume: 54_000_000, futuresVolume: 4_000_000,
  fiftytwo_week_high: 71_000_000, fiftytwo_week_low: 21_000_000,
  monthlyDailyAverage: 45_000_000, yearlyDailyAverage: 42_000_000,
};

test('a complete response is published as sent', async () => {
  const occ = load(full);
  try {
    const v = await occ.fetchOccVolume();
    assert.equal(v.optionsVolume, 54_000_000);
    assert.equal(v.fiftyTwoWeekHigh, 71_000_000);
    assert.ok(Math.abs(v.vsMonthlyAverage - 1.2) < 1e-9, 'today vs the trailing average');
  } finally { occ.restore(); }
});

test('a field the OCC did not send is null, not a zeroed market', async () => {
  const { fiftytwo_week_high, futuresVolume, ...partial } = full;
  const occ = load(partial);
  try {
    const v = await occ.fetchOccVolume();
    assert.equal(v.futuresVolume, null, '`Number(undefined) || 0` published 0 here');
    assert.equal(v.fiftyTwoWeekHigh, null);
    assert.equal(v.optionsVolume, 54_000_000, 'the fields it did send are unaffected');
  } finally { occ.restore(); }
});

test('no trailing average means no multiple of it, rather than 0.00x', async () => {
  const { monthlyDailyAverage, ...noAvg } = full;
  const occ = load(noAvg);
  try {
    const v = await occ.fetchOccVolume();
    assert.equal(v.monthlyDailyAverage, null);
    assert.equal(v.vsMonthlyAverage, null,
      '0.00x reads as a dead session; the average is what is missing, not the volume');
  } finally { occ.restore(); }
});

test('a real zero survives, because a zero is a reading', async () => {
  const occ = load({ ...full, futuresVolume: 0 });
  try {
    const v = await occ.fetchOccVolume();
    assert.equal(v.futuresVolume, 0, 'no futures cleared is a fact the OCC can state');
  } finally { occ.restore(); }
});

test('a string where a number belongs is refused, not coerced', async () => {
  // The OCC sends JSON numbers — `fetchOccVolume` gates on
  // `typeof e.optionsVolume !== 'number'` — so `num` rather than `numeric`. A
  // string arriving here is a schema change worth seeing as null.
  const occ = load({ ...full, totalVolume: '58000000' });
  try {
    const v = await occ.fetchOccVolume();
    assert.equal(v.totalVolume, null);
  } finally { occ.restore(); }
});

test('a response with no usable entity yields nothing at all', async () => {
  const occ = load(undefined);
  try {
    assert.equal(await occ.fetchOccVolume(), null);
    assert.equal(occ.getOccVolume(), null);
  } finally { occ.restore(); }
});
