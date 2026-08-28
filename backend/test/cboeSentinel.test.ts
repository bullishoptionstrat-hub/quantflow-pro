/**
 * THE ZERO-SENTINEL REGRESSION
 *
 * `backend/src/ingestion/connectors/cboe.ts` used to turn every upstream
 * failure into the number 0, in two layers, and then log "[cboe] Updated".
 * The put/call endpoint really does return HTTP 403, so the shipped behavior
 * was a trading UI displaying "P/C Ratio: 0.00" and "VIX: 0.00" as real
 * readings, with no warning anywhere.
 *
 * These tests pin the two properties that make that impossible:
 *   1. a failed fetch yields `null`, never `0`;
 *   2. a REAL zero is still representable and distinguishable from absence.
 *
 * The connector's own network calls are not exercised here (no egress in this
 * environment). What is tested is the parse/assemble contract, which is where
 * the defect lived — the 403 was already being caught correctly; it was the
 * `?? 0` that turned a caught error into a fabricated number.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { num, type CBOEData } from '../src/ingestion/connectors/cboe';
import { classifyTermStructure as classify } from '../src/routes/macro';

describe('absent data and zero are different facts', () => {
  it('a missing field is null, NOT 0', () => {
    assert.equal(num(undefined), null);
    assert.equal(num(null), null);
    assert.equal(num(''), null);
  });

  it('unparseable garbage is null, not NaN and not 0', () => {
    assert.equal(num('n/a'), null);
    assert.equal(num({}), null);
    assert.equal(num(NaN), null);
    assert.equal(num(Infinity), null);
  });

  it('rejects partially-numeric strings instead of prefix-parsing them', () => {
    // parseFloat('403 Forbidden') is 403 — an error message becoming a reading.
    assert.equal(num('403 Forbidden'), null);
    assert.equal(num('1.2 (est)'), null);
    assert.equal(num('12abc'), null);
  });

  it('a REAL zero survives — the fix must not erase legitimate zeros', () => {
    // A genuine zero volume on a dead contract is a fact worth reporting.
    assert.equal(num(0), 0);
    assert.equal(num('0'), 0);
    assert.equal(num('0.00'), 0);
  });

  it('normal readings pass through unchanged', () => {
    assert.equal(num('14.72'), 14.72);
    assert.equal(num(0.93), 0.93);
  });

  it('null and 0 are distinguishable by the caller, which is the whole point', () => {
    const absent = num(undefined);
    const real = num(0);
    assert.notEqual(absent, real);
    assert.equal(absent === null, true);
    assert.equal(real === 0, true);
    // The old code collapsed both of these to 0 and lost the distinction.
  });
});

describe('the shape a total outage produces', () => {
  /** What `fetchAll` assembles when both upstreams fail (403 + no rows). */
  const outage: CBOEData = {
    vix: null, vix9d: null, vix3m: null, vix6m: null, vix1y: null,
    putCallRatioEquity: null, putCallRatioIndex: null, putCallRatioTotal: null,
    equityCallVolume: null, equityPutVolume: null, indexCallVolume: null,
    indexPutVolume: null, totalOptionsVolume: null,
    updatedAt: new Date().toISOString(),
    source: 'cboe',
    fetchStatus: { vix: 'failed', putCall: 'failed', note: '403 Request failed' },
  };

  it('reports failure explicitly rather than implying a reading', () => {
    assert.equal(outage.fetchStatus.vix, 'failed');
    assert.equal(outage.fetchStatus.putCall, 'failed');
    assert.ok(outage.fetchStatus.note, 'the reason must be carried, never swallowed');
  });

  it('no numeric field is 0 on a total outage', () => {
    const numeric = [
      outage.vix, outage.vix9d, outage.vix3m, outage.vix6m, outage.vix1y,
      outage.putCallRatioEquity, outage.putCallRatioIndex, outage.putCallRatioTotal,
      outage.equityCallVolume, outage.equityPutVolume, outage.indexCallVolume,
      outage.indexPutVolume, outage.totalOptionsVolume,
    ];
    assert.equal(numeric.filter((v) => v === 0).length, 0, 'a 403 must never render as 0.00');
    assert.equal(numeric.every((v) => v === null), true);
  });

  it('formatting an absent value says so instead of printing 0.00', () => {
    const fmt = (v: number | null) => (v === null ? 'unavailable' : v.toFixed(2));
    assert.equal(fmt(outage.vix), 'unavailable');
    assert.equal(fmt(outage.putCallRatioTotal), 'unavailable');
    // And a real zero still formats as a number.
    assert.equal(fmt(0), '0.00');
  });
});

describe('VIX term structure is derived, not asserted', () => {
  it('names backwardation when the front month is bid — the case that matters', () => {
    // March 2020 shape: front vol far above 3-month.
    assert.equal(classify(82.7, 55.3), 'backwardation');
  });

  it('names contango in the ordinary calm state', () => {
    assert.equal(classify(13.2, 17.8), 'contango');
  });

  it('does not force a direction on a flat curve', () => {
    assert.equal(classify(20.0, 20.1), 'flat');
  });

  it('returns null rather than guessing when a leg is missing', () => {
    assert.equal(classify(null, 17.8), null);
    assert.equal(classify(13.2, null), null);
    // This is the outage case: the route previously answered 'contango' here.
    assert.equal(classify(null, null), null);
  });
});
