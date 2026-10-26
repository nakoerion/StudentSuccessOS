/**
 * Deterministic, re-runnable seed. Runs as the owner role (DATABASE_ADMIN_URL,
 * BYPASSRLS). Global rows are upserted; each demo tenant is deleted (cascade)
 * and rebuilt with stable UUIDs, so ids are identical on every run.
 *
 *   pnpm db:seed
 */
import { getCountryPack, packDefaultLocale } from "@ssos/country-packs";
import type { Prisma, PrismaClient } from "@prisma/client";

import { createAdminClient } from "../src/client";
import { PERMISSIONS, ROLE_PERMISSIONS, SYSTEM_ROLES, type SystemRoleKey } from "../src/system-roles";
import { runSetupWizard } from "../src/setup-wizard";
import { seedConcepts } from "./academic";
import { pick, prng, seedId, seedToken } from "./deterministic";
import { COUNTS, DEMO_EMAIL_DOMAIN, NO_ROLE_EMAIL, TENANTS, type TenantFixture } from "./fixtures";
import type { NamePool } from "./names";

type Tx = Prisma.TransactionClient;
type Gender = "male" | "female";

const INVITATION_EXPIRES_AT = new Date("2027-06-30T23:59:59Z");

async function seedGlobals(tx: Tx): Promise<Record<SystemRoleKey, string>> {
  const packCodes = [...new Set(TENANTS.map((t) => t.countryCode))];
  for (const code of packCodes) {
    const pack = getCountryPack(code);
    const id = seedId("country_pack", code);
    const data = pack as unknown as Prisma.InputJsonValue;
    await tx.countryPack.upsert({
      where: { code },
      create: { id, code, name: pack.name, version: pack.version, data },
      update: { name: pack.name, version: pack.version, data },
    });
    const packRow = await tx.countryPack.findUniqueOrThrow({ where: { code } });
    await seedConcepts(tx, packRow.id, code);
    // Drop pack-default scales the pack no longer defines (tenant overrides are untouched).
    await tx.gradeScale.deleteMany({
      where: { countryPackId: packRow.id, tenantId: null, key: { notIn: pack.gradingScales.map((s) => s.key) } },
    });
    for (const scale of pack.gradingScales) {
      const existing = await tx.gradeScale.findFirst({
        where: { countryPackId: packRow.id, tenantId: null, key: scale.key },
      });
      const values = {
        name: scale.name,
        kind: scale.kind,
        minValue: scale.min,
        maxValue: scale.max,
        passMark: scale.passMark,
        bands: scale.bands as unknown as Prisma.InputJsonValue,
      };
      if (existing) await tx.gradeScale.update({ where: { id: existing.id }, data: values });
      else
        await tx.gradeScale.create({
          data: { id: seedId("grade_scale", code, scale.key), countryPackId: packRow.id, key: scale.key, ...values },
        });
    }
  }

  const permissionIds: Record<string, string> = {};
  for (const p of PERMISSIONS) {
    const row = await tx.permission.upsert({
      where: { key: p.key },
      create: { id: seedId("permission", p.key), key: p.key, description: p.description },
      update: { description: p.description },
    });
    permissionIds[p.key] = row.id;
  }

  const roleIds = {} as Record<SystemRoleKey, string>;
  for (const r of SYSTEM_ROLES) {
    const existing = await tx.role.findFirst({ where: { tenantId: null, key: r.key } });
    const row = existing
      ? await tx.role.update({ where: { id: existing.id }, data: { name: r.name, isSystem: true } })
      : await tx.role.create({ data: { id: seedId("role", r.key), key: r.key, name: r.name, isSystem: true } });
    roleIds[r.key] = row.id;
    for (const permKey of ROLE_PERMISSIONS[r.key]) {
      const permissionId = permissionIds[permKey]!;
      await tx.rolePermission.upsert({
        where: { roleId_permissionId: { roleId: row.id, permissionId } },
        create: { id: seedId("role_permission", r.key, permKey), roleId: row.id, permissionId },
        update: {},
      });
    }
  }
  return roleIds;
}

interface PersonRow {
  id: string;
  tenantId: string;
  givenName: string;
  familyName: string;
  displayName: string;
  dateOfBirth: Date | null;
  locale: string;
  externalRef: string;
}

function weightedPool(rand: () => number, pools: readonly NamePool[]): NamePool {
  const total = pools.reduce((s, p) => s + p.weight, 0);
  let r = rand() * total;
  for (const p of pools) {
    r -= p.weight;
    if (r < 0) return p;
  }
  return pools[pools.length - 1]!;
}

function dob(rand: () => number, ageYears: number): Date {
  const year = 2026 - ageYears;
  const month = Math.floor(rand() * 12);
  const day = 1 + Math.floor(rand() * 28);
  return new Date(Date.UTC(year, month, day));
}

async function seedTenant(
  tx: Tx,
  f: TenantFixture,
  roleIds: Record<SystemRoleKey, string>,
) {
  const rand = prng(f.slug);
  const tenantId = seedId("tenant", f.slug);
  const pack = await tx.countryPack.findUniqueOrThrow({ where: { code: f.countryCode } });
  const packData = getCountryPack(f.countryCode);

  // Rebuild from scratch: cascades to every tenant-owned table.
  await tx.tenant.deleteMany({ where: { OR: [{ id: tenantId }, { slug: f.slug }] } });
  await tx.tenant.create({
    data: {
      id: tenantId,
      slug: f.slug,
      name: f.name,
      countryPackId: pack.id,
      // Locale and timezone come from the country pack, never from the fixture.
      defaultLocale: packDefaultLocale(packData),
      timezone: packData.defaultTimezone,
      joinCode: f.joinCode,
    },
  });

  await tx.tenantSetting.createMany({
    data: [
      { id: seedId(f.slug, "setting", "grading_scale"), tenantId, key: "grading_scale", value: packData.gradingScales[0]?.key ?? "" },
      { id: seedId(f.slug, "setting", "supported_locales"), tenantId, key: "supported_locales", value: packData.supportedLocales },
    ],
  });

  const units = f.classes.map((c) => ({
    id: seedId(f.slug, "unit", c.code),
    tenantId,
    kind: "class",
    name: c.name,
    code: c.code,
    gradeLevel: c.gradeLevel,
  }));
  await tx.tenantUnit.createMany({ data: units });

  const persons: PersonRow[] = [];
  const assignments: Prisma.RoleAssignmentCreateManyInput[] = [];
  const guardianships: Prisma.GuardianshipCreateManyInput[] = [];
  const consents: Prisma.ConsentCreateManyInput[] = [];

  const makePerson = (
    ref: string,
    pool: NamePool,
    gender: Gender,
    familyName: string,
    ageYears: number | null,
  ): PersonRow => {
    const givenName = pick(rand, pool[gender]);
    const p: PersonRow = {
      id: seedId(f.slug, "person", ref),
      tenantId,
      givenName,
      familyName,
      displayName: `${givenName} ${familyName}`,
      dateOfBirth: ageYears === null ? null : dob(rand, ageYears),
      locale: pool.locale,
      externalRef: ref,
    };
    persons.push(p);
    return p;
  };
  const assign = (person: PersonRow, role: SystemRoleKey, unitId: string | null = null) => {
    assignments.push({
      id: seedId(f.slug, "role_assignment", person.externalRef, role),
      tenantId,
      personId: person.id,
      roleId: roleIds[role],
      tenantUnitId: unitId,
    });
  };

  // Parents: one family each. Parents 1–10 have two children, 11–20 have one.
  const families: { parent: PersonRow; pool: NamePool; gender: Gender; kids: number }[] = [];
  for (let i = 0; i < COUNTS.parents; i++) {
    const pool = weightedPool(rand, f.pools);
    const familyName = pick(rand, pool.family);
    const gender: Gender = i % 2 === 0 ? "female" : "male";
    const parent = makePerson(`P-${String(i + 1).padStart(3, "0")}`, pool, gender, familyName, 38 + Math.floor(rand() * 12));
    assign(parent, "parent");
    families.push({ parent, pool, gender, kids: i < COUNTS.students - COUNTS.parents ? 2 : 1 });
  }

  // Students: take the family name of their parent, 10 per class.
  let s = 0;
  for (const fam of families) {
    for (let k = 0; k < fam.kids; k++, s++) {
      const unit = units[s % units.length]!;
      const gender: Gender = rand() < 0.5 ? "female" : "male";
      const student = makePerson(
        `S-${String(s + 1).padStart(3, "0")}`,
        fam.pool,
        gender,
        fam.parent.familyName,
        unit.gradeLevel + 6,
      );
      assign(student, "student", unit.id);
      guardianships.push({
        id: seedId(f.slug, "guardianship", fam.parent.externalRef, student.externalRef),
        tenantId,
        guardianPersonId: fam.parent.id,
        studentPersonId: student.id,
        relationship: fam.gender === "female" ? "mother" : "father",
        isPrimary: true,
      });
      consents.push({
        id: seedId(f.slug, "consent", student.externalRef, "data_processing"),
        tenantId,
        subjectPersonId: student.id,
        grantedByPersonId: fam.parent.id,
        purpose: "data_processing",
        grantedAt: new Date("2026-09-01T08:00:00Z"),
      });
    }
  }
  if (s !== COUNTS.students) throw new Error(`expected ${COUNTS.students} students, built ${s}`);

  const staff = (prefix: string, n: number, role: SystemRoleKey, withUnit: boolean): PersonRow[] =>
    Array.from({ length: n }, (_, i) => {
      const pool = weightedPool(rand, f.pools);
      const p = makePerson(
        `${prefix}-${String(i + 1).padStart(3, "0")}`,
        pool,
        rand() < 0.5 ? "female" : "male",
        pick(rand, pool.family),
        null,
      );
      assign(p, role, withUnit ? units[i % units.length]!.id : null);
      return p;
    });
  const teachers = staff("T", COUNTS.teachers, "teacher", true);
  staff("ADV", COUNTS.advisors, "advisor", false);
  const [admin] = staff("ADM", COUNTS.admins, "admin", false);

  await tx.person.createMany({ data: persons });
  await tx.roleAssignment.createMany({ data: assignments });
  await tx.guardianship.createMany({ data: guardianships });
  await tx.consent.createMany({ data: consents });

  // Demo logins: link user accounts (global) to persons in this tenant.
  const demo: [string, PersonRow][] = [
    ["admin", admin!],
    ["teacher", teachers[0]!],
    ["parent", families[0]!.parent],
  ];
  for (const [kind, person] of demo) {
    const email = `${kind}.${f.emailTag}@${DEMO_EMAIL_DOMAIN}`;
    const account = await tx.userAccount.upsert({
      where: { email },
      create: {
        id: seedId("user_account", email),
        email,
        displayName: person.displayName,
        locale: packDefaultLocale(packData),
      },
      // external_auth_id is NOT touched: the Supabase link survives re-seeding.
      update: { displayName: person.displayName, locale: packDefaultLocale(packData) },
    });
    await tx.person.update({ where: { id: person.id }, data: { userAccountId: account.id } });
  }

  await tx.invitation.create({
    data: {
      id: seedId(f.slug, "invitation", f.invitation.code),
      tenantId,
      token: seedToken(f.slug, f.invitation.code),
      code: f.invitation.code,
      email: f.invitation.email,
      roleId: roleIds[f.invitation.roleKey],
      tenantUnitId: units[0]!.id,
      invitedByPersonId: admin!.id,
      expiresAt: INVITATION_EXPIRES_AT,
    },
  });

  // Full academic year from the pack via the setup wizard (deterministic ids for stable re-seeds).
  const academic = await runSetupWizard(tx, {
    tenantId,
    pack: packData,
    newId: (table, ...key) => seedId(f.slug, table, ...key),
  });

  await tx.auditLog.create({
    data: {
      id: seedId(f.slug, "audit", "seed"),
      tenantId,
      actorPersonId: null,
      action: "tenant.seeded",
      entityType: "tenant",
      entityId: tenantId,
      data: { persons: persons.length },
    },
  });

  return {
    tenantId,
    persons: persons.length,
    assignments: assignments.length,
    guardianships: guardianships.length,
    academic,
  };
}

export async function seed(client: PrismaClient): Promise<void> {
  // Passwords live in Supabase Auth: run `pnpm auth:seed` after this to create
  // the demo logins there and link user_account.external_auth_id.
  await client.$transaction(
    async (tx) => {
      const roleIds = await seedGlobals(tx);
      for (const f of TENANTS) {
        const r = await seedTenant(tx, f, roleIds);
        console.info(
          `Seeded ${f.name} (${r.tenantId}): ${r.persons} persons, ${r.assignments} role assignments, ${r.guardianships} guardianships, ` +
            `academic year ${r.academic.academicYearName}: ${JSON.stringify(r.academic.totals)}` +
            (r.academic.placeholders.length ? ` (placeholder data: ${r.academic.placeholders.join(", ")})` : ""),
        );
      }
      await tx.userAccount.upsert({
        where: { email: NO_ROLE_EMAIL },
        create: {
          id: seedId("user_account", NO_ROLE_EMAIL),
          email: NO_ROLE_EMAIL,
          displayName: "New User",
          locale: "en",
        },
        update: {},
      });
    },
    { timeout: 120_000 },
  );
}

const client = createAdminClient();
seed(client)
  .then(() => console.info("Seed complete."))
  .catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => client.$disconnect());
