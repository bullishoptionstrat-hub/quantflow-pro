/**
 * ROADMAP 5.3 — alerting that names its own trigger.
 *
 * Ledger line 98: the power-alerts page described a trigger the code did not
 * implement and credited a model that did not exist. The fix that followed
 * corrected the sentence. This holds the shape: the rule that fires is
 * published as data on the signal it fired for, `is_unusual` is derived from
 * it, and every sentence that summarises it is held to the constant.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ingestPrint, drainIdle, resetDaily, unusualTriggerOf, UNUSUAL_SCORE,
  type RawPrint,
} from '../src/ingestion/flowEngineAdapter';

const FRONTEND = join(__dirname, '..', '..', 'frontend');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');

test('the trigger fires at the threshold, not below it, and never on NaN', () => {
  assert.equal(unusualTriggerOf(UNUSUAL_SCORE - 1), null);
  assert.equal(unusualTriggerOf(Number.NaN), null, 'an unreadable score fires nothing');

  const t = unusualTriggerOf(UNUSUAL_SCORE);
  assert.ok(t, 'the threshold itself fires: the rule is >=');
  assert.equal(t.rule, 'UNUSUAL_SCORE');
  assert.equal(t.field, 'heat_score');
  assert.equal(t.op, '>=');
  assert.equal(t.threshold, UNUSUAL_SCORE);
  assert.equal(t.value, UNUSUAL_SCORE);
});

test('the readable line is built from the fields, so it cannot say something else', () => {
  const t = unusualTriggerOf(88)!;
  assert.equal(t.text, `heat_score 88 >= ${UNUSUAL_SCORE} (UNUSUAL_SCORE)`);
  assert.ok(t.text.includes(String(t.value)) && t.text.includes(String(t.threshold)));
});

test('on the wire, the flag and the stated rule agree on every signal', () => {
  // A spread of premiums so the sample is not one score. Both branches are
  // also covered directly above; this holds the *pairing* on real wire output.
  const T0 = Date.parse('2026-06-15T14:30:00Z');
  const base: RawPrint = {
    ts: T0, symbol: 'TRIG', expiry: '2026-06-19', strike: 550, right: 'C',
    price: 5, size: 400, exchange: 'CBOE', bid: 4.9, ask: 5,
    openInterest: 100, underlyingPrice: 545, source: 'unit-test',
  };
  resetDaily();
  const out = [];
  for (const [i, size] of [10, 400, 5_000, 40_000].entries()) {
    out.push(...ingestPrint({ ...base, symbol: `TRIG${i}`, size, ts: T0 + i * 10_000 }));
  }
  out.push(...drainIdle(0));
  assert.ok(out.length > 0, 'the sample produced signals');

  for (const sig of out) {
    assert.ok('alert_trigger' in sig, 'the key is always present, null when nothing fired');
    assert.equal(sig.is_unusual, sig.alert_trigger !== null);
    if (sig.alert_trigger) {
      assert.equal(sig.alert_trigger.value, sig.heat_score, 'the value is the signal\'s own score');
      assert.equal(sig.alert_trigger.threshold, UNUSUAL_SCORE);
    }
  }
});

test('the frontend declares the trigger fields the backend publishes, and no others', () => {
  const fieldsOf = (src: string, name: string) => {
    const at = src.indexOf(`export interface ${name} {`);
    assert.ok(at >= 0, `${name} is declared`);
    const body = src.slice(at, src.indexOf('\n}', at));
    return new Set([...strip(body).matchAll(/^\s{2}([a-zA-Z_][a-zA-Z0-9_]*)\??:/gm)].map((m) => m[1]!));
  };
  const backend = fieldsOf(
    readFileSync(join(__dirname, '..', 'src', 'ingestion', 'flowEngineAdapter.ts'), 'utf8'), 'AlertTrigger');
  const frontend = fieldsOf(readFileSync(join(FRONTEND, 'lib', 'types.ts'), 'utf8'), 'AlertTrigger');
  assert.ok(backend.size >= 6, `parsed ${backend.size} backend fields`);
  assert.deepEqual([...frontend].filter((f) => !backend.has(f)), [],
    'a field the frontend reads and the backend does not send renders empty');
});

test('the page\'s summary sentence states the backend\'s threshold', () => {
  // The sentence is a summary; the row is the authority. A summary that
  // disagrees with the constant is ledger line 98 again.
  const page = strip(readFileSync(join(FRONTEND, 'app', 'power-alerts', 'page.tsx'), 'utf8'));
  assert.match(page, new RegExp(`scores a signal ${UNUSUAL_SCORE} or above`));
  // The channel thresholds are read from where they run, not restated.
  assert.match(page, /\$\{SPEAK_ABOVE\}/);
  assert.match(page, /\$\{PUSH_ABOVE\}/);
  assert.match(page, /triggerText\(alert\)/, 'every row names its rule');
  assert.match(page, /channelText\(c\)/, 'and every channel it reached');
});

test('the frontend never restates the alert threshold', () => {
  // Its only knowledge of the rule is what the backend sends. A fallback like
  // "heat >= 75" for an older backend would be a second home for the number.
  const rules = strip(readFileSync(join(FRONTEND, 'lib', 'alertRules.ts'), 'utf8'));
  assert.ok(!new RegExp(`\\b${UNUSUAL_SCORE}\\b`).test(rules),
    `lib/alertRules.ts must not contain ${UNUSUAL_SCORE}`);
  assert.match(rules, /trigger: event\.alert_trigger \?\? null/, 'the alert carries the backend\'s rule');
});

test('no out-of-band channel fires outside the alert path', () => {
  // Speech and the desktop notification used to be checked beside the alert,
  // so they held only while 80 and 85 sat above 75. They run after the
  // early return now; raising UNUSUAL_SCORE can no longer leave the terminal
  // speaking trades no row records.
  const hook = strip(readFileSync(join(FRONTEND, 'hooks', 'useFlowFeed.ts'), 'utf8'));
  const gate = hook.indexOf('if (!isPowerAlert(event)) return');
  assert.ok(gate >= 0, 'the hook returns early for a non-alert');
  for (const call of ['speakAlert(event, say)', 'pushNotification(event, push)', 'addPowerAlert({ ...alert, channels })']) {
    const at = hook.indexOf(call);
    assert.ok(at > gate, `${call} runs only after the alert gate`);
  }
  // Each channel reports back, delivered or not.
  assert.match(hook, /delivered: false, reason: 'voice is off'/);
  assert.match(hook, /delivered: true/);
});
