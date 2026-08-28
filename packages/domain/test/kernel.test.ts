import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ok, stale, unavailable, isOk, valueOrUndefined, toWire,
  resolveRuntimeMode, syntheticDataAllowed, assertSyntheticAllowed, SyntheticDataForbiddenError,
  evaluateFreshness, validatePayload, defaultContract, DAY_MS,
  asOf, latestAsOf, assertKnowable, LookaheadError,
  FINRA_DAILY_LAG, CBOE_EOD_LAG, etTimeOnDate,
  etHour, isEasternDaylightTime, isTradingDay, previousTradingDay, recentTradingDays,
  combineQuality, good, makeProvenance,
} from "../src/index.js";

const PROV = makeProvenance({
  provider: "TEST", dataset: "unit", cadence: "DAILY", caveats: [], parserVersion: "test-1",
});

// ------------------------------------------------------------ GATE C: no fake zero

test("GATE C: UNAVAILABLE never yields a numeric value", () => {
  const r = unavailable<number>("HTTP 403 from provider");
  assert.equal(r.status, "UNAVAILABLE");
  assert.equal(valueOrUndefined(r), undefined);
  // The critical property: there is no code path that turns this into 0.
  assert.notEqual(valueOrUndefined(r), 0);
});

test("GATE C: wire format makes unavailability explicit to clients, value null not 0", () => {
  const w = toWire(unavailable<number>("403"));
  assert.equal(w.status, "UNAVAILABLE");
  assert.equal(w.value, null);
  assert.notEqual(w.value, 0);
});

test("GATE C: a real zero is distinguishable from missing data", () => {
  const realZero = ok(0, PROV, good());
  const missing = unavailable<number>("fetch failed");
  assert.equal(isOk(realZero), true);
  assert.equal(valueOrUndefined(realZero), 0);
  assert.equal(isOk(missing), false);
  // Same JS value, different status — that is the whole point.
  assert.notEqual(realZero.status, missing.status);
});

test("STALE may carry a last-known value but is never reported as OK", () => {
  const r = stale<number>(PROV, { state: "STALE", flags: ["STALE_SOURCE"] }, 5 * DAY_MS, "old file", 1.23);
  assert.equal(r.status, "STALE");
  assert.equal(valueOrUndefined(r), 1.23);
  assert.equal(isOk(r), false);
});

// ------------------------------------------------------------ GATE B: simulation quarantine

test("GATE B: RUNTIME_MODE defaults to PRODUCTION_REAL when unset (fail closed)", () => {
  assert.equal(resolveRuntimeMode({} as NodeJS.ProcessEnv), "PRODUCTION_REAL");
  assert.equal(resolveRuntimeMode({ RUNTIME_MODE: "" } as NodeJS.ProcessEnv), "PRODUCTION_REAL");
});

test("GATE B: an invalid RUNTIME_MODE throws rather than silently permitting synthetic", () => {
  assert.throws(() => resolveRuntimeMode({ RUNTIME_MODE: "PROD" } as NodeJS.ProcessEnv), /Invalid RUNTIME_MODE/);
});

test("GATE B: synthetic data forbidden in PRODUCTION_REAL and DEVELOPMENT", () => {
  assert.equal(syntheticDataAllowed("PRODUCTION_REAL"), false);
  assert.equal(syntheticDataAllowed("DEVELOPMENT"), false);
  assert.equal(syntheticDataAllowed("DEMO"), true);
  assert.equal(syntheticDataAllowed("TEST"), true);
  assert.equal(syntheticDataAllowed("REPLAY"), true);
});

test("GATE B: assertSyntheticAllowed throws in production, naming what was blocked", () => {
  assert.throws(
    () => assertSyntheticAllowed("dark pool prints", "PRODUCTION_REAL"),
    (e: unknown) => e instanceof SyntheticDataForbiddenError && /dark pool prints/.test((e as Error).message)
  );
  assert.doesNotThrow(() => assertSyntheticAllowed("flow", "DEMO"));
});

// ------------------------------------------------------------ GATE F: 200-OK stale defense

test("GATE F: a payload dated 2019 is STALE even though transport succeeded", () => {
  const now = new Date("2026-08-17T12:00:00Z");
  const v = validatePayload("2019-10-04", 5000, defaultContract("DAILY", 100), now);
  assert.equal(v.fresh, false);
  assert.equal(v.quality.state, "STALE");
  assert.ok(v.quality.flags.includes("STALE_SOURCE"));
  assert.match(v.quality.note ?? "", /2019-10-04/);
});

test("GATE F: fresh daily file inside the weekend budget is GOOD", () => {
  const now = new Date("2026-08-17T12:00:00Z"); // Monday
  const v = validatePayload("2026-08-14", 12000, defaultContract("DAILY", 100), now);
  assert.equal(v.fresh, true);
  assert.equal(v.quality.state, "GOOD");
});

test("GATE F: low row count downgrades to PARTIAL even when dates are fresh", () => {
  const now = new Date("2026-08-17T12:00:00Z");
  const v = validatePayload("2026-08-14", 3, defaultContract("DAILY", 100), now);
  assert.equal(v.quality.state, "PARTIAL");
  assert.ok(v.quality.flags.includes("LOW_COVERAGE"));
});

test("GATE F: missing effective date cannot be treated as fresh", () => {
  const v = evaluateFreshness(undefined, defaultContract("DAILY"));
  assert.equal(v.fresh, false);
  assert.ok(v.flags.includes("STALE_SOURCE"));
});

test("GATE F: a future-dated payload is rejected as clock skew, not accepted as very fresh", () => {
  const now = new Date("2026-08-17T12:00:00Z");
  const v = evaluateFreshness("2026-09-01", defaultContract("DAILY"), now);
  assert.equal(v.fresh, false);
  assert.ok(v.flags.includes("SCHEMA_DRIFT"));
});

// ------------------------------------------------------------ GATE G: point-in-time

const RECS = [
  { effectiveAt: "2026-08-14", availableAt: FINRA_DAILY_LAG.availableAtFor("2026-08-14"), dix: 0.468 },
  { effectiveAt: "2026-08-13", availableAt: FINRA_DAILY_LAG.availableAtFor("2026-08-13"), dix: 0.441 },
  { effectiveAt: "2026-08-12", availableAt: FINRA_DAILY_LAG.availableAtFor("2026-08-12"), dix: 0.452 },
];

test("GATE G: publication-lag lookahead is blocked — Friday 10am cannot see Friday's DIX", () => {
  // 2026-08-14 10:00 ET. FINRA posts that file at 18:00 ET the same day.
  const decision = etTimeOnDate("2026-08-14", 10, 0);
  const visible = asOf(RECS, decision);
  assert.equal(visible.some((r) => r.effectiveAt === "2026-08-14"), false,
    "Friday's file must NOT be visible at Friday 10:00 ET");
  assert.equal(visible.length, 2);
  assert.equal(latestAsOf(RECS, decision)?.effectiveAt, "2026-08-13");
});

test("GATE G: after publication time the same record IS visible", () => {
  const decision = etTimeOnDate("2026-08-14", 19, 0); // 19:00 ET, after the 18:00 post
  assert.equal(latestAsOf(RECS, decision)?.effectiveAt, "2026-08-14");
});

test("GATE G: assertKnowable throws on a deliberate lookahead attempt", () => {
  const decision = etTimeOnDate("2026-08-14", 10, 0);
  assert.throws(
    () => assertKnowable(RECS[0], decision),
    (e: unknown) => e instanceof LookaheadError && /LOOKAHEAD/.test((e as Error).message)
  );
});

test("GATE G: records lacking availableAt are EXCLUDED, never assumed available", () => {
  const sneaky = [{ effectiveAt: "2026-08-14", availableAt: "" }];
  assert.equal(asOf(sneaky, "2026-08-20T00:00:00Z").length, 0);
});

test("GATE G: Cboe EOD lag is modelled separately from FINRA", () => {
  assert.notEqual(CBOE_EOD_LAG.availableAtFor("2026-08-14"), FINRA_DAILY_LAG.availableAtFor("2026-08-14"));
});

// ------------------------------------------------------------ Phase 53: DST correctness

test("DST: 18:00 ET maps to 22:00Z in EDT (summer)", () => {
  assert.equal(FINRA_DAILY_LAG.availableAtFor("2026-08-14"), "2026-08-14T22:00:00.000Z");
});

test("DST: 18:00 ET maps to 23:00Z in EST (winter) — the hardcoded -4 bug", () => {
  assert.equal(FINRA_DAILY_LAG.availableAtFor("2026-01-15"), "2026-01-15T23:00:00.000Z");
});

test("DST: etHour is correct on both sides of the spring-forward boundary", () => {
  // 2026-03-08 is the US spring-forward date.
  assert.equal(etHour(new Date("2026-03-07T17:00:00Z")), 12); // EST, UTC-5
  assert.equal(etHour(new Date("2026-03-09T16:00:00Z")), 12); // EDT, UTC-4
});

test("DST: EDT/EST detection matches the offset", () => {
  assert.equal(isEasternDaylightTime(new Date("2026-08-14T12:00:00Z")), true);
  assert.equal(isEasternDaylightTime(new Date("2026-01-14T12:00:00Z")), false);
});

// ------------------------------------------------------------ Phase 68: trading calendar

test("calendar: weekends and holidays are not trading days", () => {
  assert.equal(isTradingDay("2026-08-15"), false); // Saturday
  assert.equal(isTradingDay("2026-08-16"), false); // Sunday
  assert.equal(isTradingDay("2026-12-25"), false); // Christmas
  assert.equal(isTradingDay("2026-08-14"), true);  // Friday
});

test("calendar: previousTradingDay skips the weekend rather than decrementing blindly", () => {
  assert.equal(previousTradingDay("2026-08-17"), "2026-08-14");
});

test("calendar: previousTradingDay is bounded and throws instead of looping forever", () => {
  assert.throws(() => previousTradingDay("2026-08-17", 0), /no trading day found/);
});

test("calendar: recentTradingDays returns real sessions only", () => {
  const d = recentTradingDays("2026-08-17", 4);
  assert.deepEqual(d, ["2026-08-17", "2026-08-14", "2026-08-13", "2026-08-12"]);
});

// ------------------------------------------------------------ quality combination

test("quality: combining inputs takes the worst state and unions the flags", () => {
  const c = combineQuality([
    { state: "GOOD", flags: [] },
    { state: "PARTIAL", flags: ["LOW_COVERAGE"] },
    { state: "STALE", flags: ["STALE_SOURCE"] },
  ]);
  assert.equal(c.state, "STALE");
  assert.deepEqual(c.flags.sort(), ["LOW_COVERAGE", "STALE_SOURCE"]);
});

// ------------------------------------------------------------ date-only granularity
// Regression: the connector probe reported Cboe and Yahoo as STALE because a
// date-only "2026-08-20" parses as midnight UTC, making same-day data look ~1
// day old against an intraday budget.

test('GATE F: a same-day date-only payload is FRESH under a REALTIME contract', () => {
  const now = new Date("2026-08-20T20:00:00Z"); // 16:00 ET
  const v = evaluateFreshness("2026-08-20", defaultContract("REALTIME"), now);
  assert.equal(v.fresh, true, "same session must not be reported stale");
});

test('GATE F: yesterday date-only is FRESH under DELAYED (previous close is legitimate)', () => {
  const now = new Date("2026-08-20T14:00:00Z");
  assert.equal(evaluateFreshness("2026-08-19", defaultContract("DELAYED"), now).fresh, true);
});

test('GATE F: the 2019 file is STILL detected as stale under day granularity', () => {
  const now = new Date("2026-08-20T14:00:00Z");
  const v = evaluateFreshness("2019-10-04", defaultContract("DAILY"), now);
  assert.equal(v.fresh, false);
  assert.ok(v.flags.includes("STALE_SOURCE"));
  assert.match(v.reason ?? "", /2513d old|25\d\dd old/);
});

test('GATE F: a future date-only value is still rejected as clock skew', () => {
  const now = new Date("2026-08-20T14:00:00Z");
  const v = evaluateFreshness("2026-09-01", defaultContract("DAILY"), now);
  assert.equal(v.fresh, false);
  assert.ok(v.flags.includes("SCHEMA_DRIFT"));
});
