/**
 * A print whose expiry nothing could read was published as 0DTE.
 *
 * `ingestPrint` guards the five fields that make a contract, and CLAUDE.md
 * records `strike` joining that guard late — it had been checked for presence
 * and not for `> 0`, so `occSymbol` padded `Math.round(0 * 1000)` into a
 * real-looking symbol and the print was classified, scored and published.
 *
 * `expiry` was the same shape, on the sixth field, and was still checked for
 * **truthiness only**. Measured through the real adapter, one print at
 * 2026-09-24 against an October expiry:
 *
 *     expiry "2026-10-16" -> occ SPY261016C00550000    dte 22
 *     expiry "20261016"   -> occ SPY261016C00550000    dte  0
 *     expiry "10/16/2026" -> occ SPY/16/2026C00550000  dte  0
 *     expiry "not-a-date" -> occ SPYtadateC00550000    dte  0
 *     expiry "2026-13-45" -> occ SPY261345C00550000    dte  0
 *
 * Two distinct consequences. The OCC symbol is the contract's identity for the
 * NBBO book and the stats table, so a malformed one silently partitions or
 * merges contracts. And `days_to_expiry: 0` does not read as "unknown" — it
 * reads as 0DTE, which is a claim, and the loudest one on the board.
 *
 * The compact-ISO row is the one that makes this worth a guard rather than a
 * comment: `20261016` is a format a vendor could plausibly switch to, it yields
 * the CORRECT OCC symbol, and it publishes every contract as expiring today.
 * Nothing on any surface would look wrong.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ingestPrint, drainIdle, occSymbol, resetDaily,
  unreadableExpiryCounts, type RawPrint,
} from '../src/ingestion/flowEngineAdapter';

const TS = Date.parse('2026-09-24T17:00:00Z');

const print = (expiry: string, source = 'polygon'): RawPrint => ({
  source, symbol: 'SPY', expiry, right: 'C', strike: 550,
  price: 4.2, size: 900, exchanges: ['XCBO'], bid: 4.1, ask: 4.3, ts: TS,
});

const ingest = (p: RawPrint) => [...ingestPrint(p), ...drainIdle(0)];

test('a readable expiry is published with a real DTE', () => {
  resetDaily();
  const [sig] = ingest(print('2026-10-16'));
  assert.ok(sig, 'the control case still produces a signal');
  assert.equal(sig.days_to_expiry, 22);
  assert.equal(sig.expiry, '2026-10-16');
});

test('every unreadable expiry is refused rather than published as 0DTE', () => {
  // Each of these reached the wire as days_to_expiry: 0 before the gate.
  for (const bad of ['20261016', '2026-6-19', '10/16/2026', 'not-a-date', '2026-13-45', '2026-02-30']) {
    resetDaily();
    assert.deepEqual(ingest(print(bad)), [],
      `expiry ${JSON.stringify(bad)} must not produce a signal`);
  }
});

test('the compact-ISO case is the one that looked correct', () => {
  // It yields the right OCC symbol, so the only visible symptom was a DTE of
  // zero on every contract — indistinguishable from a tape of 0DTE flow.
  assert.equal(occSymbol('SPY', '20261016', 'C', 550),
    occSymbol('SPY', '2026-10-16', 'C', 550),
    'the two formats collapse to the same contract symbol, which is why a ' +
    'symbol check could never have caught this');
  resetDaily();
  assert.deepEqual(ingest(print('20261016')), []);
});

test('a refusal is counted and named, per source', () => {
  // The strike-0 refusal returns [] and tells nobody, so a connector whose
  // every row is rejected looks exactly like a quiet tape. This half is the
  // reason the finding is worth more than a dropped row.
  resetDaily();
  const before = unreadableExpiryCounts()['tastytrade']?.count ?? 0;
  ingest(print('16-OCT-2026', 'tastytrade'));
  ingest(print('16-OCT-2026', 'tastytrade'));
  const after = unreadableExpiryCounts()['tastytrade'];
  assert.ok(after, 'the source appears in the counts');
  assert.equal(after.count, before + 2);
  assert.equal(after.sample, '16-OCT-2026',
    'and the value is carried so a note can name the shape the vendor sent');
});

test('the count reaches /api/health through sourceNotes', () => {
  // The channel for "arriving and qualified" — the one `polygonQuoteNote` and
  // the unparsed-frame counters already use. Without it a vendor changing date
  // format is invisible, which is this repository's recurring finding rather
  // than a new one.
  const src = readFileSync(join(__dirname, '..', 'src', 'ingestion', 'index.ts'), 'utf8');
  const status = src.indexOf('export function getIngestionStatus');
  assert.ok(status > 0);
  const body = src.slice(status, src.indexOf('export function', status + 40));
  assert.match(body, /unreadableExpiryCounts\(\)/,
    'getIngestionStatus must read the refusal counts');
  assert.match(body, /notes\[source\]/,
    'and fold them into sourceNotes rather than sourceErrors — nothing is ' +
    'wrong with the connection, the prints are being refused downstream');
  // Not sourceErrors: an error is why nothing is arriving, a note is a
  // qualification on what is. A source can carry both.
  assert.ok(!/sourceErrors\[[^\]]*\]\s*=[^\n]*expiry/i.test(src));
});

test('the gate reuses the one home for reading an expiry', () => {
  // A regex here would be a second date rule beside `flow-engine/expiry.ts`,
  // whose docstring already argues why it rejects a loose parse — and two
  // rules that must agree about what a date is is the duplication this
  // repository keeps closing.
  const src = readFileSync(
    join(__dirname, '..', 'src', 'ingestion', 'flowEngineAdapter.ts'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  const gate = code.indexOf('export function ingestPrint');
  assert.ok(gate > 0);
  const body = code.slice(gate, gate + 1200);
  assert.match(body, /Number\.isNaN\(expiryInstantMs\(print\.expiry\)\)/,
    'the gate asks expiryInstantMs, not a local date regex');
  assert.ok(!/\\d\{4\}-\\d\{2\}-\\d\{2\}/.test(body),
    'and does not carry a second date-shape rule');
});

test('days_to_expiry is null, never a zero, when it cannot be computed', () => {
  // Unreachable behind the gate, and nullable anyway: the previous type could
  // not express the honest answer, which is the defect `SpotQuote.change` had
  // — a `number` field that forced two connectors to write a zero for a
  // reading the vendor had not sent.
  const src = readFileSync(
    join(__dirname, '..', 'src', 'ingestion', 'flowEngineAdapter.ts'), 'utf8');
  assert.match(src, /days_to_expiry: number \| null/,
    'the wire type admits that the DTE can be unknown');
  assert.ok(!/Number\.isNaN\(dte\) \? 0 :/.test(src),
    'and nothing substitutes a 0, which reads as 0DTE rather than as unknown');

  const fe = readFileSync(
    join(__dirname, '..', '..', 'frontend', 'lib', 'types.ts'), 'utf8');
  assert.match(fe, /days_to_expiry: number \| null/,
    'and the frontend contract matches, or the field drifts the way ' +
    'medianExcursion did');
});
