/**
 * Success engine (slice 1: data model) — tenant isolation of the eleven new tables,
 * the seeded defaults, and the hand-written integrity rules, against the live DB.
 */
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DEFAULT_ALERT_RULES, DEFAULT_RISK_WEIGHTS } from "../src/success-defaults";
import { type TenantTx, withTenant } from "../src/with-tenant";
import { appClient, ownerClient, Rollback, TENANT_A, TENANT_B } from "./helpers";

let app: PrismaClient;
let owner: PrismaClient;

const SUCCESS_TABLES = [
  "risk_model_config",
  "risk_score",
  "track_assignment",
  "action_card",
  "alert_rule",
  "alert",
  "intervention",
  "intervention_task",
  "goal",
  "goal_progress",
  "nudge",
] as const;
type SuccessTable = (typeof SUCCESS_TABLES)[number];

/** One row per success table in tenant B, created by the owner; ids by table. */
let probe: Record<SuccessTable, string>;
const PROBE_RULE_KEY = "probe_isolation";
const PROBE_CONFIG_VERSION = 999;

const monday = new Date("2026-11-02T00:00:00Z");

async function buildChain(db: PrismaClient | TenantTx, tenantId: string) {
  const student = await db.person.findFirstOrThrow({ where: { tenantId, externalRef: "S-001" } });
  const config = await db.riskModelConfig.create({
    data: { tenantId, version: PROBE_CONFIG_VERSION, weights: { gradeLevel: 1 }, bandThresholds: { moderate: 30, high: 55, critical: 75 } },
  });
  const score = await db.riskScore.create({
    data: {
      tenantId,
      studentPersonId: student.id,
      modelConfigId: config.id,
      modelVersion: config.version,
      score: "42.50",
      band: "moderate",
      factors: [{ factor: "gradeLevel", contribution: 42.5 }],
    },
  });
  const card = await db.actionCard.create({
    data: {
      tenantId,
      type: "track_transition",
      subjectPersonId: student.id,
      confidence: "0.800",
      proposedPayload: { track: "support" },
      assigneeRole: "advisor",
      sourceRiskScoreId: score.id,
    },
  });
  const track = await db.trackAssignment.create({
    data: { tenantId, studentPersonId: student.id, track: "support", status: "ended", confidence: "0.800", effectiveDate: monday, actionCardId: card.id },
  });
  const rule = await db.alertRule.create({
    data: {
      tenantId,
      key: PROBE_RULE_KEY,
      name: "Probe",
      metric: "risk_score",
      threshold: { op: "gte", value: 1 },
      escalation: [{ level: 0, role: "teacher", slaMinutes: 60 }],
    },
  });
  const alert = await db.alert.create({
    data: { tenantId, ruleId: rule.id, studentPersonId: student.id, severity: "warning", assigneeRole: "teacher", state: "resolved" },
  });
  const intervention = await db.intervention.create({
    data: { tenantId, studentPersonId: student.id, type: "mentoring", actionCardId: card.id, alertId: alert.id, riskBefore: "42.50" },
  });
  const task = await db.interventionTask.create({ data: { tenantId, interventionId: intervention.id, title: "Probe task" } });
  const goal = await db.goal.create({
    data: { tenantId, studentPersonId: student.id, title: "Probe goal", metric: "attendance_rate", target: "95.00", deadline: new Date("2027-01-31") },
  });
  const progress = await db.goalProgress.create({ data: { tenantId, goalId: goal.id, value: "91.00", progressPct: "20.00" } });
  const nudge = await db.nudge.create({
    data: { tenantId, goalId: goal.id, recipientPersonId: student.id, weekStart: monday, scheduledFor: monday },
  });
  return {
    risk_model_config: config.id,
    risk_score: score.id,
    track_assignment: track.id,
    action_card: card.id,
    alert_rule: rule.id,
    alert: alert.id,
    intervention: intervention.id,
    intervention_task: task.id,
    goal: goal.id,
    goal_progress: progress.id,
    nudge: nudge.id,
  } satisfies Record<SuccessTable, string>;
}

async function dropChain(tenantId: string) {
  // Cascades remove everything hanging off the rule / goal / student rows created above.
  await owner.intervention.deleteMany({ where: { tenantId, type: "mentoring", alert: { rule: { key: PROBE_RULE_KEY } } } });
  await owner.alertRule.deleteMany({ where: { tenantId, key: PROBE_RULE_KEY } });
  await owner.goal.deleteMany({ where: { tenantId, title: "Probe goal" } });
  await owner.trackAssignment.deleteMany({ where: { tenantId, actionCard: { sourceRiskScore: { modelVersion: PROBE_CONFIG_VERSION } } } });
  await owner.actionCard.deleteMany({ where: { tenantId, sourceRiskScore: { modelVersion: PROBE_CONFIG_VERSION } } });
  await owner.riskScore.deleteMany({ where: { tenantId, modelVersion: PROBE_CONFIG_VERSION } });
  await owner.riskModelConfig.deleteMany({ where: { tenantId, version: PROBE_CONFIG_VERSION } });
}

beforeAll(async () => {
  app = appClient();
  owner = ownerClient();
  await dropChain(TENANT_B);
  probe = await buildChain(owner, TENANT_B);
});
afterAll(async () => {
  await dropChain(TENANT_B);
  await app.$disconnect();
  await owner.$disconnect();
});

describe("success engine: seeded defaults", () => {
  for (const [label, tenantId, otherId] of [
    ["A (Tirana)", TENANT_A, TENANT_B],
    ["B (Abu Dhabi)", TENANT_B, TENANT_A],
  ] as const) {
    it(`tenant ${label} sees exactly its own active risk weights v1 and default alert rules`, async () => {
      const r = await withTenant(
        tenantId,
        async (tx) => ({
          active: await tx.riskModelConfig.findMany({ where: { isActive: true } }),
          rules: await tx.alertRule.findMany({ where: { key: { not: PROBE_RULE_KEY } }, orderBy: { key: "asc" } }),
          otherRules: await tx.alertRule.count({ where: { tenantId: otherId } }),
        }),
        { client: app },
      );
      expect(r.active).toHaveLength(1);
      expect(r.active[0]!.tenantId).toBe(tenantId);
      expect(r.active[0]!.version).toBe(1);
      expect(r.active[0]!.weights).toEqual(DEFAULT_RISK_WEIGHTS);
      const sum = Object.values(r.active[0]!.weights as Record<string, number>).reduce((a, b) => a + b, 0);
      expect(sum).toBeCloseTo(1, 10);
      expect(r.rules.map((x) => x.key)).toEqual(DEFAULT_ALERT_RULES.map((x) => x.key).sort());
      for (const rule of r.rules) {
        expect(rule.tenantId).toBe(tenantId);
        const ladder = rule.escalation as { role: string; slaMinutes: number }[];
        expect(ladder.map((s) => s.role)).toEqual(["teacher", "advisor", "parent"]);
        for (const s of ladder) expect(s.slaMinutes).toBeGreaterThan(0);
      }
      expect(r.otherRules).toBe(0);
    });
  }
});

describe("success engine: tenant isolation", () => {
  it("every success table is RLS-forced with the tenant_isolation policy", async () => {
    const rows = await owner.$queryRaw<{ relname: string; forced: boolean; policies: bigint }[]>`
      SELECT c.relname, c.relforcerowsecurity AS forced,
             (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname = 'tenant_isolation') AS policies
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = ANY(${[...SUCCESS_TABLES]}) AND c.relrowsecurity`;
    expect(rows.map((r) => r.relname).sort()).toEqual([...SUCCESS_TABLES].sort());
    for (const r of rows) {
      expect(r.forced).toBe(true);
      expect(Number(r.policies)).toBe(1);
    }
  });

  it("tenant B's rows in all eleven tables are visible to B and invisible to A", async () => {
    const countIn = (tenantId: string) =>
      withTenant(
        tenantId,
        async (tx) => {
          const out: Record<string, number> = {};
          for (const t of SUCCESS_TABLES) {
            const [row] = await tx.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM "${t}" WHERE id = $1::uuid`, probe[t]);
            out[t] = Number(row!.n);
          }
          return out;
        },
        { client: app },
      );
    expect(await countIn(TENANT_B)).toEqual(Object.fromEntries(SUCCESS_TABLES.map((t) => [t, 1])));
    expect(await countIn(TENANT_A)).toEqual(Object.fromEntries(SUCCESS_TABLES.map((t) => [t, 0])));
  });

  it("UPDATE and DELETE from tenant A aimed at tenant B's rows affect nothing", async () => {
    const affected = await withTenant(
      TENANT_A,
      async (tx) => {
        let n = 0;
        for (const t of SUCCESS_TABLES) {
          n += await tx.$executeRawUnsafe(`UPDATE "${t}" SET updated_at = now() WHERE id = $1::uuid`, probe[t]);
          n += await tx.$executeRawUnsafe(`DELETE FROM "${t}" WHERE id = $1::uuid`, probe[t]);
        }
        return n;
      },
      { client: app },
    );
    expect(affected).toBe(0);
    for (const t of SUCCESS_TABLES) {
      const [row] = await owner.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM "${t}" WHERE id = $1::uuid`, probe[t]);
      expect(Number(row!.n), t).toBe(1);
    }
  });

  it("rejects INSERT carrying another tenant's tenant_id", async () => {
    await expect(
      withTenant(
        TENANT_A,
        (tx) =>
          tx.alertRule.create({
            data: { tenantId: TENANT_B, key: "x", name: "x", metric: "risk_score", threshold: {}, escalation: [{ level: 0, role: "teacher", slaMinutes: 1 }] },
          }),
        { client: app },
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("rejects a tenant-A action card about a tenant-B student (composite FK)", async () => {
    const bStudent = await owner.person.findFirstOrThrow({ where: { tenantId: TENANT_B, externalRef: "S-001" } });
    await expect(
      withTenant(
        TENANT_A,
        (tx) =>
          tx.actionCard.create({
            data: { tenantId: TENANT_A, type: "intervention", subjectPersonId: bStudent.id, confidence: "0.5", proposedPayload: {}, assigneeRole: "advisor" },
          }),
        { client: app },
      ),
    ).rejects.toThrow(/Foreign key constraint/i);
  });

  it("with no tenant set, every success table reads 0 rows", async () => {
    const counts = await app.$transaction(async (tx) => {
      const out: number[] = [];
      for (const t of SUCCESS_TABLES) {
        const [row] = await tx.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM "${t}"`);
        out.push(Number(row!.n));
      }
      return out;
    });
    expect(counts).toEqual(SUCCESS_TABLES.map(() => 0));
  });

  it("positive control: the full chain can be built by the app role inside tenant A (rolled back)", async () => {
    await expect(
      withTenant(
        TENANT_A,
        async (tx) => {
          const ids = await buildChain(tx, TENANT_A);
          expect(Object.keys(ids).sort()).toEqual([...SUCCESS_TABLES].sort());
          throw new Rollback();
        },
        { client: app },
      ),
    ).rejects.toBeInstanceOf(Rollback);
    expect(await owner.alertRule.count({ where: { tenantId: TENANT_A, key: PROBE_RULE_KEY } })).toBe(0);
  });
});

describe("success engine: integrity rules", () => {
  it("rejects a risk score outside 0–100", async () => {
    const student = await owner.person.findFirstOrThrow({ where: { tenantId: TENANT_A, externalRef: "S-001" } });
    const config = await owner.riskModelConfig.findFirstOrThrow({ where: { tenantId: TENANT_A, isActive: true } });
    await expect(
      withTenant(
        TENANT_A,
        (tx) =>
          tx.riskScore.create({
            data: { tenantId: TENANT_A, studentPersonId: student.id, modelConfigId: config.id, modelVersion: 1, score: "100.50", band: "critical" },
          }),
        { client: app },
      ),
    ).rejects.toThrow(/risk_score_score_check/);
  });

  it("allows only one active risk model config per tenant", async () => {
    await expect(
      withTenant(
        TENANT_A,
        (tx) => tx.riskModelConfig.create({ data: { tenantId: TENANT_A, version: 2, weights: {}, bandThresholds: {}, isActive: true } }),
        { client: app },
      ),
    ).rejects.toThrow(/Unique constraint/i);
  });

  it("allows one nudge per goal per week, and week_start must be a Monday", async () => {
    const student = await owner.person.findFirstOrThrow({ where: { tenantId: TENANT_B, externalRef: "S-001" } });
    await expect(
      withTenant(
        TENANT_B,
        (tx) =>
          tx.nudge.create({
            data: { tenantId: TENANT_B, goalId: probe.goal, recipientPersonId: student.id, weekStart: monday, scheduledFor: monday },
          }),
        { client: app },
      ),
    ).rejects.toThrow(/Unique constraint/i);
    await expect(
      withTenant(
        TENANT_B,
        (tx) =>
          tx.nudge.create({
            data: { tenantId: TENANT_B, goalId: probe.goal, recipientPersonId: student.id, weekStart: new Date("2026-11-04"), scheduledFor: monday },
          }),
        { client: app },
      ),
    ).rejects.toThrow(/nudge_week_start_monday/);
  });
});
