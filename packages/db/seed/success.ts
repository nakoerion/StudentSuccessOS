/**
 * Demo success-engine data for the seeded tenants (SYNTHETIC — demo only).
 *
 * The demo tenants have no gradebook entries or attendance yet, so a real recompute would
 * find no data. To give the advisor UI something to show, the seed derives deterministic
 * synthetic signals per student (grade level/trend, attendance level/trend), scores them
 * with the real pure model (`signalsToRisks` + `computeRiskScore`, per grade cohort with
 * the cohort baseline), writes the `risk_score` rows, and then runs the real engine steps
 * on each score: `proposeTrackTransition` (action cards, never applied) and
 * `evaluateRiskAlerts` (alerts on the escalation ladder). A real recompute replaces these
 * scores as soon as the tenant has grades and attendance.
 *
 * Same rules for every tenant and country — nothing here branches on the pack.
 */
import { Prisma } from "@prisma/client";

import { evaluateRiskAlerts } from "../src/alerts";
import { proposeTrackTransition } from "../src/action-cards";
import {
  computeRiskScore,
  getActiveRiskModelConfig,
  signalsToRisks,
  type CohortBaselineJson,
  type RiskSignals,
  type RiskValues,
} from "../src/risk-model";
import { RISK_FACTORS, type RiskFactor } from "../src/success-defaults";

type Tx = Prisma.TransactionClient;
const Decimal = Prisma.Decimal;

export interface SeedStudent {
  id: string;
  /** Grade level of the student's class (the cohort key). */
  grade: number;
  /** 0-based position in the roster (drives the deterministic profile). */
  index: number;
}

/**
 * Deterministic synthetic signals. Every 7th student struggles (low, falling grades and
 * attendance), every 5th does very well, the rest sit in between. Factors whose source
 * slice is not built yet (late/missing, engagement, concern notes) stay null = no data.
 */
export function demoSignals(index: number): RiskSignals {
  const wobble = ((index * 37) % 11) - 5; // -5..5
  if (index % 7 === 2) {
    return {
      gradeLevel: 48 + wobble,
      gradeTrend: -14 + (index % 3),
      attendanceLevel: 79 + (index % 4),
      attendanceTrend: -11 + (index % 3),
      lateMissing: null,
      engagement: null,
      concernNotes: null,
    };
  }
  if (index % 5 === 0) {
    return { gradeLevel: 93 + (index % 4), gradeTrend: 2, attendanceLevel: 99, attendanceTrend: 0, lateMissing: null, engagement: null, concernNotes: null };
  }
  return {
    gradeLevel: 72 + wobble,
    gradeTrend: -3 + (index % 4),
    attendanceLevel: 93 + (index % 5),
    attendanceTrend: -2 + (index % 3),
    lateMissing: null,
    engagement: null,
    concernNotes: null,
  };
}

function mean(values: Prisma.Decimal[]): Prisma.Decimal | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a.plus(b), new Decimal(0)).div(values.length);
}

const r2 = (d: Prisma.Decimal) => d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toNumber();

export interface SuccessDemoResult {
  scores: number;
  cards: number;
  alerts: number;
}

export async function seedSuccessDemo(tx: Tx, tenantId: string, students: SeedStudent[], now: Date): Promise<SuccessDemoResult> {
  const config = await getActiveRiskModelConfig(tx, tenantId);
  const byGrade = new Map<number, SeedStudent[]>();
  for (const s of students) byGrade.set(s.grade, [...(byGrade.get(s.grade) ?? []), s]);

  let cards = 0;
  let alerts = 0;
  let scores = 0;
  for (const [grade, members] of [...byGrade].sort((a, b) => a[0] - b[0])) {
    const signals = new Map(members.map((m) => [m.id, demoSignals(m.index)]));
    const risks = new Map<string, RiskValues>(members.map((m) => [m.id, signalsToRisks(signals.get(m.id)!)]));
    const base = {} as Record<RiskFactor, Prisma.Decimal | null>;
    for (const f of RISK_FACTORS) base[f] = mean([...risks.values()].map((r) => r[f]).filter((v): v is Prisma.Decimal => v !== null));
    const comps = members.map((m) => ({
      m,
      c: computeRiskScore({ risks: risks.get(m.id)!, signals: signals.get(m.id)!, weights: config.weights, thresholds: config.bandThresholds, baseline: base }),
    }));
    const scored = comps.filter((x): x is { m: SeedStudent; c: NonNullable<typeof x.c> } => x.c !== null);
    const cohortMean = mean(scored.map((x) => new Decimal(x.c.score)));
    const baseline: CohortBaselineJson = {
      grade: String(grade),
      cohortSize: members.length,
      scoredCohortSize: scored.length,
      factors: Object.fromEntries(RISK_FACTORS.map((f) => [f, base[f] === null ? null : r2(base[f])])) as Record<RiskFactor, number | null>,
      score: cohortMean === null ? null : r2(cohortMean),
      asOf: now.toISOString(),
    };

    for (const { m, c } of scored) {
      const row = await tx.riskScore.create({
        data: {
          tenantId,
          studentPersonId: m.id,
          modelConfigId: config.id,
          modelVersion: config.version,
          score: new Decimal(c.score),
          band: c.band,
          factors: c.factors as unknown as Prisma.InputJsonValue,
          cohortBaseline: baseline as unknown as Prisma.InputJsonValue,
          computedAt: now,
        },
        select: { id: true },
      });
      scores++;
      const riskScore = {
        id: row.id,
        studentPersonId: m.id,
        modelConfigId: config.id,
        modelVersion: config.version,
        score: c.score,
        band: c.band,
        factors: c.factors,
        cohortBaseline: baseline,
        computedAt: now,
      };
      const proposal = await proposeTrackTransition(tx, { tenantId, riskScore, thresholds: config.bandThresholds, now });
      if (proposal.status === "proposed") cards++;
      const ev = await evaluateRiskAlerts(tx, { tenantId, riskScore, now });
      alerts += ev.opened.length;
    }
  }
  return { scores, cards, alerts };
}
