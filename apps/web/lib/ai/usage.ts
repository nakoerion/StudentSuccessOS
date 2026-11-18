/**
 * Pure rules for the AI usage and quality page. Kept out of the page so the two rules that
 * matter can be tested directly:
 *  - a run on the fake provider (or with no quality score) is never presented as a quality pass;
 *  - spend keeps four decimals, so a real figure is never rounded to $0.00.
 */
import type { DiscretionaryDerivation, EssentialDerivation, EvalRun, PoolUsage } from "./client";

/** Caps: ordinary currency. */
export const CAP_FORMAT = { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 } as const;
/** Spend: four decimals, so $0.0042 does not show as $0.00. */
export const SPEND_FORMAT = { style: "currency", currency: "USD", minimumFractionDigits: 4, maximumFractionDigits: 4 } as const;

export type EvalQuality =
  /** A live model answered every case and the harness scored answer quality. */
  | { kind: "measured"; score: number; tone: "good" | "bad" }
  /** Some cases were answered live: a score exists but covers only part of the suite. */
  | { kind: "partial"; score: number; measured: number }
  /** No live model answered (fake provider, or no calls): plumbing only, no quality score. */
  | { kind: "not_measured" };

export function evalQuality(run: Pick<EvalRun, "providerMode" | "qualityScore" | "qualityMeasured" | "verdict">): EvalQuality {
  if (run.qualityScore === null || run.providerMode === "fake" || run.providerMode === "none") return { kind: "not_measured" };
  if (run.providerMode === "mixed") return { kind: "partial", score: run.qualityScore, measured: run.qualityMeasured };
  return { kind: "measured", score: run.qualityScore, tone: run.verdict === "pass" || run.verdict === "first_run" ? "good" : "bad" };
}

/** Message key + values for the one-line explanation of how the discretionary cap was set. */
export function capLine(d: DiscretionaryDerivation): { key: string; values: Record<string, number> } {
  switch (d.basis) {
    case "explicit":
      return { key: "derivation.explicit", values: { cap: d.capUsd } };
    case "per_seat":
      return { key: "derivation.perSeat", values: { seats: d.seatCount, perSeat: d.perSeatUsd, floor: d.floorUsd, cap: d.capUsd } };
    case "floor":
      // An unknown seat count must read as "no seat count reported", never as a measured number.
      return d.seatCount === null
        ? { key: "derivation.floorNoSeats", values: { floor: d.floorUsd } }
        : { key: "derivation.floorBelow", values: { seats: d.seatCount, perSeat: d.perSeatUsd, floor: d.floorUsd } };
  }
}

export function essentialLine(d: EssentialDerivation): { key: string; values: Record<string, number> } {
  switch (d.basis) {
    case "explicit":
      return { key: "derivation.essentialExplicit", values: { cap: d.capUsd } };
    case "share":
      return { key: "derivation.essentialShare", values: { share: d.share, cap: d.capUsd } };
    case "floor":
      return { key: "derivation.essentialFloor", values: { floor: d.floorUsd } };
  }
}

/** Bar geometry in percent of the track: fill clamped to 0..100, warning line where the 80% sits. */
export function barGeometry(p: Pick<PoolUsage, "usedRatio" | "warningRatio">): { fill: number; warningAt: number } {
  const clamp = (n: number) => Math.min(100, Math.max(0, Number.isFinite(n) ? n : 0));
  return { fill: clamp(p.usedRatio * 100), warningAt: clamp(p.warningRatio * 100) };
}

export type PoolState = "ok" | "warning" | "exhausted";
export function poolState(p: Pick<PoolUsage, "warning" | "exhausted">): PoolState {
  return p.exhausted ? "exhausted" : p.warning ? "warning" : "ok";
}
