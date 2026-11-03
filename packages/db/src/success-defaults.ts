/**
 * Success engine defaults every new tenant starts from: risk model weights (version 1,
 * active) and alert rules with a teacher -> advisor -> parent escalation ladder.
 *
 * These are the same for every country: nothing here branches on the pack. A school
 * tunes them per tenant (a new risk_model_config version / edited alert_rule rows).
 */
import type { Prisma } from "@prisma/client";

/** Risk factors the model weighs. Weights sum to 1; contributions are weight x factor (0–100). */
export const RISK_FACTORS = [
  "gradeLevel",
  "gradeTrend",
  "attendanceLevel",
  "attendanceTrend",
  "lateMissing",
  "engagement",
  "concernNotes",
] as const;
export type RiskFactor = (typeof RISK_FACTORS)[number];

export const DEFAULT_RISK_WEIGHTS: Readonly<Record<RiskFactor, number>> = {
  gradeLevel: 0.25,
  gradeTrend: 0.15,
  attendanceLevel: 0.2,
  attendanceTrend: 0.1,
  lateMissing: 0.15,
  engagement: 0.05,
  concernNotes: 0.1,
};

/** Score >= value puts a student in that band (below `moderate` = low). */
export const DEFAULT_BAND_THRESHOLDS = { moderate: 30, high: 55, critical: 75 } as const;

export type EscalationRole = "teacher" | "advisor" | "parent";
export interface EscalationStep {
  level: number;
  role: EscalationRole;
  /** Minutes the role has to acknowledge before the alert escalates to the next step. */
  slaMinutes: number;
}

export interface DefaultAlertRule {
  key: string;
  name: string;
  metric: string;
  threshold: { op: "gte" | "lte"; value: number; windowDays?: number };
  severity: "info" | "warning" | "critical";
  escalation: readonly EscalationStep[];
}

const ladder = (teacher: number, advisor: number, parent: number): EscalationStep[] => [
  { level: 0, role: "teacher", slaMinutes: teacher },
  { level: 1, role: "advisor", slaMinutes: advisor },
  { level: 2, role: "parent", slaMinutes: parent },
];

const DAY = 24 * 60;

export const DEFAULT_ALERT_RULES: readonly DefaultAlertRule[] = [
  {
    key: "risk_high",
    name: "Risk score high",
    metric: "risk_score",
    threshold: { op: "gte", value: DEFAULT_BAND_THRESHOLDS.high },
    severity: "warning",
    escalation: ladder(2 * DAY, 3 * DAY, 5 * DAY),
  },
  {
    key: "risk_critical",
    name: "Risk score critical",
    metric: "risk_score",
    threshold: { op: "gte", value: DEFAULT_BAND_THRESHOLDS.critical },
    severity: "critical",
    escalation: ladder(4 * 60, DAY, 2 * DAY),
  },
  {
    key: "attendance_low",
    name: "Attendance below 90% (last 30 days)",
    metric: "attendance_rate",
    threshold: { op: "lte", value: 90, windowDays: 30 },
    severity: "warning",
    escalation: ladder(DAY, 2 * DAY, 3 * DAY),
  },
  {
    key: "late_submissions",
    name: "3+ late or missing submissions (last 14 days)",
    metric: "late_submissions",
    threshold: { op: "gte", value: 3, windowDays: 14 },
    severity: "info",
    escalation: ladder(2 * DAY, 3 * DAY, 5 * DAY),
  },
];

/** Insert the defaults for one tenant. `newId` lets the seed use deterministic ids. */
export async function createSuccessDefaults(
  tx: Prisma.TransactionClient,
  tenantId: string,
  newId?: (table: string, key: string) => string,
): Promise<{ riskModelConfigId: string; alertRules: number }> {
  const config = await tx.riskModelConfig.create({
    data: {
      ...(newId ? { id: newId("risk_model_config", "v1") } : {}),
      tenantId,
      version: 1,
      weights: { ...DEFAULT_RISK_WEIGHTS },
      bandThresholds: { ...DEFAULT_BAND_THRESHOLDS },
      isActive: true,
      activatedAt: new Date(),
      note: "Default weights",
    },
  });
  await tx.alertRule.createMany({
    data: DEFAULT_ALERT_RULES.map((r) => ({
      ...(newId ? { id: newId("alert_rule", r.key) } : {}),
      tenantId,
      key: r.key,
      name: r.name,
      metric: r.metric,
      threshold: r.threshold,
      severity: r.severity,
      escalation: r.escalation.map((s) => ({ ...s })),
    })),
  });
  return { riskModelConfigId: config.id, alertRules: DEFAULT_ALERT_RULES.length };
}
