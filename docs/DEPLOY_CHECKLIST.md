# Deploy checklist

Written 2026-11-06 against `main` = `44dc6e2`. Each item says who can do it. Items marked
**owner** need an account this repository cannot reach.

There are two different deployments here, and only the first is close:

- **A. The terminal runs publicly.** Simulated flow, Cboe delayed GEX, macro, news.
- **B. It accumulates a track record.** Needs an entitled real options feed, always-on
  hosting and a working durable store. Blocked on purchases, not code (section 6).

## 0. Before anything is public

1. **Rotate every disclosed key (owner).** Vendor keys were committed in the old root
   archives and in `backend/src/bundledKeys.ts` (#87). Removing them from the tip does not
   remove them from history, and the repository is public. Rotate at each vendor, put the
   new values in `backend/.env` and Render only, then confirm the old ones are dead:
   ```bash
   cd backend && npm run security:verify
   ```
   Runbook: `docs/SECURITY_ROTATION.md`.
2. **Restore GitHub Actions (owner).** Billing-locked since around run #80; no `verify` job
   has executed since. Once restored, re-run `verify` on `main` and treat any red as real.

## 1. Supabase (project `vitnwysywkmpuaoluqom`)

Read 2026-11-06 from `supabase_migrations.schema_migrations`: nine migrations applied,
matching the nine files in `supabase/migrations/` by name. Versions differ for most of
them because they were applied through an interface that stamps its own timestamp; the
files are re-runnable for that reason (`migrationsRerunnable.test.ts`).

- [x] `schema.sql` and every migration applied, including `signal_entry_marks` and
      `synthetic_no_default` (both 2026-10-28).
- [ ] **Run the gate proofs against the live project (owner, or with database access).**
      `gate-proofs.sql` was fixed on 2026-11-06: it relied on the `synthetic` default that
      production dropped, so it could not have proved anything there. It deletes every row in
      the four history tables first, so run it against a branch or a copy, not production.
      ```bash
      psql "$DATABASE_URL" -f supabase/gate-proofs.sql
      ```
- [ ] **Decide about the 61,929 synthetic rows (owner).** Counted 2026-10-27: 65 MB of a
      77 MB database. New synthetic writes are capped at one a minute; deleting the old ones
      changes production records and is not done by code.

## 2. Render (backend)

Blueprint: root `render.yaml`. `renderBlueprint.test.ts` holds it to the code both ways.

| Variable | Set to | Why it matters |
|---|---|---|
| `FRONTEND_URL` | The exact Vercel production origin, e.g. `https://<app>.vercel.app` | The Socket.IO CORS allow-list is this one origin plus localhost. Wrong or unset: the live feed is refused in the browser while REST works, because REST goes through the rewrite. Preview deployments are refused too. |
| `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` | The project URL and the **service_role** key | The anon key sits next to it in the dashboard and is refused offline by `serviceKey.ts`. Never measured against real Supabase from this repo (ROADMAP 1.1c). |
| `BUSINESS_MODE` | `PRIVATE_RESEARCH` (Blueprint default) | `PUBLIC_COMMERCIAL` refuses Finnhub and Event Registry for display; an unknown value stops the boot. |
| `DEMO_MODE` | `1` only if the public demo is wanted | Needs `NEXT_PUBLIC_DEMO_MODE=1` on Vercel too. |
| Vendor keys | The rotated values from step 0 | Each one is optional. A missing key shows as `disabled` with its variable name on `/api/health`. |
| `TRUST_PROXY_HOPS` | `1` (Blueprint value) | Rate limiting keys off this. |

The free plan sleeps after 15 minutes. That suits deployment A; for B it loses checkpoints
(`docs/GRADING_UPTIME_OPTIONS.md`).

## 3. Vercel (frontend)

Root directory `frontend`. The `/api/*` rewrites are in `frontend/next.config.js`, not
`vercel.json`.

| Variable | Set to | Default when unset |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Project URL and **anon** key | None. Sign-in is unavailable; the demo path still renders. |
| `BACKEND_URL` | The Render service URL | `https://quantflow-pro-backend.onrender.com` |
| `NEXT_PUBLIC_WS_URL` | The same Render URL | Same default |
| `NEXT_PUBLIC_DEMO_MODE` | `1` only with `DEMO_MODE=1` on Render | Off |

If the Render service has any other name, both URL variables must be set, or the rewrites
and the socket point at a host that does not exist.

## 4. After deploying: smoke checks

```bash
curl -s https://<render-host>/api/health | head -c 2000
```

- `history.store` is `supabase` and `history.durable` is `true`. `memory` means history is
  lost on every restart; `durable: false` under `supabase` comes with a `reason` naming
  the key fault (anon key, wrong project, expired). `durable: true` means the key is not
  provably wrong, not that a write has succeeded.
- `history.grader.entryMarkWriteFailures` stays at 0 across a few minutes of traffic.
- `session.state` reads sensibly for now (for example `CLOSED_WEEKEND` on a Saturday).
- `sources` shows what you expect. `refused` is a rights decision; `disabled` names the
  missing variable; `error` carries the vendor's own words in `sourceErrors`.

```bash
cd backend && npm run collection:doctor -- --url https://<render-host> --probe
```

Then open the Vercel URL and check: the Settings page renders every source; the ticker tape
either shows quotes or says why not; the flow page connects (a refused socket here almost
always means `FRONTEND_URL` is wrong).

## 5. Dated items

- **Market calendar coverage ends 2027-12-31.** 2027 was added on 2026-11-06 from NYSE's
  published schedule. Past that date every session check answers `UNKNOWN`, the sidebar
  reads `SESSION UNKNOWN`, and coverage gaps are never classified as closures. Add 2028
  before then, in both `quantflow-modules/flow-engine/src/calendar.ts` and its vendored
  copy (`vendorMirror.test.ts` fails if only one is edited).

## 6. Deployment B: what blocks a real track record

None of these is a code change.

- **No entitled real options-flow source.** Polygon's plan refuses options (F-24, not
  started). Tradier's stream is rewritten but has never met Tradier; its signals are held
  until `docs/TRADIER_LIVE_VALIDATION.md` passes on a live session.
- **OPRA non-display licensing.** Automated processing of the feed is non-display use, a
  separate licence from the vendor plan (`docs/PROVIDER_DECISION_RECORD.md`; figures there
  are `SEARCH_ONLY`).
- **Always-on hosting.** Options and costs in `docs/GRADING_UPTIME_OPTIONS.md`.
- **One mark source.** Twelve Data's free tier streams QQQ and AAPL only; everything else,
  SPY included, refreshes about every 19 minutes. Its retention terms are `UNVERIFIED` until
  Twelve Data answers.
