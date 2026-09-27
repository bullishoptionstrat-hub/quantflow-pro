# DATA RIGHTS MATRIX

§20 asks for fifteen axes. **This document deliberately does not fill them in**,
and the reason is the point of the document.

## Why there are two axes and not fifteen

`provenance/rights.ts` classifies every dataset on **two** axes — `DISPLAY` and
`PERSIST` — and each classification carries the publisher's restriction quoted
**verbatim**, the terms URL, and the date the terms were read. That last part is
what makes the two axes worth more than fifteen guessed ones.

Filling §20's fifteen columns for thirteen datasets is 195 cells. Producing
them would require reading thirteen sets of terms against fifteen distinct
questions. **That reading has not happened**, and the hosts needed for it are
denied by this environment's network policy (see
`PROVIDER_DECISION_RECORD.md` §0). Writing `UNVERIFIED` into 195 cells would
add nothing that `rights.ts` does not already say, and writing anything else
would be inventing permission — which §22 forbids in exactly these words: *the
agent may identify ambiguity, it may not invent permission.*

So this file records **what the two axes actually establish, and what the other
thirteen questions are still unanswered.**

## What `DISPLAY` and `PERSIST` do establish

| Axis | The question it answers | Enforced where |
|---|---|---|
| `DISPLAY` | may this connector issue the request and may the result reach a reader | `mayOperateConnector()` — **before** `start()`, because the request is the act the terms govern |
| `PERSIST` | may the result be accumulated into a durable record | `classifySource(…, 'PERSIST')` in `recorder.ts` and `markSources.ts` |

Both fail closed: `UNVERIFIED` is refused for PERSIST, an unregistered source
is refused, and a malformed `BUSINESS_MODE` throws rather than degrading to
either branch.

## The thirteen §20 axes, and their honest status

| §20 axis | Covered by | Status |
|---|---|---|
| FETCH | `DISPLAY` — the gate runs before `start()` | **covered** |
| PRIVATE_DISPLAY | `DISPLAY` under `PRIVATE_RESEARCH` | **covered** |
| PUBLIC_DISPLAY | `DISPLAY` under `PUBLIC_COMMERCIAL` | **covered** |
| PERSIST_RAW | `persistRaw` in a research manifest (§21) | **distinguished, not answered** — `UNVERIFIED` for both candidate datasets |
| PERSIST_NORMALIZED | `persistNormalized` in a research manifest | **distinguished, not answered** |
| PERSIST_DERIVED | `PERSIST` | covered, but collapses three questions into one |
| HISTORICAL_RESEARCH | `researchUse` in a research manifest | **distinguished, not answered** |
| MODEL_TRAINING | `modelTraining` in a research manifest | **distinguished, not answered**, and there is no model |
| EXPORT | `export` in a research manifest | **distinguished, not answered.** F-16 made the CSV *carry* `rights_display`; nothing *gates* on it |
| NON_DISPLAY | — | **unanswered, and it is the expensive one.** See `PROVIDER_DECISION_RECORD.md` §1: OPRA licenses this separately and the flow engine is squarely inside its definition |
| REDISTRIBUTION | partly — Finnhub's PERSIST refusal turns on its redistribution clause | **partly**, dataset by dataset, not as an axis |
| COMMERCIAL_INTERNAL | `BUSINESS_MODE` | **partly** — the mode exists; per-dataset commercial terms are not read |
| COMMERCIAL_EXTERNAL | `BUSINESS_MODE` | **partly**, same |
| RETENTION | `retention` in a research manifest | **unanswered by construction** for Twelve Data (Roadmap 0.4: its clause defers to a document that states no timeframe); **distinguished, not answered** for the research candidates |

**Distinguishing is not answering.** Since 2026-09-27 a research dataset's
manifest separates the axes the connector registry collapses — and every one of
them is `UNVERIFIED` for both candidates, because no terms were read. The
finding this file exists to record is unchanged: the axes are unanswered.

## What would have to happen to fill it in

1. Network access to the publishers' own terms (five hosts currently denied).
2. A reading per dataset per axis, with the clause quoted verbatim and matched
   literally — the rule the Twelve Data reading established after citing a
   document by description produced a wrong citation.
3. The operator's declared deployment mode (§21), because at least four axes
   resolve differently under `PERSONAL_RESEARCH` than under `PUBLIC_PRODUCT`.

Until then, **expanding the registry's axes would make it look more thorough
while making it less true**, which is the failure mode this repository is
organised against.

## Research dataset manifests (§21, 2026-09-27)

A historical research corpus is used in more ways than a live panel, so it
carries its own manifest (`backend/src/provenance/researchManifest.ts`,
instances in `research/manifests/`) with eight axes: `fetch`, `persistRaw`,
`persistNormalized`, `researchUse`, `modelTraining`, `export`, `redistribution`,
`retention`. It is separate from `rights.ts`, which answers DISPLAY and PERSIST
for connectors this service runs; nothing here widens that registry.

Three rules, enforced by `manifestProblems` and tested in
`historicalImport.test.ts`:

1. **Unknown is `UNVERIFIED`.** Every axis starts there.
2. **`PERMITTED` needs its own words**: a verbatim quote, the document, the read
   date, and evidence at least `PROVIDER_VERIFIED`. A search snippet is not a
   licence, and a quote without a document or date is not evidence.
3. **A successful download is not a permission** (INV-RIGHTS-001). No field
   can be set by a fetch; `importPermitted` reads only the manifest.

| candidate | fetch | persist raw | persist normalised | research | training | export | redistribution | retention |
|---|---|---|---|---|---|---|---|---|
| Databento OPRA historical | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | LEGAL_INTERPRETATION_REQUIRED | UNVERIFIED |
| ThetaData OPRA history | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | LEGAL_INTERPRETATION_REQUIRED | UNVERIFIED |

Every `quote` is `null`: no primary document was read, so there are no words to
quote. The operator audit's summaries of each vendor's terms are recorded in the
manifests' `note` fields, attributed as summaries. The §17 import gate's
`rights-metadata` check fails on both, which is correct.
