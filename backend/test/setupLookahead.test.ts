/**
 * The setup engine against the real structure engine, and the rules that keep
 * it honest: no look-ahead (prefix equals batch), one blocker vocabulary shared
 * with the trade ticket, a pinned rules version, purity, and no caller outside
 * research.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { Bar } from '../src/market/bar';
import { importBarsCsv } from '../src/market/barImport';
import { EMPTY_LEDGER, SETUP_BLOCKER_CODES, evaluateSetups } from '../src/setups';
import type { SetupIdea } from '../src/setups';
import {
  DEFAULT_SETUP_PARAMS, SETUP_METHOD_VERSION, SETUP_RULES_VERSION, SetupParams, setupMethodVersionOf, setupParamRefusals,
} from '../src/setups/params';
import { STRUCTURE_METHOD_VERSION } from '../src/structure/params';
import { stripComments } from './zeroDefaults';

const SRC = join(__dirname, '..', 'src');
const SETUPS = join(SRC, 'setups');
const FIX = join(__dirname, 'fixtures', 'bars');

function load(file: string, symbol: string): Bar[] {
  const r = importBarsCsv(readFileSync(join(FIX, file), 'utf8'), { symbol, timestampMarks: 'OPEN', source: 'synthetic' });
  assert.equal(r.status, 'OK');
  return (r as Extract<typeof r, { status: 'OK' }>).bars;
}

function cut(ideas: SetupIdea[], t: number) {
  return ideas
    .filter((i) => i.history[0].knownAt <= t)
    .map((i) => ({ ideaId: i.ideaId, sweepId: i.sweepId, history: i.history.filter((h) => h.knownAt <= t) }));
}

test('look-ahead guard: evaluating any prefix equals the batch result cut at that prefix', () => {
  const spy = load('SYNTHETIC_SPY_1m.csv', 'SPY').slice(0, 600);
  const qqq = load('SYNTHETIC_QQQ_1m.csv', 'QQQ').slice(0, 600);
  const opts = { costs: { roundTripPerUnit: 0.02 }, ledger: EMPTY_LEDGER };
  const batch = evaluateSetups(spy, { ...opts, pair: qqq });
  assert.equal(batch.status, 'OK');
  if (batch.status !== 'OK') return;
  assert.ok(batch.ideas.length > 10, 'the fixture produces ideas to check');
  for (const n of [60, 137, 250, 391, 452, 599]) {
    const t = spy[n - 1].closedAt;
    const pre = evaluateSetups(spy.slice(0, n), { ...opts, pair: qqq.slice(0, n) });
    assert.equal(pre.status, 'OK');
    if (pre.status !== 'OK') return;
    assert.deepEqual(cut(pre.ideas, t), cut(batch.ideas, t), `prefix ${n} saw something the batch knew only later`);
    const usedBy = (u: Record<string, number>) => Object.entries(u).filter(([, k]) => k <= t).sort();
    assert.deepEqual(usedBy(pre.ledger.used), usedBy(batch.ledger.used));
  }
});

test('deterministic: the same input twice is byte-identical', () => {
  const spy = load('SYNTHETIC_SPY_1m.csv', 'SPY').slice(0, 400);
  const qqq = load('SYNTHETIC_QQQ_1m.csv', 'QQQ').slice(0, 400);
  const run = () => JSON.stringify(evaluateSetups(spy, { pair: qqq, costs: { roundTripPerUnit: 0.02 }, ledger: EMPTY_LEDGER }));
  assert.equal(run(), run());
});

test('blocker codes are the trade ticket\'s codes: no second vocabulary', () => {
  const src = readFileSync(join(__dirname, '..', '..', 'frontend', 'lib', 'tradeTicket.ts'), 'utf8');
  const block = (name: string) => {
    const m = src.match(new RegExp(`export const ${name} = \\[([\\s\\S]*?)\\] as const`));
    assert.ok(m, `${name} not found in tradeTicket.ts`);
    return [...m![1].matchAll(/'([A-Z0-9_]+)'/g)].map((x) => x[1]);
  };
  const ticket = new Set([...block('README_CODES'), ...block('ADDED_CODES')]);
  assert.ok(ticket.size >= 16);
  for (const c of SETUP_BLOCKER_CODES) assert.ok(ticket.has(c), `${c} is not a trade-ticket blocker code`);
  const used = new Set([...readFileSync(join(SETUPS, 'sweepReclaim.ts'), 'utf8').matchAll(/code: '([A-Z0-9_]+)'/g)].map((m) => m[1]));
  for (const c of used) assert.ok((SETUP_BLOCKER_CODES as readonly string[]).includes(c), `${c} is emitted but not declared`);
});

test('version: params, rules and the structure version are all in SETUP_METHOD_VERSION', () => {
  const keys = Object.keys(DEFAULT_SETUP_PARAMS) as (keyof SetupParams)[];
  assert.equal(keys.length, 5, 'a new parameter must be added to this test deliberately');
  const seen = new Set([SETUP_METHOD_VERSION]);
  for (const k of keys) {
    const v = setupMethodVersionOf({ ...DEFAULT_SETUP_PARAMS, [k]: DEFAULT_SETUP_PARAMS[k] + 1 });
    assert.ok(!seen.has(v), `changing ${k} did not change the version`);
    seen.add(v);
  }
  assert.notEqual(setupMethodVersionOf(DEFAULT_SETUP_PARAMS, STRUCTURE_METHOD_VERSION + 'x'), SETUP_METHOD_VERSION);
  assert.ok(SETUP_METHOD_VERSION.startsWith(SETUP_RULES_VERSION + ':'));
  assert.ok(setupParamRefusals({ ...DEFAULT_SETUP_PARAMS, minNetR: 1.5 }).length > 0, 'the 2R floor cannot be lowered by a parameter');
});

/** sha256 of the setup engine's comment-stripped source. Update with a version bump only. */
const PIN = { rulesVersion: 'setup-rules/1', sourceSha256: '197e4a80cc4c89c7' };

test('the rules are pinned to SETUP_RULES_VERSION', () => {
  const files = readdirSync(SETUPS).filter((f) => f.endsWith('.ts') && f !== 'params.ts' && f !== 'index.ts').sort();
  const h = createHash('sha256');
  for (const f of files) h.update(f).update(stripComments(readFileSync(join(SETUPS, f), 'utf8')).replace(/\s+/g, ' '));
  const now = h.digest('hex').slice(0, 16);
  assert.equal(SETUP_RULES_VERSION, PIN.rulesVersion, `record ${SETUP_RULES_VERSION} and hash ${now} in PIN`);
  assert.equal(now, PIN.sourceSha256, `the setup rules changed (hash ${now}) without a SETUP_RULES_VERSION bump`);
});

test('the setup engine reads no clock, randomness, environment or timer', () => {
  const banned = [/\bDate\.now\s*\(/, /new\s+Date\s*\(\s*\)/, /\bMath\.random\b/, /\bprocess\./, /\b(setTimeout|setInterval)\s*\(/];
  for (const f of readdirSync(SETUPS)) {
    const code = stripComments(readFileSync(join(SETUPS, f), 'utf8'));
    for (const re of banned) assert.ok(!re.test(code), `${f}: ${re}`);
  }
});

test('nothing outside src/research calls the setup engine: no route, no connector, no recorder', () => {
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const e of readdirSync(dir)) {
      const full = join(dir, e);
      if (statSync(full).isDirectory()) walk(full, out); else if (full.endsWith('.ts')) out.push(full);
    }
    return out;
  };
  const callers = walk(SRC)
    .filter((f) => !f.startsWith(SETUPS + '/') && !f.startsWith(join(SRC, 'research') + '/'))
    .filter((f) => [...stripComments(readFileSync(f, 'utf8')).matchAll(/from\s*['"](\.[^'"]+)['"]/g)]
      .some((m) => resolve(dirname(f), m[1]).startsWith(SETUPS)))
    .map((f) => relative(SRC, f));
  assert.deepEqual(callers, []);
});
