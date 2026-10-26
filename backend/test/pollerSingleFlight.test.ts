import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { singleFlight, pollerHealth, resetPollerHealth } from '../src/ingestion/singleFlight';

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (e: Error) => void } {
  let resolve!: () => void; let reject!: (e: Error) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test('a cycle does not start while the previous one is still running', async () => {
  resetPollerHealth();
  let started = 0;
  const gate = deferred();
  const cycle = singleFlight('t:overlap', async () => { started++; await gate.promise; });

  const first = cycle();
  await cycle();            // fires while the first is in flight
  await cycle();
  assert.equal(started, 1, 'an overlapping cycle ran');
  assert.equal(pollerHealth()['t:overlap']?.skipped, 2);
  assert.notEqual(pollerHealth()['t:overlap']?.inFlightSince, null);

  gate.resolve();
  await first;
  await cycle();            // the guard releases once the cycle ends
  assert.equal(started, 2);
  assert.equal(pollerHealth()['t:overlap']?.inFlightSince, null);
});

test('a rejected cycle is counted, releases the guard, and does not escape', async () => {
  resetPollerHealth();
  let calls = 0;
  const cycle = singleFlight('t:reject', async () => { calls++; throw new Error('vendor said no'); });
  await cycle();            // must not reject: an unhandled rejection ends the process
  await cycle();
  assert.equal(calls, 2, 'a failure left the guard held');
  assert.equal(pollerHealth()['t:reject']?.failed, 2);
});

test('a poller that never skipped or failed is not reported', async () => {
  resetPollerHealth();
  await singleFlight('t:quiet', async () => {})();
  assert.equal(pollerHealth()['t:quiet'], undefined);
});

/**
 * The rule, not the instances: no `setInterval` in `src/` is handed an async
 * function directly. It walks every file rather than a list, because a list of
 * pollers is how a new one would go unguarded.
 */
test('no setInterval in src/ is handed an async function without singleFlight', () => {
  const files: string[] = [];
  const walk = (d: string): void => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith('.ts')) files.push(p);
    }
  };
  walk(join(__dirname, '../src'));

  const offenders: string[] = [];
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    const asyncNames = new Set<string>([
      ...[...src.matchAll(/async function (\w+)/g)].map((m) => m[1]!),
      ...[...src.matchAll(/(?:const|let) (\w+)\s*=\s*async\b/g)].map((m) => m[1]!),
    ]);
    for (const m of src.matchAll(/setInterval\(/g)) {
      const head = src.slice(m.index! + m[0].length, m.index! + m[0].length + 160);
      if (/^\s*singleFlight\(/.test(head)) continue;
      const line = src.slice(0, m.index!).split('\n').length;
      if (/^\s*async\b/.test(head)) { offenders.push(`${f}:${line} (inline async)`); continue; }
      for (const n of asyncNames) {
        if (new RegExp(`^\\s*(?:\\(\\)\\s*=>\\s*\\{?\\s*(?:void\\s+)?)?${n}\\b`).test(head)) {
          offenders.push(`${f}:${line} (${n})`);
        }
      }
    }
  }
  assert.deepEqual(offenders, [], 'pollers that can overlap their own previous cycle');
});

test('the scan catches the forms it has to catch', () => {
  // Exercised on the shapes this change replaced, so the detector is known to
  // bite even with nothing live left in src/ for it to find.
  const forms = [
    'setInterval(poll, 60_000)',
    'setInterval(() => { void tick(); }, 20_000)',
    'setInterval(async () => { await x(); }, 1000)',
  ];
  const asyncNames = ['poll', 'tick'];
  for (const f of forms) {
    const head = f.slice('setInterval('.length);
    const hit = /^\s*async\b/.test(head) || asyncNames.some((n) =>
      new RegExp(`^\\s*(?:\\(\\)\\s*=>\\s*\\{?\\s*(?:void\\s+)?)?${n}\\b`).test(head));
    assert.ok(hit, `scan missed: ${f}`);
  }
});

test('/api/health publishes poller health', () => {
  const src = readFileSync(join(__dirname, '../src/ingestion/index.ts'), 'utf8');
  assert.match(src, /pollers: pollerHealth\(\)/);
});

test('a skipped or failed cycle reaches sourceNotes under its source', async () => {
  const { getIngestionStatus } = await import('../src/ingestion/index');
  resetPollerHealth();
  const gate = deferred();
  const slow = singleFlight('coingecko:prices', async () => { await gate.promise; });
  const first = slow();
  await slow();
  await singleFlight('fred', async () => { throw new Error('x'); })();

  const notes = getIngestionStatus().sourceNotes as Record<string, string>;
  assert.match(notes['coingecko'] ?? '', /coingecko:prices: 1 poll cycle\(s\) skipped/);
  assert.match(notes['fred'] ?? '', /fred: 1 poll cycle\(s\) failed outright/);

  gate.resolve();
  await first;
  resetPollerHealth();
});
