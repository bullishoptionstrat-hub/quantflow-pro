/**
 * MERGE-INTEGRATION REGRESSION — a keyless connector must be `disabled` in
 * sourceHealth, not merely in the `sources` map.
 *
 * `startConnector` replaced thirteen hand-written `.then/.catch` pairs, every
 * one of which called `recordDisabled(name)`. The replacement did not, and
 * nothing failed: `sources[name]` was still set to 'disabled', so the health
 * route's summary line looked right while the per-source lifecycle silently
 * regressed to 'never_reported'.
 *
 * That distinction is the whole point of the field. 'never_reported' means "we
 * are waiting on it"; 'disabled' means "it will never report, and here is why".
 * Collapsing the second into the first is how thirteen dead sources hide in a
 * list of things that merely have not arrived yet.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { startConnector, missingCredentials } from '../src/ingestion/index';
import { getSourceHealth, registerSource } from '../src/ingestion/sourceHealth';

function lifecycleOf(name: string): string | undefined {
  return getSourceHealth().find((s) => s.source === name)?.lifecycle;
}

test('a connector with missing credentials is disabled in sourceHealth', async () => {
  // No connector credentials are set in the test environment.
  assert.ok(
    missingCredentials('flashalpha').length > 0,
    'precondition: flashalpha must have unset credentials for this test to mean anything',
  );

  registerSource('flashalpha');
  assert.notEqual(lifecycleOf('flashalpha'), 'disabled', 'precondition: not already disabled');

  // A keyless connector's start() resolves immediately without fetching.
  await startConnector('flashalpha', async () => undefined);

  assert.equal(
    lifecycleOf('flashalpha'), 'disabled',
    'a connector that returned early for missing credentials must not read as never_reported',
  );
});

test('a connector that throws is disabled in sourceHealth too', async () => {
  registerSource('twelvedata');
  await startConnector('twelvedata', async () => { throw new Error('boom'); });
  assert.equal(lifecycleOf('twelvedata'), 'disabled');
});

test('a connector that starts cleanly is NOT marked disabled', async () => {
  // Guards against "recordDisabled everywhere" passing the tests above
  // vacuously. coingecko is genuinely keyless, so it should connect.
  assert.equal(missingCredentials('coingecko').length, 0, 'coingecko is a keyless connector');

  registerSource('coingecko');
  await startConnector('coingecko', async () => undefined);

  assert.notEqual(lifecycleOf('coingecko'), 'disabled');
});
