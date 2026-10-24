/**
 * The `in.(…)` filters the Supabase store sends, held under a byte budget.
 *
 * `npm run test:pg` measured the limit against a real PostgREST: the server
 * echoes the URL back in `Content-Location`, Node's `fetch` refuses a response
 * header over 16 KB, so a filter of about 240 signal keys fails, and 2,000 are
 * refused outright with 400. Every `in.(…)` the store built was past that at
 * production sizes. That suite needs a database; this one does not, and runs
 * on every `npm test`, so the rule cannot quietly come undone between runs of
 * the slower one.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { inListChunks } from '../src/persistence/supabaseStore';

const key = (i: number) => i.toString(16).padStart(64, '0');
const encodedBytes = (chunk: string[]) => encodeURIComponent(chunk.join(',')).length;

test('a 2,000-key list — what recover() asks about at its production limit — is split under the budget', () => {
  const keys = Array.from({ length: 2000 }, (_, i) => key(i));
  const chunks = inListChunks(keys);
  assert.ok(chunks.length > 1);
  for (const c of chunks) assert.ok(encodedBytes(c) <= 6_000, `chunk of ${c.length} is ${encodedBytes(c)} bytes`);
  // Nothing dropped, nothing duplicated, order kept.
  assert.deepEqual(chunks.flat(), keys);
});

test('the budget is well under the 16 KB the client was measured to fail at', () => {
  // 240 keys is where the measured failure begins; a chunk must be far below it.
  const [first] = inListChunks(Array.from({ length: 1000 }, (_, i) => key(i)));
  assert.ok(first!.length < 120, `first chunk holds ${first!.length} keys`);
});

test('a key longer than the budget still goes, alone, rather than being dropped', () => {
  const long = 'x'.repeat(7_000);
  assert.deepEqual(inListChunks(['a', long, 'b']), [['a'], [long], ['b']]);
});

test('an empty list is no chunks, so no request with an empty in.() is made', () => {
  assert.deepEqual(inListChunks([]), []);
});

test('every in.() the Supabase store builds is fed by inListChunks', () => {
  const src = readFileSync(path.join(__dirname, '../src/persistence/supabaseStore.ts'), 'utf8');
  const calls = [...src.matchAll(/\.in\('signal_key',\s*([^)]+)\)/g)].map((m) => m[1]!.trim());
  assert.ok(calls.length >= 3, `expected the three in.() call sites, found ${calls.length}`);
  for (const arg of calls) assert.equal(arg, 'chunk', `an in.() is fed by ${arg}, not by a chunk`);
  const loops = src.match(/for \(const chunk of inListChunks\(/g) ?? [];
  assert.equal(loops.length, calls.length, 'each chunk must come from inListChunks, not a count-based slice');
});
