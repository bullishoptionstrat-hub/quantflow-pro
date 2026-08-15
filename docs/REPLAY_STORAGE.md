# Raw-Event Replay Storage — Decision (SPEC — not implemented)

Status: proposed, Session-1 deliverable. One store recommended; do not implement yet.

## Requirement

Persist every raw MarketEventEnvelope (EVENT_MODEL_V2.md) so that (a) any session can be
replayed deterministically, (b) ML training/backtests run on real archived events, and
(c) cost stays $0. Explicitly ruled out: unbounded rows in Supabase Postgres — the free
tier is 500 MB and pauses after 7 days idle (docs/FREE_INFRA_2026.md); real ingestion
would blow the cap in weeks (audit #13).

## Recommendation: compressed rotating NDJSON + zstd on the backend host's disk, with size-budgeted retention

**One store, one format: hourly-rotated NDJSON files, zstd-compressed on rotation.**

```
data/replay/
  2026-08-15/
    flow-2026-08-15T14.ndjson         (active hour, append-only)
    flow-2026-08-15T13.ndjson.zst     (rotated + compressed)
  manifest.json                        (per-file: line count, byte sizes, sha256, min/max received_at)
```

- Append path: `fs.appendFile` of one JSON line per envelope. No schema, no server, no
  new infrastructure. Crash-safe to the last flushed line; a torn final line is detected
  (parse failure) and dropped on read — NDJSON's classic property.
- Rotation: on the hour boundary, compress with zstd (level 3) and update the manifest.
  Market-data JSON is highly repetitive; zstd typically achieves 8–15× on such streams —
  conservatively assume 8×. At a genuine 50k events/day × ~600 B/envelope ≈ 30 MB/day raw
  ⇒ ≈ 4 MB/day compressed ⇒ ~1.4 GB/year.
- Retention/compaction: a size budget, not a time budget — delete oldest days beyond
  `REPLAY_BUDGET_MB` (default 512). Optional monthly compaction: re-pack a day's hourly
  files into one `.zst` (better ratio, fewer files). Aggregates worth keeping forever
  (daily per-symbol premium/counts) are tiny and go to Supabase.
- Replay: stream-decompress → parse lines → feed the same emit boundary
  (`addFlowEvent`) with `source_environment: 'simulation'`-style replay tagging. Sorted
  by `received_at` within a file by construction.

### Verified against current free limits (see docs/FREE_INFRA_2026.md + SOURCE_LEDGER.md)

The store lives on the backend host's filesystem. On Render free tier the disk is
**ephemeral** — files vanish on every deploy/restart/spin-down. That is the tradeoff to
state honestly, not hide: **on today's Render-free deployment, this store preserves
replay data across a process's lifetime only; durability requires either (a) the later
infra session moving the ingester to a host with a persistent disk (Oracle Always Free
boot volume — 2 OCPU/12 GB since June 2026, ~47 GB usable boot volume; or any VPS), or
(b) an off-box sync of rotated `.zst` files to Cloudflare R2's free 10 GB-month
(supports S3 API; ~2.5 years of archive at the rate above).** Option (b) is a ~50-line
uploader, not a platform migration, and R2 has no egress fees for retrieval. Decision on
(a) vs (b) belongs to the infra session; the file format is identical either way, which
is exactly why NDJSON+zstd is the right first store: it commits us to a layout, not a
platform.

## Why not the alternatives

**SQLite** — a real contender (queryable, single file, zero cost) and the right choice
*if* the primary access pattern were ad-hoc queries over raw events. It isn't: raw-event
access is append-and-replay-in-order; queries belong on aggregates (Supabase) or on a
later Parquet export. SQLite costs: write amplification + WAL management on the hot
append path, a binary format that can't be tail-inspected or streamed with standard
tools, whole-file uploads for off-box sync (vs closed `.zst` segments), and one more
dependency in a repo that currently has zero native modules. Compression requires
either app-level chunking or extensions.

**Parquet** — best-in-class for the *analytics* end state (columnar, ML-training-friendly)
but wrong as the write-side store: Parquet is not appendable — writers buffer row groups
in memory and finalize files, so a crash loses the open file; a Node ingester would take
on a heavy dependency (arrow/parquet-wasm) on the hot path. The right place for Parquet
is a later batch job that converts closed `.zst` NDJSON days into Parquet for training —
which the manifest makes trivial. NDJSON now does not preclude Parquet later; it enables it.

**Supabase rows** — ruled out by the requirement, and rightly: 500 MB cap ⇒ ~2 months of
real ingestion (audit #13), row overhead + index bloat for data that is never queried
row-wise, and free-tier pause-on-idle makes it unsuitable as an archive of record.

## Interface sketch (for the later implementing session)

```ts
interface ReplayStore {
  append(envelope: MarketEventEnvelope): void;          // fire-and-forget, batched flush
  stream(range: { from: string; to: string }): AsyncIterable<MarketEventEnvelope>;
  manifest(): Promise<ReplayManifest>;                  // for integrity checks + R2 sync
  enforceBudget(maxBytes: number): Promise<DeletedFile[]>;
}
```

Acceptance tests for that session: torn-final-line tolerance; rotation under continuous
writes; budget enforcement deletes oldest-first; replay ordering; round-trip
byte-equality of envelopes.
