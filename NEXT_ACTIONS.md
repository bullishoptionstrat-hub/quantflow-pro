# NEXT_ACTIONS.md

Concrete next steps so a fresh session resumes without re-deriving context.
Read `PROJECT_STATE.md` and `REPO_AUDIT.md` first.

1. **Wave 1 — Data Truth Firewall.** Extend `backend/src/config/dataMode.ts` from `synthetic`
   to the master prompt's `is_synthetic` + `is_demo` (keep `synthetic` as a deprecated alias for
   one wave). Propagate through `/api/*` responses and Socket.IO payloads.
2. **Wave 1 — UI provenance.** Add `vitest` + Testing Library to `frontend/`, build
   `components/ui/ProvenanceBadge.tsx` (DEMO / DELAYED / INFERRED / LIVE), and gate the
   frontend's own generators (`lib/utils.ts:generateSeedFlow`, `hooks/useFlowFeed.ts:97-102`).
3. **Wave 1 — Health staleness.** Extend `backend/src/routes/health.ts` to report per-source
   `lastEventAt` and computed staleness, sourced from a new tracker in `ingestion/index.ts`.
4. **Wave 2 — Provider interface.** Formalize the existing `start*`/`on*`/`get*` connector shape
   into `MarketDataProvider` + priority quota manager. Record every rate limit in
   `DATA_SOURCE_REGISTRY.md` as VERIFIED or UNVERIFIED — never invent a number.
5. **Human action, unblocked by no code:** rotate the credentials in `docs/FORENSIC_AUDIT.md` #7,
   and grant the Claude GitHub App write access so these branches can actually be pushed.
