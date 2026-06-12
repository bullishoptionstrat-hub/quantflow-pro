# QuantFlow — Firecrawl Integration

Web enrichment module + research workflows for QuantFlow Terminal.
Direct Firecrawl v2 REST integration (no SDK), strict TypeScript, zod-validated
responses, typed errors, retry/backoff, pluggable caching.

## Status (verified 2026-06-12)

| Check | Result |
|---|---|
| API key auth | PASS (`firecrawl --status`) |
| Live scrape (FINRA TRF page) | PASS — clean markdown returned |
| `tsc --noEmit` strict typecheck | PASS |
| `INSUFFICIENT_CREDITS` fail-fast path | PASS (verified live on 402) |
| Full research run | **BLOCKED — account at 0/1000 credits this cycle** |

## Blocker

The current key (`fc-5960...`) has **0 credits remaining**. Before any real run:
top up at https://www.firecrawl.dev (dashboard → billing), or generate a key on
an account with credits and update `.env`. The key was also pasted into chat —
**rotate it** in the dashboard regardless.

## Setup

```bash
npm install
echo "FIRECRAWL_API_KEY=fc-YOUR_KEY" > .env   # never commit
npx tsc --noEmit                               # expect: clean
```

## Module: `src/services/firecrawl/`

```
types.ts               zod schemas, domain types, FirecrawlError
client.ts              REST client — retry, timeout, typed 401/402/429 handling
enrichment.service.ts  FINRA doc fetch w/ sha256 change detection + news context
index.ts               barrel export
```

### Use in the QuantFlow ingest service

Copy `src/services/firecrawl/` into the ingest service and:

```ts
import { FirecrawlClient, EnrichmentService, FirecrawlError } from "./services/firecrawl/index.js";

const enrichment = new EnrichmentService(FirecrawlClient.fromEnv());

// FINRA notice sync — skip reprocessing when content hash is unchanged
const { doc, changed } = await enrichment.fetchFinraNotice(url, lastKnownHash);
if (changed) await persistNotice(doc); // doc.contentHash, doc.markdown, doc.fetchedAt

// News context panel — CONTEXT ONLY, never a trade trigger
const items = await enrichment.fetchNewsContext("S&P 500 futures news", 5);
```

Error branching:

```ts
try { ... } catch (e) {
  if (e instanceof FirecrawlError) {
    switch (e.code) {
      case "INSUFFICIENT_CREDITS": // alert ops, pause enrichment jobs
      case "AUTH":                 // key revoked — kill switch
      case "RATE_LIMIT":           // back off scheduler
      default:                     // log + continue, enrichment is non-critical path
    }
  }
}
```

For production, replace `InMemoryCache` with a Redis adapter implementing
`CacheStore` (two methods) — no call-site changes.

## Research workflows: `scripts/research/`

| Script | Output | Credit cost |
|---|---|---|
| `competitor-intel.ts` | `reports/competitor-intel-YYYY-MM-DD.md` — FlowAlgo / CheddarFlow / Unusual Whales / BlackBox pricing+features | ~4 |
| `macro-digest.ts` | `reports/macro-digest-YYYY-MM-DD.md` — Fed/CPI/ES/NQ/GC/SI headlines | ~6 |

```bash
npm run intel    # competitor scan
npm run macro    # macro digest
```

The macro digest header hard-codes the governing rule: **context layer only —
bias is earned exclusively through price confirmation. Default: Neutral — waiting.**

## Hard rules encoded

- News/macro output is never a trade trigger — enforced in docs and output headers.
- All API responses zod-validated; schema mismatch throws `BAD_RESPONSE`, never silently passes garbage downstream.
- 401/402 fail fast (no retry burn); 429/5xx retry with exponential backoff (2 retries default).
- Content-hash change detection prevents redundant FINRA reprocessing and credit waste.
- `.env`, `.firecrawl/`, `reports/` gitignored.
