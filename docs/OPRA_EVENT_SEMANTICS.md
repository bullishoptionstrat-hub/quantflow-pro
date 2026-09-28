# OPRA event semantics — what each code does to the tape

Directive §9. The executable form of this table is
`backend/src/events/semantics.ts` (`OPRA_LAST_SALE_CODES`, `OPRA_SESSION_ENCODING`);
this document is its reading guide. **If they disagree, the code is right and
this page is stale.**

## The status of every row, first

**No row below is `PRIMARY_VERIFIED`.** The OPRA specification and notices, the
Cboe product pages and FAQ, and the vendor documentation were all refused by
this environment's egress policy — re-probed 2026-09-27 13:21Z:
`www.opraplan.com`, `cdn.opraplan.com`, `www.cboe.com`, `databento.com`,
`www.thetadata.net`, `docs.thetadata.us`, `www.sec.gov` each `CONNECT tunnel
failed, response 403`, against `registry.npmjs.org` → `200` as the control.

So the column the directive calls "primary-source meaning" is filled with what
could actually be established, and says which:

- **SEARCH_ONLY** — wording surfaced by a search tool from the named document.
  The tool summarises, so even quoted-looking text may be a paraphrase; it is
  recorded as surfaced and never promoted to a quotation.
- **UNVERIFIED** — recalled, or supplied by the operator audit of 2026-09-27.
  Nothing was read.

Every view the event log derives reports the **weakest** status among the rows
it used (`TapeView.semanticsStatus`), and the §17 import gate fails its
`code-semantics-verified` check below `PRIMARY_VERIFIED`. A corpus read through
this table today is therefore marked as read through unverified rules, on its
face. Upgrading a row means reading the specification, not editing a status.

## The table

"Real-time detector" is the admission rule in `events/detector.ts`. "Corrected
tape" is the `FINAL_CORRECTED` view in `events/eventLog.ts`. Every trade is
kept in every view it is known to; a cancel only ever changes a trade's
*state*.

| raw code | primary-source meaning (status) | canonical lifecycle | included in real-time detector? | corrected tape behaviour | tests |
|---|---|---|---|---|---|
| *(blank)* | a regular sale with no qualifying type (UNVERIFIED, recalled) | `REPORT / REGULAR` | **yes** | `ACTIVE` unless a cancel resolves to it | fixtures 01, 02, 05–08 |
| `CANC` | "Transaction previously reported (other than as the last or opening report for the particular option contract) is now to …" — fragment surfaced from the OPRA binary spec; the fragment's association with `CANC` was **not** surfaced (SEARCH_ONLY text, UNVERIFIED mapping) | `CANCEL / PREVIOUS` | no — it revises signals | resolves only to the **single** live report restating its price and size; two matches → both `CANCEL_UNRESOLVED`; a match that is the opening or last report → `UNRESOLVED_SCOPE_CONTRADICTION`; no restatement → every live report disputed | fixture 05, 20; `eventModelProperties` "every scope refuses to guess" |
| `OSEQ` | "Transaction is being reported late and is out of sequence; i.e., later transactions have been reported for the particular …" (SEARCH_ONLY text, UNVERIFIED mapping) | `REPORT / LATE_OUT_OF_SEQUENCE` | no — outside its real-time slot | `ACTIVE`; if it is the last report, a `CNCL` becomes ambiguous between it and the last in-sequence report | fixture 04; "a late out-of-sequence report makes last reported ambiguous" |
| `CNCL` | "Transaction is the last reported for the particular option contract and is now cancelled." (SEARCH_ONLY text, UNVERIFIED mapping) | `CANCEL / LAST` | no | resolves to the unique last report in reporting order (provider sequence, else arrival); a tie with no shared sequence, a restatement mismatch, or an already-cancelled last report → unresolved, candidates disputed | fixture 06, 20; INV-EVENT-005 test |
| `LATE` | late, in correct sequence (UNVERIFIED, recalled) | `REPORT / LATE_IN_SEQUENCE` | no — even when it arrives inside the reorder bound | `ACTIVE` | fixture 03; "a late report is refused even inside the lateness bound" |
| `CNCO` | the opening report, cancelled (UNVERIFIED, recalled) | `CANCEL / OPENING` | no | resolves to the unique first report of the day; if a late report **of the opening trade** (`OPEN`/`OPNL`) also exists, "the opening report" names two trades and both are disputed | fixtures 07, 09, 20 |
| `OPEN` | late report of the opening trade, out of sequence (UNVERIFIED, recalled) | `REPORT / OPENING_LATE_OUT_OF_SEQUENCE` | no | `ACTIVE`; makes a later `CNCO` ambiguous | fixture 09 |
| `CNOL` | the only report that day, cancelled (UNVERIFIED, recalled) | `CANCEL / ONLY` | no | resolves only when exactly one report exists; several → all disputed | fixture 08; "every scope refuses to guess" |
| `OPNL` | late report of the opening trade, in sequence (UNVERIFIED, recalled) | `REPORT / OPENING_LATE_IN_SEQUENCE` | no | `ACTIVE`; also makes a later `CNCO` ambiguous | fixture 09 |
| `ISOI` | intermarket sweep order execution (UNVERIFIED, recalled) | `REPORT / REGULAR`, `iso: true` | **yes**, with `iso` carried to the engine | `ACTIVE` | "a late report is refused…" (ISO half) |
| `SPRD` `STDL` `STPD` `CSTP` `BWRT` `CMBO` | complex / multi-leg execution families (UNVERIFIED, recalled) | `REPORT / REGULAR`, `complex: true` | no — a leg is not a standalone directional print | `ACTIVE` | parity test (complex leg refused) |
| `AUTO` `REOP` `AJST` `SPIM` `BNMT` `XMPT` | recalled as message types; **meaning not asserted** | `REPORT / UNKNOWN`, listed in `uninterpretedCodes` | no | `ACTIVE`, flagged | "codes: contradictions and unknowns are UNKNOWN" |
| any code not in the table | — | `REPORT / UNKNOWN`; `iso`/`complex` `null` (an unknown code might have been either) | no | `ACTIVE`, flagged; beside a cancel code it makes the cancel's scope `UNKNOWN` | fixture 15 (`V`); "every scope refuses to guess" |
| two lifecycle codes on one report | the Category 'a' types are "all mutually exclusive" (SEARCH_ONLY) | `REPORT / UNKNOWN` | no | `ACTIVE`, flagged | "codes: …" |
| `v` | Message Type `v` (Extended Hours Trade) — surfaced from the OPRA Pillar Output Specification **and** independently from Cboe's Equity Options Extended Trading Hours FAQ ("Cboe will mark these trades with an Extended Hours "v" sale condition when reporting GTH and Curb trades to the OPRA RTH system") (SEARCH_ONLY) | **session evidence**, not a lifecycle: removed before lifecycle reading | yes as a trade (it is one); **excluded from H-001-v2's sample** by `researchEligibility` | `ACTIVE` | fixtures 15, 16 |
| Trading Session Identifier `0` / `1` | regular / extended (values: UNVERIFIED, from the operator audit). Transitional rule (SEARCH_ONLY): participants not yet migrated keep using `v`, "in those cases, the Trading Session Identifier will carry its default value of 0" | `SessionEvidence` | yes as a trade; H-001-v2 admits `REGULAR` only | `ACTIVE` | fixtures 13–16 |

## The session identifier: where the directive's example was wrong

The directive offered this as the model conflict: *"provider session says
REGULAR but sale condition says ETH → SESSION_CONFLICT."* Under OPRA's encoding
as surfaced, that pair is the **ordinary transitional encoding** of an
extended-hours trade — `0` is the identifier's *default*, and a participant that
has not migrated sends exactly `0` beside `v`. Treating it as a conflict would
have filed every legacy extended-hours print under a data conflict for as long
as the migration lasts, which is INV-SESSION-004 broken by the rule written to
satisfy it. The first implementation did exactly that and was corrected
(commit `d6ad915`).

What remains a conflict: an **explicit, non-default** regular value beside `v`.
OPRA's own encoding cannot produce one (its regular value is its default), so
`CONFLICT` is reached only through a provider encoding with an explicit regular
value — which is why `SessionEncoding` is data per provider, and why fixture 16
exercises both.

| identifier | `v` present | normalised | basis |
|---|---|---|---|
| absent | no | `UNKNOWN` | `NONE` — clock inference is a separate, labelled function |
| absent | yes | `EXTENDED` | `LEGACY_SALE_CONDITION` |
| `0` (OPRA default) | no | `REGULAR` | `PROVIDER_SESSION_IDENTIFIER` |
| `0` (OPRA default) | yes | `EXTENDED` | `LEGACY_SALE_CONDITION` |
| `1` | no | `EXTENDED` | `PROVIDER_SESSION_IDENTIFIER` |
| `1` | yes | `EXTENDED` | `BOTH_AGREE` |
| explicit non-default regular | yes | `CONFLICT` | `BOTH_DISAGREE` |
| unreadable (`7`, `""`) | either | `UNKNOWN` | `PROVIDER_SESSION_IDENTIFIER` — `v` may not overrule a field that was present |

`v` is case-sensitive: `V` is a different code, uninterpreted.

## What this table does not cover

- **The complex-order, auction and floor-trade message types added after the
  2019 binary spec** (a family of lower-case types is recalled to exist). None
  is in the table, so each arrives `UNKNOWN` and is excluded — the correct
  failure direction, and a reason to read the current Pillar specification
  before any import.
- **Cross-day cancels.** A cancel is matched only against reports on the same
  market date; one dated the next day comes out `UNRESOLVED_NO_MATCH`, visibly.
  Whether OPRA permits them is not established.
- **Consolidated versus per-participant "last report".** A cancel carrying a
  venue is matched within that venue; one without a venue is matched across the
  contract's whole tape. Which the specification means is not established.
- **Quote conditions.** Quotes are carried as book state only.
