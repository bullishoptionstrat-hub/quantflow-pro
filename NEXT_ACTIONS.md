# NEXT_ACTIONS.md

Read `PROJECT_STATE.md` and `REPO_AUDIT.md` first. All 10 waves are executed; what follows is
what a next session should pick up, in priority order.

1. **Human actions that no code can do.**
   - Rotate the credentials in `docs/FORENSIC_AUDIT.md` #7 (Tradier, Firecrawl, NEXTAUTH_SECRET,
     ML webhook secret) and review the Supabase project. They are in git history.
   - Grant the Claude GitHub App write access so these branches can be pushed.

2. **Unblock the data layer — this gates W5, W7 and W8.** Obtain at least one working key
   (Tradier is the highest value: realtime WS + chains). Then:
   - Wire `backend/src/gex/compute.ts` to real chain snapshots, replacing `generateSyntheticGEX`.
   - Wire `backend/src/flow/adapter.ts` into live ingestion, retiring the `size > 200`
     `classifySweep` path.
   - Start collecting `flow_outcomes` so `train_real.py` can eventually pass its 1000-row gate.

3. **Re-verify the 16 UNVERIFIED rate limits** in `DATA_SOURCE_REGISTRY.md` against official docs
   from a machine with network access, then update `backend/src/providers/registry.ts`.

4. **Remove the deprecated `synthetic` alias.** It was kept for one wave; `provenance.is_synthetic`
   is now the contract. Touches `dataMode.ts`, `ingestion/index.ts`, `lib/types.ts`, `lib/utils.ts`.

5. **Finish the UI honesty pass.** Badges are wired into `FlowFeed`, the flow page and the
   dark-pool page. Still unbadged: GEX, heat-map, macro, news, watchlist, power-alerts. The GEX
   page should render `observed_inputs` / `model_assumptions` / `confidence`, which the API
   already returns.

6. **Decide the `flow_archive` read policy** (KNOWN_LIMITATIONS #16): it is currently readable by
   unauthenticated users, which contradicts the login wall. Product decision, not a bug fix.

7. **Harden the rate limiter** (audit #15): Upstash-backed, and stop trusting `x-forwarded-for`.

8. **Dependency CVEs** (audit #16): drop unused `next-auth` and `uuid`, `npm audit fix`, bump Next
   to 14.2.35 within the same minor.
