/**
 * Aggregate venue metadata never generates fictitious child executions.
 * (INV-004)
 *
 * The adapter used to split a record carrying `exchanges: [A, B, C]` and
 * `size: 60` into three trade events of 20, one per venue, on the reasoning
 * that "a multi-venue fill is several prints — that is what makes it a sweep".
 *
 * That fabricated five things the source never reported: the print count, the
 * size at each venue, three event identities, their simultaneity, and the
 * venue diversity itself — which matters most, because the engine's sweep test
 * is `new Set(trades.map((t) => t.exchange)).size >= 2`. The label was
 * manufactured from the decomposition that produced it.
 *
 * Measured before the fix: one record in, `["AGG1-0","AGG1-1","AGG1-2"]` out,
 * classified SWEEP.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ingestPrint, drainIdle, onSignal, __clearSignalObservers, type RawPrint,
} from '../src/ingestion/flowEngineAdapter';
import type { ClassifiedSignal } from '../src/flow-engine/types';

/** A unique underlying per test — the adapter holds one module-level engine. */
function capture(underlying: string) {
  const got: ClassifiedSignal[] = [];
  onSignal((sig) => { if (sig.underlying === underlying) got.push(sig); });
  return got;
}

function base(symbol: string, over: Partial<RawPrint> = {}): RawPrint {
  return {
    symbol, expiry: '2026-12-18', strike: 100, right: 'C',
    price: 5, size: 60, bid: 4.9, ask: 5.0,
    openInterest: 5_000, underlyingPrice: 105, source: 'tradier',
    ...over,
  };
}

/** Feed, then push the watermark past the sweep window so the burst closes. */
function close(symbol: string, at: number): void {
  ingestPrint(base(symbol, { id: `${symbol}-z1`, ts: at + 10_000, strike: 900 }));
  ingestPrint(base(symbol, { id: `${symbol}-z2`, ts: at + 20_000, strike: 901 }));
  drainIdle(0);
}

test('one record declaring several venues stays one observed execution', (t) => {
  __clearSignalObservers();
  t.after(() => __clearSignalObservers());
  const got = capture('AGG');
  const t0 = Date.now();

  ingestPrint(base('AGG', {
    id: 'AGG1', ts: t0, exchanges: ['CBOE', 'PHLX', 'ISE'],
  }));
  close('AGG', t0);

  const sig = got.find((s) => s.printIds.some((p) => p.startsWith('AGG1')));
  assert.ok(sig, 'the record produced a signal');

  assert.deepEqual(sig.printIds, ['AGG1'],
    'one upstream record is one event id — no -0/-1/-2 children');
  assert.equal(sig.totalSize, 60, 'and the size is not redistributed');

  // The venue list is not an observation of three fills, so it cannot be what
  // makes this a sweep.
  const observedVenues = new Set(sig.legs.flatMap((l) => l.exchanges));
  assert.equal(observedVenues.size, 1,
    'the engine sees the venues it actually observed, which is one');
  assert.notEqual(sig.kind, 'SWEEP',
    'a single record must not be classified SWEEP on a declared venue list');
});

test('genuinely separate executions still cluster and still sweep', (t) => {
  // The protection must not cost the real case: a source that reports
  // individual fills at different venues is reporting observed diversity, and
  // that is what a sweep is.
  __clearSignalObservers();
  t.after(() => __clearSignalObservers());
  const got = capture('SEP');
  const t0 = Date.now();

  ingestPrint(base('SEP', { id: 'S1', ts: t0, size: 20, exchange: 'CBOE' }));
  ingestPrint(base('SEP', { id: 'S2', ts: t0 + 3, size: 20, exchange: 'PHLX' }));
  ingestPrint(base('SEP', { id: 'S3', ts: t0 + 6, size: 20, exchange: 'ISE' }));
  close('SEP', t0);

  const sig = got.find((s) => s.printIds.includes('S1'));
  assert.ok(sig, 'the burst produced a signal');
  assert.deepEqual(sig.printIds.sort(), ['S1', 'S2', 'S3']);
  assert.equal(sig.kind, 'SWEEP', 'three observed venues is a sweep');
  assert.equal(new Set(sig.legs.flatMap((l) => l.exchanges)).size, 3);
});

test('the source scan: nothing splits a size across a venue list', () => {
  // The defect was four lines of arithmetic. A future reintroduction would not
  // look like the old code, so this bans the *shape*: dividing a print's size
  // by the number of venues.
  const src = readFileSync(
    join(__dirname, '..', 'src', 'ingestion', 'flowEngineAdapter.ts'), 'utf8',
  );
  assert.doesNotMatch(src, /print\.size\s*\/\s*\w*venues?\w*\.length/i,
    'a size divided by a venue count is the fabrication this test exists for');
  assert.doesNotMatch(src, /venues\.forEach\s*\(/,
    'iterating venues to emit one trade event each is the same defect');
});

test('the simulation generates executions, not a venue list to be split', () => {
  // It was the only producer of multi-venue records, so it was relying on the
  // adapter's fabrication to look like a sweep. It now emits the prints.
  const src = readFileSync(
    join(__dirname, '..', 'src', 'ingestion', 'index.ts'), 'utf8',
  );
  assert.doesNotMatch(src, /exchanges:\s*venues/,
    'the simulation must not hand a venue list to one record');
});
