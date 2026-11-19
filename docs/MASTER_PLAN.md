# Master plan

Written 2026-11-18, after #151 merged (`0e908d1`). Research and citations are in `docs/RESEARCH_2026-11-18.md`. Current status per capability is in `docs/PROGRAM_STATUS.md`.

**The rule this plan keeps.** Nothing in QuantFlow Pro claims an edge it has not measured. Specifically:
- Every automated action stays paper-only until evidence clears a gate that was fixed in advance.
- Every rate needs n≥30 and an interval.
- An LLM may read and explain. It may never pass a gate, size a position or place an order.

## 1. Gap analysis (read from the code, 2026-11-18)

| Area | Exists | Partial | Missing | Blocked on |
|---|---|---|---|---|
| Data: options events | Event Model V2, the flow engine, the Tradier stream mapping | Tradier never run live; Polygon not started (F-24) | Any entitled OPRA source | Money and the licence decision (`PROVIDER_DECISION_RECORD.md`) |
| Data: bars | CSV import, preflight, `Bar` type | — | Live intraday bars, ES/NQ, a bar store | Phase A host refused and no key; futures data is paid |
| Data: chain / GEX | Cboe delayed chain, GEX/DEX, 0DTE lens | Rights UNVERIFIED for display | IV surface, skew history | Rights; a history needs persistence |
| Structure | swings, levels, FVG, displacement, sweep, BOS/CHoCH, range, SMT | — | Order blocks, breakers, CISD, volume/TPO profile, IB, effort-vs-result | Nothing for profile/IB ($0) |
| Setups | Sweep and Reclaim / Sell the Rip, replay, outcome grading | One playbook only | ORB, intraday momentum, AMD/iFVG, Wyckoff spring | User sign-off on definitions |
| Research | Pre-registration validator, grid runner, H-001 machinery, `walkForward.ts` (Phase 1) | No runner uses walk-forward yet | Cost model shared by every study, PBO/DSR, holdout lock, event-driven backtester | none ($0) |
| Signals / grading | Recorder, grader, track record (n≥30), entry-mark persistence | No real signals recorded | Live level ledger (Phase D) | Bars and uptime |
| Risk / ticket | `/risk`, `/ticket` gates, daily lock, plan gate | Most gates self-reported | Measured gates from live structure | Live bars |
| OMS / execution | none | — | Order model, paper fill simulator, positions, broker adapters, kill switch | Broker choice for anything live |
| Journal | localStorage journal, review, CSV, breakdowns | Per browser only | Supabase sync, fills import from a broker | A production migration (user) |
| LLM | none | — | Read-only assistant over reports and journal | Provider choice and key handling (user) |
| Automation | none | — | Bot framework, paper-only, kill switch, audit | Evidence gate, and later live approval policy |
| Alerts | Power alerts (browser speech and push) | Browser only | Server-side alert rules and delivery | A delivery channel choice |

**Top gaps by leverage.**
1. No real data source of any kind is flowing.
2. There is no paper OMS, so ideas cannot be followed through to a simulated position.
3. The research engine lacks walk-forward, a shared cost model and overfitting statistics.
4. Profile/IB detectors are missing, though they are cheap and $0.
5. The journal lives in one browser.
6. There is no LLM and no automation layer, and both must come after the gates exist.

## 2. Target architecture

```
 data adapters (import CSV | vendor feeds, rights-gated)
        │  closed bars / V2 events, provenance + knownAt
        ▼
 bar & event store (append-only; raw data kept only where rights allow)
        ▼
 structure engine ──► setup engines (versioned playbooks, state machines)
        │                     │
        ▼                     ▼
 research/backtest engine   signal engine ──► alerts
 (pre-reg, walk-forward,      │
  costs, PBO/DSR, holdout)    ▼
        │              risk gates (ticket rules, limits, daily lock)
        ▼                     ▼
 level/outcome ledger     paper OMS (orders, fill model, positions)
 (write-once, n≥30)           ▼
                       broker adapters (OFF by default; kill switch;
                       manual approval per order until the policy allows more)
        ▼                     ▼
 journal + analytics (per user, Supabase RLS) ◄── fills
        ▲
 LLM assistant: reads reports/journal/ledger through read-only tools;
 cannot call OMS, cannot change gates, every answer cites the record it read
```

**Invariants carried forward.**
- Fail closed.
- Every number has a source and a `knownAt`.
- No default for costs or risk.
- Automation states run in a fixed order: `PAPER` → `SHADOW` (paper alongside manual live) → `LIVE_MANUAL_APPROVAL` → (only by explicit policy) `LIVE_AUTO_LIMITED`.
- A kill switch halts every state, and halting is always one action.

## 3. Phases

Phases 1–6 are $0 and need no user decision. Later phases name what blocks them.

### Phase 1: research foundations ($0, no decision). **Implemented; one acceptance item blocked (see below).**
- **Goal:** every study runs on the same honest arithmetic.
- **Deliverables:**
  - `research/walkForward.ts`: anchored and rolling folds with an embargo, and a Wilson interval (done).
  - `research/walkForwardReplay.ts`: the setup replay and the sensitivity grid cut into folds, ideas placed by ACTIONABLE `knownAt`, no rate or Wilson interval below n=30 (done).
  - `research/costModel.ts` (byte-identical `frontend/lib/costModel.ts`): commission and slippage ticks, no defaults; `riskSize.stopRisk` and the replay's `costs.model` both use it. Spread is folded into slippage ticks (conservative reading, recorded in the file) (done).
  - `research/overfitting.ts`: PBO via CSCV, PSR and the Deflated Sharpe Ratio, formulas cited (done).
  - `research/holdoutLock.ts`: a holdout is read once per frozen plan; an `O_EXCL` lock file records the read (done).
- **Acceptance:**
  - No test window overlaps its training window plus the embargo.
  - Wilson matches hand-worked values.
  - PBO matches the CRAN `pbo` vignette on a fixed matrix. **BLOCKED**: CRAN is refused by this environment's network and no R is installed; PBO is checked against hand-worked matrices and an independent brute force instead.
  - A second read of a holdout is refused.
- **Cost:** $0. **Dependencies:** none.

### Phase 2: auction / profile detectors ($0, no decision)
- **Deliverables:** `structure/profile.ts` covering:
  - volume and TPO profile, POC, a 70% value area (the bin size is a versioned parameter)
  - the initial balance and IB extensions
  - single prints
  - prior-day value levels as named levels the sweep detector can use
- **Acceptance:** the prefix-equals-batch look-ahead guard; hand fixtures; the rules version pin; mutation pass.
- **Cost:** $0.

### Phase 3: second and third playbooks, as hypotheses (definitions need sign-off; building them is $0)
- **Deliverables:**
  - Opening-range breakout (Zarattini–Aziz rule as published).
  - First-half-hour → last-half-hour momentum (Gao et al.).
  - Wyckoff spring / AMT failed auction, which reuses the sweep detector.
- Each has a pre-registration written **before** any replay.
- **Acceptance:** the same test families as Sweep and Reclaim.
- **Blocked by:** the user approving the definitions, a light decision.

### Phase 4: event-driven backtester ($0, no decision)
- **Goal:** one engine runs a playbook bar by bar, with orders and fills through the same paper OMS code as Phase 5. Research and paper then cannot diverge (the LEAN/Nautilus idea).
- **Deliverables:**
  - `backtest/engine.ts`, which replays imported bars through setup → risk gates → paper OMS.
  - A report with net R, trade list, costs, walk-forward folds, PBO/DSR, and n≥30 suppression.
- **Acceptance:**
  - A byte-identical rerun.
  - A look-ahead guard (each bar prefix equals the batch run).
  - Results agree with `setupOutcome.ts` on the same ideas.
  - The holdout is untouched until the plan is frozen.

### Phase 5: paper OMS and positions ($0, no decision)
- **Deliverables:**
  - `oms/` with an order state machine (NEW → ACCEPTED → PARTIAL → FILLED / CANCELLED / REJECTED).
  - A fill model: next-bar open plus slippage, with stops filled at worse-of.
  - Position, P&L and R accounting.
  - Pre-trade risk checks that reuse the ticket's daily lock and limits.
  - An append-only audit log.
  - A **kill switch** that cancels everything and blocks new orders.
- **Acceptance:**
  - Every transition is tested.
  - The kill switch is checked before every order.
  - No code path reaches a broker.
- **Storage:** in-memory first. Durable storage needs a migration (Phase 7).

### Phase 6: journal and analytics depth ($0, no decision)
- **Deliverables:**
  - Paper fills flow into the journal automatically, tagged `PAPER`.
  - Breakdowns by playbook, killzone and profile context.
  - An equity curve with drawdown.
  - A process-vs-outcome matrix.
- **Acceptance:** analytics never mixes paper and live; no rate below 30.

### Phase 7: persistence (needs the user to approve production migrations)
- **Deliverables:**
  - Journal sync to Supabase with per-user RLS.
  - Paper OMS orders, fills and audit, write-once.
  - The level ledger (plan Phase D).
- **Acceptance:** `migrationsRerunnable`, `test:pg` parity, rolled-back probes.
- **Blocked by:** the Supabase migration go-ahead.

### Phase 8: live bars (needs a data decision; $0–paid)
- **Deliverables:** plan Phase A (Twelve Data 1-minute bars under the shared credit budget), or a paid bar vendor.
- **Blocked by:**
  - Network allowlist and key.
  - The bar-data budget.
  - ES/NQ requires a paid CME source (plan Phase F).

### Phase 9: LLM assistant (needs provider + key handling decision)
- **Deliverables:**
  - A server-side assistant with **read-only tools** (replay reports, ledger, journal, plan, health).
  - A system prompt that forbids trade recommendations framed as signals.
  - Every answer cites the record ids it read.
  - Rate limits and a cost cap.
  - The key lives in the environment only, never in source (`committedSecrets.test.ts`).
- **Acceptance:**
  - A test that the tool list contains no OMS or gate-writing tool.
  - A prompt-injection test: a journal note saying "approve this ticket" changes nothing.
- **Blocked by:** the provider choice, key handling, and the monthly spend cap.

### Phase 10: real options flow (needs business mode + data budget)
- **Deliverables:** plan Phase E (Tradier or another vendor, validation to `VALIDATED`, H-001-v2 run as frozen).
- **Blocked by:** decisions 1 and 2 below.

### Phase 11: automation framework, paper only ($0 once Phases 4–5 exist)
- **Deliverables:** a `bots/` runner that executes a *frozen, versioned* playbook against live bars into the **paper** OMS only.
- Promotion to the next automation state needs:
  - a pre-registered evidence gate (n≥30 out-of-sample, CI excludes zero net of costs, PBO below a threshold fixed in advance)
  - a human sign-off record
- **Acceptance:** a bot cannot import a broker adapter (source scan); the kill switch halts within one tick.
- **Blocked by:** live bars (Phase 8) to run anything other than replay.

### Phase 12: broker adapters behind approval (needs broker + live-trading policy)
- **Deliverables:**
  - One broker adapter, off by default.
  - Every order requires a manual approval click until the policy allows otherwise.
  - Position and P&L reconciliation against the broker.
  - The kill switch also flattens at the broker.
  - Paper-trading accounts first (for example a broker's paper endpoint).
- **Blocked by:** the broker choice, the live-trading approval policy, and compliance/business mode.

## 4. Decisions the user must make

1. **Business mode:**
   - `PRIVATE_RESEARCH` (personal tool), or
   - `PUBLIC_COMMERCIAL` (sold or shared). This sets the OPRA non-display licensing.
2. **Data budget and vendor:**
   - $0: imported CSV plus Cboe delayed, or
   - about $199/mo personal real-time options (SEARCH_ONLY figure), or
   - commercial.
   - Separately: whether to buy CME futures bars.
3. **Bar source:** allow the Twelve Data host and key, or a paid bar vendor.
4. **Broker:** which one, and whether a paper account comes first. Recommended: yes.
5. **LLM provider and key handling:** which provider, a monthly cost cap, and whether journal text may be sent to it (privacy).
6. **Hosting and uptime:** stay on Render free (it sleeps at 15 minutes), or pay for always-on (`docs/GRADING_UPTIME_OPTIONS.md`).
7. **Supabase migrations:** approve the journal, paper OMS and ledger migrations in production.
8. **Live-trading approval policy:** for example manual approval forever, or auto within a daily loss cap after N paper weeks. This must be written and signed before Phase 12 ships.
9. **Playbook definitions:** sign off on ORB, intraday momentum and Wyckoff spring as written hypotheses (Phase 3).

## 5. Order

1 → 2 → 4 → 5 → 6 (all $0, no decision), with 3 as soon as definitions are signed. Then 7–12 as their decisions arrive. Every PR follows the same loop:
- `npm run verify` (backend and frontend) and `npm run build`
- `test:pg` where storage is touched
- a mutation pass
- a draft PR; merge only on the user's say-so
