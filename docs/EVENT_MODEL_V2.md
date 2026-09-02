# Event Model V2 — MarketEventEnvelope (SPEC — not implemented)

Status: proposed, Session-1 deliverable. Do not implement before the audit gates pass.
Backward compatibility is a hard requirement: the current frontend must keep working
unmodified through every migration phase.

## Problem being solved

The current `FlowEvent` (backend `src/ingestion/index.ts:65-91`) has one `timestamp`
that is *insertion time* for most sources (audit finding #10), a bare `source` string
that simulation has already proven can lie (finding — finnhub-labeled synthetic events),
categorical `type: 'SWEEP'|'BLOCK'|'SPLIT'` presented as truth when it is a guess from
fabricated inputs (finding #9), and heat/unusual scores computed from imputed inputs with
no record of what was imputed (finding #11). Nothing supports replay, audit, or honest
research.

## The envelope

```ts
interface MarketEventEnvelope<TPayload = FlowPayload> {
  // ── Identity ────────────────────────────────────────────────
  id: string;                    // ULID — sortable, collision-safe (current `${Date.now()}-${rand}` can collide)
  schema_version: 2;             // literal; consumers switch on it

  // ── Time (the core fix) ────────────────────────────────────
  event_at: string | null;       // ISO-8601 UTC. When the trade actually printed, from the
                                 // provider (e.g. Polygon sip_timestamp). null = provider gave
                                 // none — null is honest, never substitute received_at.
  received_at: string;           // when our process first saw it
  persisted_at?: string;         // set by the archiver at write time

  // ── Provenance ─────────────────────────────────────────────
  source: string;                // 'tradier' | 'polygon' | 'yahoo' | 'simulation' | ...
  source_environment: 'production' | 'sandbox' | 'simulation';
                                 // A real provider name no longer implies real data:
                                 // tradier-sandbox and the finnhub-synthesized path both
                                 // exist today. Environment is orthogonal to source.
  provider_event_id: string | null; // provider's own id/sequence (Polygon sequence_number).
                                 // Enables dedupe on reconnect-replay and cross-checking.
  synthetic?: true;              // carried over from Session 1; MUST agree with
                                 // source_environment === 'simulation'

  // ── Market context at receipt ──────────────────────────────
  quote_bid: number | null;      // NBBO at (or nearest to) event time — null when not observed.
  quote_ask: number | null;      //   Today bid/ask are fabricated as price±1% when missing;
                                 //   V2 forbids that: unobserved ⇒ null + quality flag.
  quote_age_ms: number | null;   // age of that quote vs received_at. Aggressor-side inference
                                 // (the basis of sentiment + heat) is meaningless against a
                                 // stale quote; consumers can threshold on this.

  // ── Classification as claim, not fact ──────────────────────
  classification: {
    order_type: 'SWEEP' | 'BLOCK' | 'SPLIT' | 'UNKNOWN';
    classification_confidence: number;  // 0–1. The sweep detector groups prints in a 2 s
                                        // window across exchanges; with one exchange visible
                                        // confidence is inherently low. Encoding this ends
                                        // the size>200 ⇒ "SWEEP" fiction (audit #9).
    algorithm_version: string;          // e.g. 'sweep-detector@1.2.0'. Scores are code
                                        // artifacts; without the version, historical scores
                                        // are uninterpretable after any algorithm change and
                                        // A/B comparison of detectors is impossible.
  };

  // ── Data quality ───────────────────────────────────────────
  quality_flags: QualityFlag[];  // closed union, e.g.:
    // 'QUOTE_MISSING'          — no NBBO observed; side/heat terms degraded
    // 'QUOTE_STALE'            — quote_age_ms above threshold
    // 'OI_IMPUTED'             — open interest was estimated, not observed (today: size*50)
    // 'VOLUME_IMPUTED'         — avg volume estimated (today: size*10)
    // 'EVENT_TIME_MISSING'     — event_at is null
    // 'PARTIAL_FIELDS'         — provider omitted fields present in the schema
    // Rationale: today imputation is silent and the heat score's size/OI term is a
    // constant as a result (audit #11). Flags let downstream code (and users) discount
    // scores built on imputed inputs, without dropping the events.

  provenance: {
    ingest_host: string;         // which process/deploy produced it
    ingest_version: string;      // git SHA of the ingester
    transform_chain: string[];   // e.g. ['tradier-ws','occ-symbol-parse','sweep-group']
  };                             // Reproducibility: a stored event can be traced to the
                                 // exact code path that shaped it.

  payload: TPayload;             // the domain fields (symbol, strike, expiration, callPut,
                                 // size, premium, scores...) — unchanged from V1 shapes.
}
```

Field-by-field justification is inline above; the one-line summary: **time honesty**
(`event_at`/`received_at`/`persisted_at` split — replay, latency measurement, honest
delayed-data labeling), **provenance honesty** (`source_environment`, `provider_event_id`,
`provenance` — synthetic data can never again wear a real source name; every event is
traceable and dedupable), **inference honesty** (`quote_*`, `classification_confidence`,
`quality_flags`, `algorithm_version` — every derived claim carries the evidence and the
code version that produced it). All of this is what makes archived events usable for the
ML training and backtesting the product advertises (audit #4, #12).

## Migration plan (frontend keeps working at every step)

Phase 0 — additive types only. Add `MarketEventEnvelope` in a new module; no runtime change.

Phase 1 — dual-emit inside the backend. Ingestion constructs the V2 envelope internally;
the existing REST/socket surfaces keep serving the V1 `FlowEvent` shape via a pure
`toV1(envelope)` projection (`timestamp` := `event_at ?? received_at` — matches today's
observable behavior; `type` := `classification.order_type`, `UNKNOWN` mapped to `'SPLIT'`
as today's default arm does). Golden test: for every connector fixture,
`toV1(buildV2(x))` byte-equals today's output. The projection is where V1 compatibility
lives — one function, deletable at the end.

Phase 2 — additive exposure. New endpoints/events (`/api/v2/flow`, socket `flow_v2`)
serve envelopes; V1 endpoints unchanged. Frontend migrates page-by-page on its own
schedule; nothing breaks if it never does.

Phase 3 — persistence writes V2 only (see REPLAY_STORAGE.md). The archive never contains
V1 rows, so no data migration is ever needed — V1 was never persisted (audit #12), which
is the one silver lining: there is no legacy data to convert.

Phase 4 — deprecate V1 surfaces after the frontend has migrated, with a telemetry-verified
zero-traffic window. Delete `toV1`.

Rollback at any phase = stop calling the new code; V1 path is never edited in place.

## Non-goals (explicitly out of scope for V2)

- No change to GEX math, heat-score weights, or the sweep algorithm itself (only the
  honesty metadata around them).
- No multi-leg/complex-order modeling (flow-engine's `MultiLegEvent` work can layer on
  later as a payload variant).
- No Supabase schema migration in this spec: `flow_archive` already has `event_at` +
  `created_at`; if Supabase is used for aggregates the additive columns
  (`received_at`, `source_environment`, `algorithm_version`, `quality_flags jsonb`) are
  new nullable columns — additive, so old rows and old readers are unaffected. Raw
  envelopes go to the replay store, not Postgres (REPLAY_STORAGE.md).
