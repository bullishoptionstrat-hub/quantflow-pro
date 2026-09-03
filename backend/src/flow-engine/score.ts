/**
 * Unusualness score v1 — deterministic rules, 0–100, full breakdown.
 *
 * Deliberately NOT machine learning. The ML scorer earns its place only
 * after outcome tracking produces labeled data. Every component is
 * explainable so the UI can show *why* a signal scored what it did.
 */
import { ClassifiedSignal, ContractStats, OptionContract } from "./types";

export interface ScoreInput {
  kind: ClassifiedSignal["kind"];
  totalPremium: number;
  totalSize: number;
  iso: boolean;
  sideAmbiguous: boolean;
  exchanges: number;        // distinct exchange count in cluster
  prints: number;
  contract: OptionContract;
  signalTs: number;
  stats?: ContractStats;
  /** Repeat-hit count: prior signals on same contract+side today. */
  repeatHits?: number;
}

export function scoreSignal(input: ScoreInput): {
  score: number;
  breakdown: Record<string, number>;
} {
  const b: Record<string, number> = {};

  // 1) Premium tier — up to 30
  b.premium =
    input.totalPremium >= 1_000_000 ? 30 :
    input.totalPremium >= 500_000 ? 24 :
    input.totalPremium >= 250_000 ? 18 :
    input.totalPremium >= 100_000 ? 12 :
    input.totalPremium >= 50_000 ? 7 : 3;

  // 2) Aggression — up to 20
  let aggression = 0;
  if (input.kind === "SWEEP") aggression += 10;
  if (input.iso) aggression += 5;
  if (input.exchanges >= 3) aggression += 5;
  else if (input.exchanges === 2) aggression += 3;
  b.aggression = Math.min(20, aggression);

  // 3) Vol vs OI — up to 20 (vol > OI ⇒ likely opening interest)
  const oi = input.stats?.openInterest;
  const dayVol = input.stats?.dayVolume;
  if (oi !== undefined && oi >= 0) {
    const volAfter = (dayVol ?? 0) + input.totalSize;
    if (oi === 0 || volAfter > oi) b.volOverOi = 20;
    else if (volAfter > oi * 0.5) b.volOverOi = 10;
    else b.volOverOi = 0;
  } else {
    b.volOverOi = 0; // unknown OI never inflates the score
  }

  // 4) OTM distance — up to 10 (far OTM size = conviction or lotto; flag it)
  const spot = input.stats?.underlyingPrice;
  if (spot !== undefined && spot > 0) {
    const { right, strike } = input.contract;
    const otmPct =
      right === "C" ? (strike - spot) / spot : (spot - strike) / spot;
    b.otm = otmPct >= 0.10 ? 10 : otmPct >= 0.05 ? 7 : otmPct >= 0.02 ? 4 : 0;
  } else {
    b.otm = 0;
  }

  // 5) DTE — up to 10 (short-dated size = urgency)
  const dte = daysBetween(input.signalTs, input.contract.expiry);
  b.dte = dte <= 2 ? 10 : dte <= 7 ? 7 : dte <= 21 ? 4 : dte <= 45 ? 2 : 0;

  // 6) Repeat hits — up to 10
  const hits = input.repeatHits ?? 0;
  b.repeats = hits >= 4 ? 10 : hits >= 2 ? 6 : hits >= 1 ? 3 : 0;

  // Penalty: side unknown ⇒ the signal is descriptive, not directional
  b.ambiguousPenalty = input.sideAmbiguous ? -15 : 0;

  const raw = Object.values(b).reduce((a, v) => a + v, 0);
  const score = Math.max(0, Math.min(100, raw));

  // The clamp is published as a term, so the breakdown always sums to the
  // score beside it.
  //
  // It was applied silently. The components floor at `premium: 3` and the
  // ambiguous penalty is -15, so raw reaches **-12** on a low-premium signal
  // whose side could not be inferred — while the score reads 0. Every consumer
  // of `scoreBreakdown` is invited to add it up (the power alerts page renders
  // each term under the heat number), and it would not have reconciled.
  //
  // The upper bound cannot bite today — the six components sum to exactly 100
  // — but if a threshold is ever raised past that, this makes the overflow
  // visible rather than swallowing it.
  if (score !== raw) b.clamp = score - raw;

  return { score, breakdown: b };
}

function daysBetween(tsMs: number, isoDate: string): number {
  const expiry = Date.parse(`${isoDate}T20:00:00Z`); // ~4pm ET close
  if (Number.isNaN(expiry)) return 9999;
  return Math.max(0, (expiry - tsMs) / 86_400_000);
}
