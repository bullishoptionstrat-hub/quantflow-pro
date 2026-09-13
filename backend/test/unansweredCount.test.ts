/**
 * A count the database did not answer is not a count of zero.
 *
 * `SupabaseSignalStore.count()` ended `return count ?? 0`. On every PostgREST
 * response `count` is `number | null` — the number rides in the
 * `Content-Range` header, and a response that arrives without one parses to
 * `null` **with `error` unset**, so the `if (error) throw` above it never
 * fired. The `?? 0` then turned "nobody answered" into the claim "zero rows",
 * on `/api/track-record` — the endpoint whose whole purpose is saying what
 * this deployment has actually measured.
 *
 * This is the ledger's own rule reaching the layer it had not been pointed at.
 * `defaultedReadings.test.ts` says an invented number is a finding by default,
 * and scoped itself to `src/ingestion/` because that is where vendor data
 * enters — while recording, in writing, that the eighteen sites elsewhere were
 * "unguarded by this rule rather than judged clean by it". This was one of the
 * eighteen, and it was not clean. The defect is the same one `occ.ts` had:
 * a number meaning *unknown*, published as a confident zero, and
 * indistinguishable at the reader from the real measurement.
 *
 * Three different lies came out of the one line, and the third is the reason
 * a `?? 0` on a count is worse than it looks:
 *
 *   1. `countSignals()` → `{ total: 0, synthetic: 0, real: 0 }`, which reads
 *      as *the recorder is discarding everything* — the exact failure the
 *      persistence module exists to make impossible to have by accident. An
 *      operator reading it goes looking at the recorder, and the recorder is
 *      fine.
 *   2. `total` and `synthetic` are two separate round-trips, so one can answer
 *      while the other does not. `real: total - synthetic` then overstates the
 *      research population by precisely the synthetic signals it exists to
 *      exclude — and unlike case 1 it does not look broken at all.
 *   3. In `trackRecord()` all three `excluded` counts drive the `notes[]` that
 *      tell the reader why rows were left out. At zero the notes fall silent,
 *      so a report that *had* excluded rows describes itself as having
 *      excluded none.
 *
 * The store's stated posture is that uncertainty resolves to refusal, not to
 * permission. `/api/track-record` already answers a throw with a 500 that
 * names the failure, so refusing is both honest and already handled.
 *
 * What this test does not cover: a count that is answered but *wrong*, and the
 * fact that `total` and `synthetic` are still two queries and so still not a
 * consistent snapshot. Both counts answering does not make them simultaneous;
 * a signal written between them is counted by one and not the other. That is a
 * smaller error than this one and it is not fixed here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SupabaseSignalStore } from '../src/persistence/supabaseStore';

type CountReply = { count: number | null; error: { message: string } | null };

/**
 * The narrowest client that reaches `count()`: `.from(t).select(...)` with any
 * number of `.eq()`/`.neq()` filters chained on, awaited for a reply.
 *
 * `replies` is consumed in call order, so a test can make the first count
 * answer and the second not — which is the asymmetry that produces the
 * quietest of the three failures.
 */
function stubDb(replies: CountReply[]): SupabaseClient {
  let i = 0;
  const builder: any = {
    select: () => builder,
    eq: () => builder,
    neq: () => builder,
    then: (resolve: (r: CountReply) => unknown) => {
      const reply = replies[Math.min(i, replies.length - 1)];
      i += 1;
      return Promise.resolve(resolve(reply!));
    },
  };
  return { from: () => builder } as unknown as SupabaseClient;
}

const unanswered: CountReply = { count: null, error: null };
const answered = (n: number): CountReply => ({ count: n, error: null });

test('an unanswered count throws rather than reporting zero', async () => {
  const store = new SupabaseSignalStore(stubDb([unanswered]));
  await assert.rejects(
    () => store.countSignals(),
    (err: Error) => {
      assert.match(err.message, /signal_history/,
        'the error must name the table, so the reader knows which query went unanswered');
      assert.match(err.message, /0/,
        'and must say what the old behaviour would have claimed');
      return true;
    },
    'a null count with no error was reported as `total: 0` — indistinguishable ' +
    'from a deployment that has recorded nothing',
  );
});

test('a real zero is still a zero', async () => {
  // The fix must not turn an empty table into an error: "nothing recorded yet"
  // is a true and useful answer, and it is the state every new deployment is
  // in. Only the *absent* count is refused.
  const store = new SupabaseSignalStore(stubDb([answered(0)]));
  assert.deepEqual(await store.countSignals(), { total: 0, synthetic: 0, real: 0 });
});

test('one count answering and the other not cannot produce a population', async () => {
  // The quiet case. `total` resolves, `synthetic` does not, and `?? 0` gave
  // `real = 500 - 0` — every synthetic signal silently promoted into the
  // research population that exists to exclude them. Nothing about the
  // response looks wrong.
  const store = new SupabaseSignalStore(stubDb([answered(500), unanswered]));
  await assert.rejects(() => store.countSignals(),
    'a half-answered pair must not be published as a population');
});

test('the exclusion counts behind the track-record notes refuse the same way', async () => {
  // `trackRecord()` counts three exclusions before it reads any signal, and
  // each one at zero removes a sentence from `notes[]`. A report that dropped
  // rows and says it dropped none is worse than no report.
  const store = new SupabaseSignalStore(stubDb([unanswered]));
  await assert.rejects(() => store.trackRecord(),
    'an unanswered exclusion count must not be published as "nothing excluded"');
});

test('a genuine query error still names itself', async () => {
  // The pre-existing `error` branch is the one failure mode that was already
  // handled; the new check must not shadow it with the less specific message.
  const store = new SupabaseSignalStore(
    stubDb([{ count: null, error: { message: 'permission denied for relation' } }]),
  );
  await assert.rejects(() => store.countSignals(), /permission denied for relation/);
});
