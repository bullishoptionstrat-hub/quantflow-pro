/**
 * Documentation cannot advertise a feature that is not in the tree. (INV-014)
 *
 * `README.md` carried **"ML unusual score (GradientBoosting) ✅"** in its
 * feature table and headed a deployment section **"Backend + ML → Render.com"**
 * — for a service deleted several PRs earlier, whose `train.py` drew the label
 * before sampling the features. A reader following that README would have gone
 * looking for a model, and a reader evaluating the product would have believed
 * one was scoring their flow.
 *
 * `renderBlueprint.test.ts` already holds env-var declarations to the code in
 * both directions, and `schemaSetup.test.ts` holds the setup docs to the
 * migrations. This is the same rule applied to capability claims: a feature
 * table is an assertion about the tree, and nothing was checking it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..', '..');
const README = readFileSync(join(ROOT, 'README.md'), 'utf8');

/**
 * Claims whose subject must exist on disk for the claim to be true.
 *
 * Keyed by a pattern that appears in the docs only when the claim is being
 * made, and a path whose presence is what would make it true.
 */
const CLAIMS_REQUIRING_CODE: Array<{
  what: string; pattern: RegExp; requires: string; why: string;
}> = [
  {
    what: 'an ML scoring service',
    pattern: /\bML\b(?![- ]?(?:free|less))|GradientBoosting|machine learning|flow_scorer/i,
    requires: 'ml-service',
    why:
      'the ML service was deleted — it trained on np.random with the label ' +
      'drawn before the features, and nothing in backend/src ever called it',
  },
  {
    what: 'an experiment registry',
    pattern: /research\/experiments|preregistration|preregistered/i,
    requires: 'research/experiments',
    why: 'the registry described in TIER4_FINAL_REPORT.md is not in this tree',
  },
];

test('the README does not advertise code that is absent from the tree', () => {
  for (const c of CLAIMS_REQUIRING_CODE) {
    const claimed = c.pattern.test(README);
    const exists = existsSync(join(ROOT, c.requires));
    if (claimed && !exists) {
      assert.fail(
        `README claims ${c.what}, but ${c.requires}/ does not exist — ${c.why}.\n` +
        `  Either restore the capability or remove the claim; a feature table ` +
        `is an assertion about this tree.`,
      );
    }
  }
});

test('the detector is exercised on the shape actually found', () => {
  // With the claims removed there is nothing live left to catch, and a check
  // with nothing to check stops working quietly. So the patterns are run
  // against the text that really shipped.
  const shipped = '| ML unusual score (GradientBoosting) | 9 |\n### Backend + ML -> Render.com';
  assert.ok(CLAIMS_REQUIRING_CODE[0]!.pattern.test(shipped),
    'the detector must match the row that was actually in the README');

  // And must not fire on ordinary prose that merely mentions the absence.
  assert.ok(!CLAIMS_REQUIRING_CODE[1]!.pattern.test('no experiment registry exists here'),
    'a pattern this broad would make the guard unusable');
});

test('capability claims that outrun the evidence are qualified, not ticked', () => {
  // A flow feed carrying simulated prints must not appear beside a bare tick.
  // The terminal is styled to look like a live institutional product; the
  // feature table is where a reader decides whether it is one.
  const flowRow = README.split('\n').find((l) => /\| *Live flow feed/i.test(l));
  assert.ok(flowRow, 'the flow feed row is still in the table');
  assert.doesNotMatch(flowRow, /\|\s*✅\s*\|\s*$/,
    'the flow feed carries simulated prints on a keyless deployment and the ' +
    'row must say so rather than showing an unqualified tick');
  assert.match(flowRow, /simulated/i);
});
