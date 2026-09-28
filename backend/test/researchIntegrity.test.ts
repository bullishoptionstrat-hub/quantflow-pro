/**
 * The research record's integrity, held mechanically where it can be.
 *
 *   INV-RESEARCH-001  no holdout result is viewed without an exposure-ledger
 *                     entry — enforced here as far as a file can enforce a
 *                     process: the ledger's shape, its role vocabulary, and
 *                     that nothing has touched H-001-v2's windows yet.
 *   INV-RESEARCH-002  one economic event is one observation — the meta-event
 *                     rule H-001-v2 freezes, tested as behaviour.
 *   frozen means frozen — both H-001 files are pinned by hash. v1 must stay
 *                     byte-for-byte what was registered on 2026-09-23; v2 may
 *                     only change in a diff that also changes its pin, which is
 *                     a visible act, and after data is accessed it may not
 *                     change at all (a change is H-001-v3).
 *
 * A ledger that does not exist cannot be consulted, and one with free-text
 * roles cannot be checked, so the vocabulary is closed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { groupMetaEvents } from '../src/research/metaEvents';

const RESEARCH = join(__dirname, '..', '..', 'research');

/** RFC-4180 enough for these files: quoted fields, doubled quotes, commas inside quotes. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const sha = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');

test('H-001 v1 is exactly what was frozen, and v2 is pinned', () => {
  assert.equal(sha(join(RESEARCH, 'hypotheses', 'H-001-aggressive-call-buying-spy.md')),
    '504ebae121bcc4b5995032c3c0ee87113ae0f54ae63644e6fa85ccb00ba410cb',
    'H-001 v1 was edited. It is a preregistration: supersede it, never rewrite it.');
  assert.equal(sha(join(RESEARCH, 'hypotheses', 'H-001-v2-aggressive-call-buying-spy.md')),
    '9c24d028aff6ddf14803a661004d26e87b2542f93272230cbcb565743f144e76',
    'H-001-v2 changed. Before data is accessed, update this pin in the same diff; after, register H-001-v3 instead.');
});

test('the exposure ledger has the §19 fields and a closed role vocabulary', () => {
  const rows = parseCsv(readFileSync(join(RESEARCH, 'DATASET_EXPOSURE_LEDGER.csv'), 'utf8'));
  assert.deepEqual(rows[0], [
    'dataset_id', 'date_from', 'date_to', 'instrument', 'event_type', 'accessed_at',
    'experiment', 'actor', 'statistics_viewed', 'role', 'reason',
  ]);
  for (const r of rows.slice(1)) {
    assert.equal(r.length, rows[0]!.length, `a malformed ledger row: ${r.join(' | ')}`);
    assert.ok(['DEVELOPMENT', 'VALIDATION', 'HOLDOUT', 'CONTAMINATED'].includes(r[9]!), `unknown role ${r[9]}`);
    assert.match(r[5]!, /^\d{4}-\d{2}-\d{2}$/, 'accessed_at is a date');
    assert.ok(r[10]!.length > 20, 'every access carries a reason');
  }
});

test('nothing has touched H-001-v2\'s confirmatory or holdout windows (INV-RESEARCH-001)', () => {
  // When the confirmatory window is loaded, this test is changed in the same
  // diff that adds the ledger row — with the analysis commit recorded in it.
  // The holdout stays untouched for H-001-v2 entirely.
  const rows = parseCsv(readFileSync(join(RESEARCH, 'DATASET_EXPOSURE_LEDGER.csv'), 'utf8')).slice(1);
  const overlaps = (from: string, to: string, a: string, b: string) => from <= b && a <= to;
  for (const r of rows) {
    assert.ok(!overlaps(r[1]!, r[2]!, '2026-01-02', '2026-06-30'), `${r[0]} touches the CONFIRMATORY window`);
    assert.ok(!overlaps(r[1]!, r[2]!, '2026-07-01', '2026-08-14'), `${r[0]} touches the HOLDOUT window`);
  }
});

test('the search ledger has the §20 fields and records every registered version', () => {
  const rows = parseCsv(readFileSync(join(RESEARCH, 'SEARCH_LEDGER.csv'), 'utf8'));
  assert.deepEqual(rows[0], ['experiment', 'version', 'registered_at', 'parameters', 'result_viewed', 'decision', 'notes']);
  const versions = rows.slice(1).map((r) => `${r[0]}/${r[1]}`);
  assert.ok(versions.includes('H-001/v1') && versions.includes('H-001/v2'), 'a superseded version is kept, never deleted');
  for (const r of rows.slice(1)) assert.ok(['yes', 'no'].includes(r[4]!), 'result_viewed is yes or no');
});

test('one economic event is one observation (INV-RESEARCH-002)', () => {
  const t0 = Date.parse('2026-03-10T14:00:00Z');
  const min = 60_000;
  // A burst of twenty signals inside fifteen minutes is ONE meta-event.
  const burst = Array.from({ length: 20 }, (_, i) => ({ signalId: `b${i}`, decisionAt: t0 + i * 30_000 }));
  const one = groupMetaEvents(burst, 15 * min);
  assert.equal(one.length, 1);
  assert.equal(one[0]!.signalIds.length, 20);
  // The next meta-event starts at or after the window, so outcome windows never overlap.
  const spaced = groupMetaEvents([
    { signalId: 'a', decisionAt: t0 },
    { signalId: 'b', decisionAt: t0 + 14 * min + 59_999 },
    { signalId: 'c', decisionAt: t0 + 15 * min },
    { signalId: 'd', decisionAt: t0 + 29 * min },
  ], 15 * min);
  assert.deepEqual(spaced.map((m) => m.signalIds), [['a', 'b'], ['c', 'd']]);
  for (let i = 1; i < spaced.length; i++) {
    assert.ok(spaced[i]!.startsAt >= spaced[i - 1]!.startsAt + 15 * min);
  }
  // A meta-event never spans two sessions, and input order does not matter.
  const twoDays = groupMetaEvents([
    { signalId: 'late', decisionAt: Date.parse('2026-03-10T19:55:00Z') },
    { signalId: 'early', decisionAt: Date.parse('2026-03-11T13:31:00Z') },
  ].reverse(), 24 * 60 * min);
  assert.deepEqual(twoDays.map((m) => [m.date, m.signalIds]), [['2026-03-10', ['late']], ['2026-03-11', ['early']]]);
  assert.throws(() => groupMetaEvents([], 0), RangeError);
});
