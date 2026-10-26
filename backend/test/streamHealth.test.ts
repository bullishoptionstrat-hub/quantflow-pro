/**
 * Every WebSocket the ingestion layer opens is watched for silence, and none
 * drops an unparseable frame without counting it.
 *
 * The Tradier socket got both in one change; Twelve Data's (the grader's only
 * price source) and Tastytrade's had neither: a bare `catch {}` on every frame
 * and a reconnect that ran on `close` alone. The unparsed-frame counter lived
 * in `ingestion/index.ts`, which a connector cannot import without a cycle,
 * which is how the two were left out. The scan is over every file that opens a
 * socket rather than a list, so the next connector is covered when it is added.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { noteUnparsedFrame, unparsedFrameCounts } from '../src/ingestion/frameHealth';

const SRC = join(__dirname, '..', 'src');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [];
  });
}

const SOCKET_FILES = walk(SRC).filter((f) => readFileSync(f, 'utf8').includes('new WebSocket('));

test('the scan finds the sockets it is meant to cover', () => {
  // A scan that finds nothing passes everything; three is what exists today.
  assert.ok(SOCKET_FILES.length >= 3, `found ${SOCKET_FILES.length}`);
});

for (const file of SOCKET_FILES) {
  const rel = file.slice(SRC.length + 1);
  const src = readFileSync(file, 'utf8');
  test(`${rel}: the socket is watched for silence`, () => {
    assert.match(src, /watchLiveness\(/);
  });
  test(`${rel}: no handler swallows a frame silently`, () => {
    assert.doesNotMatch(src, /catch\s*\{\s*\}/, 'a bare catch drops the frame with no count');
    assert.match(src, /noteUnparsedFrame\(/);
  });
}

test('unparsed frames are counted per source', () => {
  const before = unparsedFrameCounts().streamhealthtest ?? 0;
  noteUnparsedFrame('streamhealthtest');
  noteUnparsedFrame('streamhealthtest');
  assert.equal(unparsedFrameCounts().streamhealthtest, before + 2);
});

test('the counts reach /api/health through sourceNotes', () => {
  const src = readFileSync(join(SRC, 'ingestion', 'index.ts'), 'utf8');
  assert.match(src, /Object\.entries\(unparsedFrameCounts\(\)\)/);
});
