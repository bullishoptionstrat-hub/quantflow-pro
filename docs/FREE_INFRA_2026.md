# Free-Tier Infrastructure Ground Truth — 2026 (research only, no migration)

Verified: 2026-08-15. Every claim traces to an entry in `docs/SOURCE_LEDGER.md`.
Verification constraint disclosed up front: this session's network egress proxy blocked
direct fetches of vercel.com, render.com, supabase.com, and developers.cloudflare.com,
so those rows are verified via current (2026) secondary summaries of the official docs,
cross-checked across ≥2 independent sources each. Rows where only secondary sourcing was
possible are marked (S) in the ledger. The later infra session should re-confirm the (S)
rows against the primary pages before acting.

## The two questions asked directly

**Is Vercel Hobby usable if QuantFlow is ever commercial? → NO.** Vercel's fair-use
terms restrict Hobby to personal, non-commercial use, defining commercial broadly —
payment processing, advertising a product/service, being paid to build/host, donations.
A subscription flow-terminal (the product's evident direction: `tier in ('free','pro',
'elite')` is already in `schema.sql:15`) is unambiguously commercial ⇒ Pro ($20/seat/mo)
required. Verdict: fine while strictly personal; a hard $0-breaker at first revenue.

**Can a persistent market-data WebSocket run on serverless? → NO (as an outbound,
always-on consumer).** The ingester must hold long-lived outbound WS connections to
Tradier/Finnhub 6.5 h+/day. Vercel functions are request-scoped with hard duration caps;
Cloudflare Workers are event-driven — free plan has 10 ms CPU/invocation, and even
Durable Objects (WS-hibernation) are built for *inbound* server sockets with
per-request billing wake-ups, not a permanently-open outbound market feed on 100k
req/day free budgets. A persistent feed consumer needs a process that is always up: a
VM (Oracle) or an always-on container. Render free explicitly is not that (15-min
spin-down). Serverless *can* serve the fan-out side (browser-facing WS via Durable
Objects) — but not the ingest side.

## Platform table

| Platform | Permanent Free? | Commercial Use OK? | Critical Limit | Persistence | Suitable Role | Verdict |
|---|---|---|---|---|---|---|
| Vercel (Hobby) | Yes (plan is permanent) | **No** — fair-use terms exclude commercial | 100 GB bandwidth/mo; functions request-scoped; **commercial ⇒ Pro** | None (static/edge only) | Frontend hosting while non-commercial | **CONDITIONAL** — "$0 only until it isn't": first dollar of revenue ends it |
| Render (free web service) | Yes, but terms have tightened (spin-down 30→15 min in 2026) | Yes | Spin-down after 15 min idle, 30–60 s cold start; 512 MB RAM/0.1 CPU; 750 instance-hrs/mo; **ephemeral disk** | None — disk wiped every deploy/restart; free Postgres expires after 30 days | Demo/staging backend only. Spin-down kills both the "persistent WS" ingester and the in-memory stores (audit #12) | **CONDITIONAL** — current prod home, but architecturally wrong for an always-on ingester; "free until it isn't" trend noted |
| Oracle Cloud (Always Free) | Yes, but **halved without announcement June 2026** (A1: 4 OCPU/24 GB → 2 OCPU/12 GB); idle instances can be reclaimed | Yes | 2 OCPU/12 GB ARM ceiling; capacity scarcity on signup; idle-reclamation requires keeping load above thresholds | Yes — real block volumes (~200 GB total budget) | **The always-on ingester + replay store** — the only $0 option that runs a 24/7 process with a persistent disk | **USE** (with eyes open: the June 2026 silent cut is the canonical "$0 until it isn't" warning; keep the deploy portable) |
| Cloudflare Workers | Yes — free plan is a permanent product | Yes | 100k req/day, 10 ms CPU/invocation; no long-lived outbound WS | Stateless (see D1/R2/DO) | API edge/proxy, cron fetchers of REST sources (CBOE/FRED/Stooq) | **USE** for edge roles; **DO NOT USE** for the WS ingester |
| Cloudflare Durable Objects | Yes — free since Apr 2025 (SQLite backend only) | Yes | 100k req/day; 5 GB SQLite storage; KV-backend requires paid | Yes (SQLite-backed) | Browser-facing WS fan-out (hibernation API), per-symbol state | **CONDITIONAL** — right tool for serving WS to users, not for consuming feeds |
| Cloudflare Queues | Free-plan access exists but effectively tiny (~10k ops/day reported) | Yes | Ops/day budget far below market-data event rates | Message retention only | Low-volume job queue (alerts digest) | **CONDITIONAL** — not for the event firehose |
| Cloudflare D1 | Yes | Yes | 5 GB storage, 5 M rows read/day, 100k rows written/day | Yes | Aggregates/config at the edge | **CONDITIONAL** — write budget too small for raw events; fine for daily aggregates |
| Cloudflare R2 | Yes | Yes | 10 GB-month storage, 1 M class-A + 10 M class-B ops/mo; **zero egress fees** | Yes — object storage | **Off-box archive for replay `.zst` segments** (REPLAY_STORAGE.md option b) | **USE** |
| Supabase (Free) | Yes | Yes | **500 MB DB**, 5 GB egress, 2 projects, **pauses after 7 days inactivity** | Yes while active; paused project = downtime until manual restore | Auth + user tables + small aggregates only. Never raw events (audit #13) | **CONDITIONAL** — keep, but treat 500 MB/pause as hard walls; a paused prod DB is an outage |
| Upstash Redis (Free) | Yes — limits *improved* (10k/day → 500k cmds/mo, 256 MB, 2025; stable since) | Yes | 500k commands/mo ≈ 11/min sustained — one naive per-event call exhausts it in days | Yes (durable Redis) | Rate limiting + small hot cache, batched | **USE** — but only with batched/coalesced access patterns |
| GitHub Actions | Yes | Yes | Public repos: free unmetered standard runners; private: 2 000 min/mo | Artifacts 500 MB (private) | CI for `npm run verify`; scheduled jobs (compaction, R2 sync) — max-6h jobs, not always-on | **USE** for CI; **DO NOT USE** as a runtime |

## "$0 only until it isn't" — explicit flags

1. **Vercel Hobby** — terminates at first commercial dollar (terms, not usage).
2. **Oracle A1** — silently halved June 2026 with no notice; also reclaim-on-idle. Keep
   the ingester containerized/portable so a further cut is a redeploy, not a rewrite.
3. **Render free** — spin-down tightened 30→15 min in 2026; free Postgres auto-expires
   in 30 days. Direction of travel is clear.
4. **Supabase pause-after-7-days** — a "free" prod database that stops being a database
   over a quiet week.
5. **Upstash** is the counter-example (limits raised) — but 500k cmds/mo still dies to
   one careless per-event `INCR`.

## Bottom line (no migration recommended this session)

Ground truth established: the current Vercel(Hobby)+Render(free)+Supabase(free) stack is
legitimate for a **non-commercial demo** and architecturally incapable of the product's
stated ambitions (always-on ingestion, persistence, commercial use). The natural $0
target shape — decided in a later session, not now — is: Oracle A1 for the always-on
ingester + replay store, R2 for archive, Cloudflare Workers/DO for edge + user-facing
WS, Supabase for auth/aggregates, GitHub Actions for CI. Every row above must be
re-verified against primary sources at implementation time; free tiers moved twice in
2026 alone.
