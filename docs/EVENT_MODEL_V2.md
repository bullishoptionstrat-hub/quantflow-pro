# Event Model V2

The envelope every real options event enters through, and what is derived from
it. Code: `backend/src/events/`. Evidence: `backend/test/eventModelFixtures.test.ts`
(the twenty §10 fixtures), `eventModelProperties.test.ts`,
`historicalImport.test.ts`. Code table: [`OPRA_EVENT_SEMANTICS.md`](OPRA_EVENT_SEMANTICS.md).

## Why `RawPrint` was not enough

`RawPrint` can describe a trade. It cannot describe what happened to it after:
a later cancel, a late or out-of-sequence report, the trading session, or the
earliest moment anyone could have known it. Its own docstring stated the
assumption that made those unrepresentable — *"Prints must arrive roughly
ascending"* — which nothing enforced and no feed guarantees. A research corpus
ingested through it could never answer "what did the live system believe at
10:31:07, before the cancel arrived?", and once collected, correcting it would
destroy the answer.

## Three rules

1. **A cancel is its own event, never an edit.** Nothing mutates or deletes the
   trade it cancels. Stored events are frozen at runtime (`EventLog.append`
   deep-freezes its own copy), so this is enforced, not conventional.
2. **Time is three clocks plus a rule.** `eventTime` (the venue), the provider's
   receipt, QuantFlow's receipt — and `availableAt`, the earliest instant the
   event was knowable, with the basis that produced it.
3. **Raw evidence is kept beside its interpretation.** Every normalised field
   that came from a code keeps the code, so a better reading of the
   specification can reinterpret history without a re-import.

## Field provenance

| field | provenance | notes |
|---|---|---|
| `schemaVersion` | QuantFlow | `market-event-v2` |
| `eventId` | **derived** from the raw record (`eventId.ts`) | provider id → else provider sequence in its scope → else raw content hash. Re-import is idempotent; a changed record under a reused id is a `DUPLICATE_CONFLICT`. With content identity a changed record is simply a different event — a stated limit of the data |
| `provider`, `datasetId` | adapter | always in the identity key: one vendor's id 42 is not another's |
| `providerEventId` | provider, as delivered | |
| `providerSequence` | provider, as delivered, **as a decimal string** | canonicalised (`007` → `7`); never a float — OPRA-scale sequences exceed 2^53 |
| `sequenceScope` | adapter | must name the stream **and** its reset period (a line and its date); a scope without the period lets two events share an identity, which the log reports loudly |
| `eventTime` | provider | epoch ms. Sub-millisecond vendor precision is truncated by the adapter; nothing here depends on it, and a provider that needs it is a V3 change |
| `providerReceiveTime` | provider | e.g. a vendor capture timestamp |
| `quantflowReceiveTime` | QuantFlow | **excluded from identity**: two captures of one record are one event |
| `availableAt` | **derived**: `max(eventTime, providerReceiveTime?, quantflowReceiveTime?)` | the conservative answer admits no lookahead |
| `availableAtBasis` | derived | `QUANTFLOW_RECEIPT` > `PROVIDER_RECEIPT` > `EVENT_TIME_LOWER_BOUND`. `PROVIDER_RECEIPT` credits zero distribution latency — H-001-v2 adds a frozen latency allowance for exactly this reason. `EVENT_TIME_LOWER_BOUND` is excluded from published rates, as `EVENT_TIME_ONLY` is today |
| `clockInversion` | derived | a receipt clock earlier than a clock that must precede it — skew kept visible, never averaged away |
| `instrument` | adapter (from the provider's symbology) | `underlying`, ISO `expiry`, `strike > 0`, `right`. Validated at the builder with the same expiry reader as the F-17 gate |
| `venue` | provider | |
| `sessionEvidence` | raw fields **and** derived reading | see *Session evidence* |
| `rawRecordRef` | adapter | a pointer back to the raw record; **excluded from identity**. The §17 gate requires it on every event |
| `synthetic`, `replay` | adapter | a fixture says `synthetic: true`, always |
| trade `price`, `size` | provider | a zero price is data (a cabinet trade); negative or non-finite is refused |
| `rawMessageType`, `rawConditions` | provider, as delivered | an adapter maps its blank "regular" code to `null` and does nothing else to codes |
| `reportLifecycle`, `iso`, `complex`, `uninterpretedCodes` | **derived** by `readCodes` | `iso`/`complex` are `null` when an uninterpreted code might have been the one that set them |
| cancel `cancelScope` | derived from the code | `UNKNOWN` when two cancel codes, or a cancel code plus an uninterpreted one |
| cancel `referencedProviderEventId` | provider | the **provider's** id for the target, resolved within the same provider and dataset — not one of our ids |
| cancel `price`, `size` | provider | used to **match**, never to guess |
| quote `bid`/`ask`/sizes | provider | `null` when absent: a missing bid is not a zero bid |
| `semanticsStatus` | derived | the weakest standing of the code-table rows used |

### Against the directive's candidate structure

The directive offered a candidate and said not to copy it blindly. Differences,
each deliberate:

| candidate | V2 | why |
|---|---|---|
| one `eventType` with `trade?` optional block | a discriminated union: `TRADE_REPORT` / `TRADE_CANCEL` / `QUOTE` | a cancel carries different fields from a report, and a union makes a cancel-without-scope a type error rather than a runtime surprise |
| `CORRECTION` event type | **none** — a correction is a cancel plus a new report | OPRA's Category 'a' message types (as surfaced) carry cancels and late reports, not an in-place correction message; inventing a type would be modelling a record nobody sends |
| `STATUS`, `REFERENCE` | not yet | nothing consumes them; `HistoricalOptionsSource.instrumentDefinitions` carries reference data separately. Adding empty types would be architecture without substance |
| `lifecycle` mixing reports and cancels (`NEW`, `LATE`, `CANCEL_LAST`, …) | `reportLifecycle` on reports, `cancelScope` on cancels | the directive's `CANCEL_*` values are scopes of a cancel, not states of a report |
| `referencedEventId` | `referencedProviderEventId` | raw evidence as delivered; the log resolves it |
| `sessionEvidence.basis: CLOCK_INFERENCE` | not a basis of evidence | clock inference is a separate function returning its own type (`inferSessionFromClock`), so it can never be mistaken for evidence (INV-SESSION-003) |
| `rawSaleCondition` (one) | `rawSaleConditions` (all codes, as delivered) | the legacy marker can arrive as the message type or as a condition |

## Two views, one derivation

`AS_KNOWN_AT(t)` holds every event with `availableAt ≤ t` and applies only the
cancels that had arrived by `t`. `FINAL_CORRECTED` is `AS_KNOWN_AT(∞)`. Neither
is stored, so neither can overwrite the other (INV-EVENT-002). Every fixture is
held to `FINAL == AS_KNOWN_AT(last arrival)`.

## Resolving a cancel never guesses

Reporting order is the provider's sequence within a shared scope, else arrival;
**never** event time (a late report has an early event time and a late position
in the stream). Equal arrival with no shared sequence is *order unknown*, not a
tie to break by id (INV-EVENT-005). Positions count every *reported* trade,
cancelled or not, because the definitions speak of what was reported. Every
scope has an honest failure — see the table in `OPRA_EVENT_SEMANTICS.md` —
and an unresolved cancel marks every trade it could have meant
`CANCEL_UNRESOLVED`, because the dangerous failure is a cancelled trade staying
`ACTIVE` in a corrected tape.

## Reordering and the watermark

`ReorderBuffer` takes events in arrival order and releases them in canonical
order (event time, scope, sequence, id) once the watermark — newest event time
minus `allowedLatenessMs` — passes them. The bound is exact and property-tested:
a delay strictly below the allowed lateness is never late. An event behind a
watermark already released is a `LATE_EVENT`: emitted at once, never inserted
into a sequence already handed downstream. Each ordered emission states how its
position was established (`EVENT_TIME`, `SEQUENCE`, or `TIE_BROKEN_BY_ID` when
nothing ordered it). Sequence gaps are tracked beside the ordering with the
arrival window their missing messages belong to, reconstructable as of any
instant (`gapsOpenAt`).

**The live path has no reorder buffer yet**, and `RawPrint`'s docstring says so: its
only sources are the simulation and chain snapshots, which emit in order. The
first live OPRA source is exactly what would need one, and §29 keeps that
source out for now.

## Causal quotes

`causalQuoteFor`: the quote must be stamped **strictly before** the trade and
**known by** the trade's `availableAt`, from the same provider (one clock
domain). The latest such quote is the book — one-sided, locked or crossed if
that is what it was; skipping back to a prettier quote would be choosing
evidence. Staleness is the engine's own `nbboMaxAgeMs`, imported. When a quote
stamped between the chosen one and the trade arrived after the trade,
`finalAnswerDiffers` says the live book and the final book disagree.

## Signal revisions

`reviseSignal` derives a revision from a view; `RevisionLedger` keeps every
revision, in knowledge-time order, and refuses a reading from an earlier view
after a later one. A signal that formed in real time is always kept for
as-known research. For final-tape research: missing evidence, an unfilled
sequence gap on the evidence's stream inside the signal's formation, or
evidence disputed by an unresolved cancel → `EVIDENCE_UNRESOLVED`; every
evidence trade cancelled → `INVALIDATED_BY_CORRECTION`; some cancelled, or a
late trade inside the cluster's reach → `REVISED`; inside the finality window →
`PROVISIONAL`; otherwise `FINAL`. Late events and gaps count only once they
were knowable at the view's horizon, and a signal's own evidence is never
"late evidence" against it.

## Research/production parity

V2 events reach the flow engine through `ingestPrint` — the seam every live
connector uses — never a private path. `detectorAdmission` decides what a
real-time detector could have seen as an ordinary trade (regular reports, ISO
included; not late, complex, uninterpreted, cancels, quotes or late
emissions); `toRawPrint` hands over the trade, its causal quote (only when
fresh and two-sided), and `availableAt` as the receipt clock, which
`RawPrint.receivedAt` now carries instead of discarding. Everything the engine
does not consume stays on the V2 event the signal's `print_ids` point back to.

**Honest limit:** parity is between the historical and fixture paths. The live
path still enters as `RawPrint` directly, not as V2. It has no OPRA source to
convert (§29), and converting the simulation would change live behaviour for
no evidential gain; the first live OPRA adapter should produce V2 and enter
through the same buffer and seam.

## What V2 does not yet do

- Persist events. The log is in memory; a durable, append-only table with the
  same identity and conflict rules is the next storage change, and it has not
  been designed against a real sample.
- Replay the engine over a whole import. The parity test drives it; a batch
  replay tool that resets the adapter's process-wide engine must not run in a
  process that is also ingesting live, so it belongs in `tools/`, not `src/`.
- Read any code from the primary specification. See the status section of
  `OPRA_EVENT_SEMANTICS.md`.
