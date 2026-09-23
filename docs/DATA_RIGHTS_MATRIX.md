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
| PERSIST_RAW | — | **not distinguished** from PERSIST_DERIVED |
| PERSIST_NORMALIZED | — | **not distinguished** |
| PERSIST_DERIVED | `PERSIST` | covered, but collapses three questions into one |
| HISTORICAL_RESEARCH | — | **unanswered** |
| MODEL_TRAINING | — | **unanswered**, and there is no model |
| EXPORT | — | **unanswered.** F-16 made the CSV *carry* `rights_display`; nothing *gates* on it |
| NON_DISPLAY | — | **unanswered, and it is the expensive one.** See `PROVIDER_DECISION_RECORD.md` §1: OPRA licenses this separately and the flow engine is squarely inside its definition |
| REDISTRIBUTION | partly — Finnhub's PERSIST refusal turns on its redistribution clause | **partly**, dataset by dataset, not as an axis |
| COMMERCIAL_INTERNAL | `BUSINESS_MODE` | **partly** — the mode exists; per-dataset commercial terms are not read |
| COMMERCIAL_EXTERNAL | `BUSINESS_MODE` | **partly**, same |
| RETENTION | — | **unanswered by construction.** Roadmap 0.4 established that Twelve Data's retention clause defers to a document that states no timeframe. A cap that points at silence is neither permission nor prohibition |

**Six of fifteen are genuinely unanswered. Three more are collapsed into one.**
That is the finding this file exists to record.

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
