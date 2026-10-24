# Grading across restarts and sleep — what code fixed, and what only uptime can

Status: 2026-10-24. Nothing here has been purchased or subscribed to. The Render
facts below are **SEARCH_ONLY**: `render.com` is refused by this environment's
egress policy, so they come from search results and have not been read on
Render's own pages. Check each one on the official pricing and docs pages before
deciding.

## What a restart used to lose

A signal is graded at three checkpoints measured from its `decisionAt`: M15, H1
and D1. Each is the move from an **entry mark** (the underlying's price at the
decision) to an **exit mark** (the price at the checkpoint).

Recovery after a restart (`SignalGrader.recover`) re-derives which checkpoints
are still pending from durable storage. It has never taken a fresh entry price,
and must not: a price from after the decision is lookahead.

Until this change the entry mark reached storage only on the first outcome row,
written at M15. A process that stopped inside those fifteen minutes took the
mark with it, so every horizon of that signal graded `UNGRADED` with "No usable
entry mark". On Render's free tier that is the ordinary case, not an edge case:

- the service spins down after 15 minutes without inbound traffic;
- Render says it "might restart a Free web service at any time".

## What is fixed in code (free, done)

`signal_entry_marks` (`supabase/migrations/20261024100000_signal_entry_marks.sql`)
holds one row per signal. The row is written **when the mark is taken**, at
registration.

- It is write-once by trigger, like `signal_outcomes`.
- It has default-deny RLS, like every table the recorder writes.
- `recover()` reads the stored mark first. The outcome-row copy is the fallback
  for older signals.
- Recovery still never takes a mark of its own.

Verified locally:

- `test/entryMarkPersistence.test.ts` passes, including a restart before M15
  that grades POSITIVE from the original mark.
- `test-pg/graderLifecycle.pg.test.ts` passes against a real PostgreSQL and
  PostgREST, in both stores. It covers the trigger refusing UPDATE and DELETE as
  superuser, a second write returning `EXISTS`, and anon reading nothing.
- Every mutation in the pass failed its intended test.

**This migration is not applied to the live Supabase project.** Applying it is
an account change, so it waits for your approval. Until it is applied, every
entry-mark write in production fails. Those failures are counted
(`entryMarkWriteFailures`), and grading still proceeds from the mark held in
memory, which is the previous behaviour.

## What code cannot fix

Exit marks have to be observed **at the checkpoint**. A checkpoint is graded
only if the grader runs within `maxLatenessMs` (30 minutes) after it falls due.
If the process is asleep for that whole window, the checkpoint grades
`UNGRADED` and gives the reason. That is the honest answer.

The alternative would be to fetch a historical price later. That needs a
historical intraday source with rights to persist it, and none is registered
(`markSources` is Twelve Data alone).

The larger point: a sleeping process also **records nothing**. Free-tier sleep
stops ingestion as well as grading. Outbound vendor WebSockets keep nothing
awake, because the trigger is *inbound* traffic. So a sleeping deployment
collects only while someone has it open. The gap ledger (`collection_gaps`)
records those windows as `NOT_OBSERVED` rather than hiding them.

## Options

| Option | Cost | What it buys | Trade-offs |
|---|---|---|---|
| **A. Code-only persistence (done)** | $0 | A restart or sleep no longer destroys an entry mark. Any checkpoint the process is awake for grades correctly. | Checkpoints that fall due while asleep still grade UNGRADED. No collection while asleep. |
| **B. Render paid instance (Starter)** | about $7/month per a forum post — **verify on Render's pricing page** | No idle spin-down, so continuous collection and grading. | Recurring cost. Paid instances still restart on every deploy, which is why A is still needed. Needs your authorization. |
| **C. External keep-awake pinger** | $0 | Keeps a free service awake. | Render staff have described artificial keep-awake pinging as abuse, and Render may suspend a free service that sends high traffic. It also spends the free tier's 750 instance-hours per workspace per month: a 31-day month is 744 hours, so one always-on service uses nearly all of it. **Not recommended.** |
| **D. Accept sleep** | $0 | Nothing more than A. | The track record covers only the hours the app is in use. That is a biased sample, and it is disclosed in `collection_gaps`. |

## Recommendation

Apply the migration (A) now. That is the free part and it is already built.

Do not choose B until a real data source is entitled. Today no source can be
recorded (Tradier is unfunded and held until validated; Polygon is disabled). An
always-on instance would therefore keep a process awake that records only
synthetic signals, and those are excluded from the track record by design.

Once Tradier passes its live validation gate, B is the only option here that
yields a continuous record. Use A and D until then.
