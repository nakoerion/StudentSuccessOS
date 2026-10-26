/**
 * Academic-year setup wizard (service layer, slice 2 of the academic record).
 *
 * Given a tenant and its country pack, builds one full academic year:
 *   academic_year → term → subject → course → class_section → enrollment
 *   → teacher_assignment → assessment_category
 *
 * Two halves:
 *   - `planAcademicYear` is PURE: pack + roster in, a plan of natural-keyed rows out.
 *     No ids, no I/O — unit-testable without a database.
 *   - `runSetupWizard` loads the tenant's roster, plans, and applies the plan with
 *     insert-if-missing semantics (unique constraints + ON CONFLICT DO NOTHING), so
 *     running it twice never duplicates rows and never clobbers edits a school made.
 *
 * Writes need the owner role (ssos_owner, BYPASSRLS): every query here filters by
 * tenant_id explicitly. The wizard never writes derived tables (term_grade,
 * annual_grade) and emits no `event` rows (the event-per-mutation invariant is a
 * later slice, and re-runs must not grow the append-only timeline).
 *
 * Country differences come ONLY from pack data (calendar, terms, grades, scales,
 * optional subjects / default categories). No code here branches on country.
 * Where a pack has no data yet, the wizard falls back to clearly-marked,
 * country-neutral placeholders (see PLACEHOLDER_* below) and reports them.
 */
import type { CountryPack, Locale } from "@ssos/country-packs";
import { getCountryPack, isCountryCode, isLocale, packDefaultLocale } from "@ssos/country-packs";
import type { Prisma, PrismaClient } from "@prisma/client";

type Db = Prisma.TransactionClient;
type Names = Record<Locale, string>;

// ─── Placeholders (used only when the pack has no data) ──────────────────────

/**
 * PLACEHOLDER: a pack calendar with no formal terms (e.g. AL 2026-2027) is split
 * into this many equal "Period" terms. Real term data belongs in the pack.
 */
export const PLACEHOLDER_TERM_COUNT = 2;
const PERIOD_NAME: Names = { sq: "Periudha {n}", en: "Period {n}", ar: "الفترة {n}" };

/**
 * PLACEHOLDER: generic secondary-school subject catalog used when the pack has
 * no `subjects`. Tenant-defined (pack_code / pack_key NULL), country-neutral.
 */
export const PLACEHOLDER_SUBJECTS: readonly { code: string; names: Names }[] = [
  { code: "MATH", names: { sq: "Matematikë", en: "Mathematics", ar: "الرياضيات" } },
  { code: "LANG", names: { sq: "Gjuhë dhe letërsi", en: "Language and Literature", ar: "اللغة والأدب" } },
  { code: "ENG", names: { sq: "Gjuhë angleze", en: "English", ar: "اللغة الإنجليزية" } },
  { code: "PHYS", names: { sq: "Fizikë", en: "Physics", ar: "الفيزياء" } },
  { code: "CHEM", names: { sq: "Kimi", en: "Chemistry", ar: "الكيمياء" } },
  { code: "BIO", names: { sq: "Biologji", en: "Biology", ar: "الأحياء" } },
  { code: "HIST", names: { sq: "Histori", en: "History", ar: "التاريخ" } },
  { code: "PE", names: { sq: "Edukim fizik", en: "Physical Education", ar: "التربية البدنية" } },
];

/**
 * PLACEHOLDER: weighted categories used when the course's pack grading scale has
 * no `defaultCategories`. Weights sum to 100.
 */
export const PLACEHOLDER_CATEGORIES: readonly { key: string; names: Names; weight: number }[] = [
  { key: "coursework", names: { sq: "Vlerësim i vazhduar", en: "Coursework", ar: "الأعمال الصفية" }, weight: 40 },
  { key: "tests", names: { sq: "Teste", en: "Tests", ar: "الاختبارات" }, weight: 30 },
  { key: "final", names: { sq: "Vlerësim përfundimtar", en: "Final assessment", ar: "التقييم النهائي" }, weight: 30 },
];

// ─── Plan (pure) ─────────────────────────────────────────────────────────────

export interface PlanUnit {
  id: string;
  code: string;
  name: string;
  gradeLevel: number | null;
}
export interface PlanInput {
  pack: CountryPack;
  /** Locale used for generated names (tenant default locale). */
  locale: Locale;
  /** Academic year name from the pack calendar, e.g. "2026-2027". Default: the pack's first calendar. */
  academicYear?: string;
  /** Homeroom / class units; one section per unit per course. */
  units: readonly PlanUnit[];
  students: readonly { personId: string; unitId: string }[];
  /** Teachers in a stable order (the plan round-robins subjects over them). */
  teachers: readonly { personId: string }[];
}

export type Placeholder = "terms" | "subjects" | "assessment_categories";

export interface AcademicYearPlan {
  academicYear: { name: string; startsOn: string; endsOn: string };
  terms: { key: string; name: string; sequence: number; startsOn: string; endsOn: string }[];
  subjects: { code: string; name: string; packCode: string | null; packKey: string | null }[];
  courses: { code: string; name: string; subjectCode: string; grade: string; gradeScaleKey: string | null }[];
  sections: { courseCode: string; code: string; name: string; unitId: string }[];
  enrollments: { courseCode: string; sectionCode: string; studentPersonId: string }[];
  teacherAssignments: { courseCode: string; sectionCode: string; teacherPersonId: string }[];
  categories: { courseCode: string; name: string; weight: number }[];
  /** Which parts fell back to placeholder data because the pack has none yet. */
  placeholders: Placeholder[];
  /** Units skipped because their grade level is not a grade in the pack. */
  skippedUnits: string[];
}

const DAY_MS = 86_400_000;
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const parseDay = (iso: string) => Date.parse(`${iso}T00:00:00Z`);

/** Split [start, end] into `n` contiguous, non-overlapping date ranges. */
export function splitIntoPeriods(start: string, end: string, n: number): { startsOn: string; endsOn: string }[] {
  const from = parseDay(start);
  const span = Math.round((parseDay(end) - from) / DAY_MS) + 1;
  return Array.from({ length: n }, (_, i) => ({
    startsOn: isoDay(from + Math.floor((span * i) / n) * DAY_MS),
    endsOn: isoDay(from + (Math.floor((span * (i + 1)) / n) - 1) * DAY_MS),
  }));
}

export function planAcademicYear(input: PlanInput): AcademicYearPlan {
  const { pack, locale } = input;
  const placeholders: Placeholder[] = [];
  const cal = input.academicYear
    ? pack.examCalendars.find((c) => c.academicYear === input.academicYear)
    : pack.examCalendars[0];
  if (!cal) throw new Error(`country pack ${pack.code} has no calendar for ${input.academicYear ?? "(first)"}`);
  // Pack-authored names are in the pack's primary language; otherwise use the English name.
  const packName = (x: { name: string; nameEn: string }) => (locale === packDefaultLocale(pack) ? x.name : x.nameEn);

  // Terms: from the pack calendar, else PLACEHOLDER equal "Period" split.
  let terms: AcademicYearPlan["terms"];
  if (cal.terms.length > 0) {
    terms = cal.terms.map((t, i) => ({ key: t.key, name: t.name, sequence: i + 1, startsOn: t.start, endsOn: t.end }));
  } else {
    placeholders.push("terms");
    terms = splitIntoPeriods(cal.start, cal.end, PLACEHOLDER_TERM_COUNT).map((r, i) => ({
      key: `period-${i + 1}`,
      name: PERIOD_NAME[locale].replace("{n}", String(i + 1)),
      sequence: i + 1,
      ...r,
    }));
  }

  // Subjects: from the pack, else PLACEHOLDER catalog (tenant-defined).
  const packSubjects = pack.subjects ?? [];
  const subjectDefs: { code: string; name: string; packCode: string | null; packKey: string | null; grades?: string[] }[] =
    packSubjects.length > 0
      ? packSubjects.map((s) => ({ code: s.code, name: packName(s), packCode: pack.code, packKey: s.key, grades: s.grades }))
      : PLACEHOLDER_SUBJECTS.map((s) => ({ code: s.code, name: s.names[locale], packCode: null, packKey: null }));
  if (packSubjects.length === 0) placeholders.push("subjects");

  // Grades the school offers = grade levels of its class units that exist in the pack.
  const packGrades = new Set(pack.grades.flatMap((s) => s.grades));
  const skippedUnits: string[] = [];
  const unitsByGrade = new Map<string, PlanUnit[]>();
  for (const u of [...input.units].sort((a, b) => a.code.localeCompare(b.code))) {
    const grade = u.gradeLevel === null ? null : String(u.gradeLevel);
    if (grade === null || !packGrades.has(grade)) {
      skippedUnits.push(u.code);
      continue;
    }
    unitsByGrade.set(grade, [...(unitsByGrade.get(grade) ?? []), u]);
  }
  const grades = [...unitsByGrade.keys()].sort((a, b) => Number(a) - Number(b));

  const studentsByUnit = new Map<string, string[]>();
  for (const s of input.students) studentsByUnit.set(s.unitId, [...(studentsByUnit.get(s.unitId) ?? []), s.personId]);
  for (const list of studentsByUnit.values()) list.sort();

  const plan: AcademicYearPlan = {
    academicYear: { name: cal.academicYear, startsOn: cal.start, endsOn: cal.end },
    terms,
    subjects: subjectDefs.map(({ code, name, packCode, packKey }) => ({ code, name, packCode, packKey })),
    courses: [],
    sections: [],
    enrollments: [],
    teacherAssignments: [],
    categories: [],
    placeholders,
    skippedUnits,
  };

  let usedPlaceholderCategories = false;
  subjectDefs.forEach((subject, subjectIndex) => {
    // Round-robin: each subject has one teacher across all its sections.
    const teacher = input.teachers.length > 0 ? input.teachers[subjectIndex % input.teachers.length]! : null;
    for (const grade of grades) {
      if (subject.grades && !subject.grades.includes(grade)) continue;
      const courseCode = `${subject.code}-${grade}`;
      const scale = pack.gradingScales.find((s) => s.appliesToGrades.includes(grade)) ?? null;
      plan.courses.push({
        code: courseCode,
        name: `${subject.name} ${grade}`,
        subjectCode: subject.code,
        grade,
        gradeScaleKey: scale?.key ?? null,
      });

      const cats = scale?.defaultCategories?.length
        ? scale.defaultCategories.map((c) => ({ name: packName(c), weight: c.weight }))
        : PLACEHOLDER_CATEGORIES.map((c) => ({ name: c.names[locale], weight: c.weight }));
      if (!scale?.defaultCategories?.length) usedPlaceholderCategories = true;
      for (const c of cats) plan.categories.push({ courseCode, ...c });

      for (const unit of unitsByGrade.get(grade)!) {
        plan.sections.push({ courseCode, code: unit.code, name: `${subject.name} — ${unit.name}`, unitId: unit.id });
        for (const studentPersonId of studentsByUnit.get(unit.id) ?? []) {
          plan.enrollments.push({ courseCode, sectionCode: unit.code, studentPersonId });
        }
        if (teacher) plan.teacherAssignments.push({ courseCode, sectionCode: unit.code, teacherPersonId: teacher.personId });
      }
    }
  });
  if (usedPlaceholderCategories) placeholders.push("assessment_categories");
  return plan;
}

// ─── Apply (database) ────────────────────────────────────────────────────────

export interface SetupWizardOptions {
  tenantId: string;
  /** Override the tenant's pack (tests). Default: resolved from tenant.country_pack. */
  pack?: CountryPack;
  academicYear?: string;
  /**
   * Optional id factory for new rows (the seed passes a deterministic one so ids
   * are stable across re-seeds). Default: Postgres gen_random_uuid().
   */
  newId?: (table: string, ...naturalKey: string[]) => string;
}

export const WIZARD_TABLES = [
  "academicYear",
  "term",
  "subject",
  "course",
  "classSection",
  "enrollment",
  "teacherAssignment",
  "assessmentCategory",
] as const;
export type WizardTable = (typeof WIZARD_TABLES)[number];

export interface SetupWizardResult {
  tenantId: string;
  packCode: string;
  academicYearId: string;
  academicYearName: string;
  /** Rows inserted by this run (0 everywhere on an idempotent re-run). */
  created: Record<WizardTable, number>;
  /** Rows in this tenant for the wizard's year (subjects: whole tenant) after the run. */
  totals: Record<WizardTable, number>;
  placeholders: Placeholder[];
  skippedUnits: string[];
}

const day = (iso: string) => new Date(`${iso}T00:00:00Z`);

/** Roster + pack for a tenant, read with the owner client (explicit tenant filters). */
async function loadPlanInput(db: Db, opts: SetupWizardOptions): Promise<{ input: PlanInput; countryPackId: string }> {
  const { tenantId } = opts;
  const tenant = await db.tenant.findUniqueOrThrow({ where: { id: tenantId }, include: { countryPack: true } });
  const code = tenant.countryPack.code;
  if (!opts.pack && !isCountryCode(code)) throw new Error(`tenant ${tenantId} has unknown country pack "${code}"`);
  const pack = opts.pack ?? getCountryPack(code as Parameters<typeof getCountryPack>[0]);
  const locale: Locale =
    isLocale(tenant.defaultLocale) && pack.supportedLocales.includes(tenant.defaultLocale)
      ? tenant.defaultLocale
      : packDefaultLocale(pack);

  const units = await db.tenantUnit.findMany({
    where: { tenantId, kind: "class" },
    select: { id: true, code: true, name: true, gradeLevel: true },
    orderBy: { code: "asc" },
  });
  const roleRows = (key: string) =>
    db.roleAssignment.findMany({
      where: { tenantId, status: "active", role: { key, tenantId: null } },
      select: { personId: true, tenantUnitId: true, person: { select: { externalRef: true } } },
    });
  const students = (await roleRows("student"))
    .filter((r) => r.tenantUnitId !== null)
    .map((r) => ({ personId: r.personId, unitId: r.tenantUnitId! }));
  const teacherRows = await roleRows("teacher");
  const teachers = [...new Map(teacherRows.map((r) => [r.personId, r])).values()]
    .sort((a, b) => (a.person.externalRef ?? a.personId).localeCompare(b.person.externalRef ?? b.personId))
    .map((r) => ({ personId: r.personId }));

  return {
    input: { pack, locale, academicYear: opts.academicYear, units, students, teachers },
    countryPackId: tenant.countryPackId,
  };
}

async function applyPlan(
  db: Db,
  opts: SetupWizardOptions,
  plan: AcademicYearPlan,
  countryPackId: string,
): Promise<Omit<SetupWizardResult, "packCode" | "placeholders" | "skippedUnits">> {
  const { tenantId } = opts;
  const id = (table: string, ...key: string[]) => (opts.newId ? { id: opts.newId(table, ...key) } : {});
  const created = Object.fromEntries(WIZARD_TABLES.map((t) => [t, 0])) as Record<WizardTable, number>;

  // 1. academic_year (unique tenant + name). Existing rows are left as the school edited them.
  const y = plan.academicYear;
  let year = await db.academicYear.findUnique({ where: { tenantId_name: { tenantId, name: y.name } } });
  if (!year) {
    const hasCurrent = (await db.academicYear.count({ where: { tenantId, isCurrent: true } })) > 0;
    const r = await db.academicYear.createMany({
      data: [{ ...id("academic_year", y.name), tenantId, name: y.name, startsOn: day(y.startsOn), endsOn: day(y.endsOn), isCurrent: !hasCurrent }],
      skipDuplicates: true,
    });
    created.academicYear = r.count;
    year = await db.academicYear.findUniqueOrThrow({ where: { tenantId_name: { tenantId, name: y.name } } });
  }
  const academicYearId = year.id;

  // 2. term (unique tenant + year + key, and tenant + year + sequence).
  created.term = (
    await db.term.createMany({
      data: plan.terms.map((t) => ({
        ...id("term", y.name, t.key),
        tenantId,
        academicYearId,
        key: t.key,
        name: t.name,
        sequence: t.sequence,
        startsOn: day(t.startsOn),
        endsOn: day(t.endsOn),
      })),
      skipDuplicates: true,
    })
  ).count;

  // 3. subject (unique tenant + code) — tenant-wide, shared across years.
  created.subject = (
    await db.subject.createMany({
      data: plan.subjects.map((s) => ({ ...id("subject", s.code), tenantId, ...s })),
      skipDuplicates: true,
    })
  ).count;
  const subjectIds = new Map(
    (
      await db.subject.findMany({
        where: { tenantId, code: { in: plan.subjects.map((s) => s.code) } },
        select: { id: true, code: true },
      })
    ).map((s) => [s.code, s.id]),
  );

  // Grade scales: a tenant override with the same key wins over the pack default.
  const scales = await db.gradeScale.findMany({
    where: { countryPackId, OR: [{ tenantId: null }, { tenantId }] },
    select: { id: true, key: true, tenantId: true },
    orderBy: { tenantId: { sort: "asc", nulls: "first" } },
  });
  const scaleIds = new Map(scales.map((s) => [s.key, s.id])); // later (tenant) rows overwrite earlier (global)

  // 4. course (unique tenant + year + code).
  created.course = (
    await db.course.createMany({
      data: plan.courses.map((c) => ({
        ...id("course", y.name, c.code),
        tenantId,
        academicYearId,
        subjectId: subjectIds.get(c.subjectCode)!,
        code: c.code,
        name: c.name,
        grade: c.grade,
        gradeScaleId: c.gradeScaleKey ? (scaleIds.get(c.gradeScaleKey) ?? null) : null,
      })),
      skipDuplicates: true,
    })
  ).count;
  const courseIds = new Map(
    (await db.course.findMany({ where: { tenantId, academicYearId }, select: { id: true, code: true } })).map((c) => [
      c.code,
      c.id,
    ]),
  );
  const courseId = (code: string) => {
    const v = courseIds.get(code);
    if (!v) throw new Error(`setup wizard: course ${code} missing after insert`);
    return v;
  };

  // 5. class_section (unique tenant + course + code).
  created.classSection = (
    await db.classSection.createMany({
      data: plan.sections.map((s) => ({
        ...id("class_section", y.name, s.courseCode, s.code),
        tenantId,
        courseId: courseId(s.courseCode),
        tenantUnitId: s.unitId,
        code: s.code,
        name: s.name,
      })),
      skipDuplicates: true,
    })
  ).count;
  const sections = await db.classSection.findMany({
    where: { tenantId, course: { academicYearId } },
    select: { id: true, code: true, courseId: true },
  });
  const sectionIds = new Map(sections.map((s) => [`${s.courseId}|${s.code}`, s.id]));
  const sectionId = (courseCode: string, code: string) => {
    const v = sectionIds.get(`${courseId(courseCode)}|${code}`);
    if (!v) throw new Error(`setup wizard: section ${courseCode}/${code} missing after insert`);
    return v;
  };

  // 6. enrollment (unique tenant + section + student).
  created.enrollment = (
    await db.enrollment.createMany({
      data: plan.enrollments.map((e) => ({
        ...id("enrollment", y.name, e.courseCode, e.sectionCode, e.studentPersonId),
        tenantId,
        classSectionId: sectionId(e.courseCode, e.sectionCode),
        studentPersonId: e.studentPersonId,
        status: "active",
        startsOn: day(y.startsOn),
      })),
      skipDuplicates: true,
    })
  ).count;

  // 7. teacher_assignment (unique tenant + teacher + course + section; section is always set,
  //    so the unique index is effective — NULLs would be distinct).
  created.teacherAssignment = (
    await db.teacherAssignment.createMany({
      data: plan.teacherAssignments.map((t) => ({
        ...id("teacher_assignment", y.name, t.courseCode, t.sectionCode, t.teacherPersonId),
        tenantId,
        teacherPersonId: t.teacherPersonId,
        courseId: courseId(t.courseCode),
        classSectionId: sectionId(t.courseCode, t.sectionCode),
        role: "primary",
      })),
      skipDuplicates: true,
    })
  ).count;

  // 8. assessment_category (unique tenant + course + name).
  created.assessmentCategory = (
    await db.assessmentCategory.createMany({
      data: plan.categories.map((c) => ({
        ...id("assessment_category", y.name, c.courseCode, c.name),
        tenantId,
        courseId: courseId(c.courseCode),
        name: c.name,
        weight: c.weight,
      })),
      skipDuplicates: true,
    })
  ).count;

  const inYear = { tenantId, academicYearId };
  const inYearCourse = { tenantId, course: { academicYearId } };
  const totals: Record<WizardTable, number> = {
    academicYear: 1,
    term: await db.term.count({ where: inYear }),
    subject: await db.subject.count({ where: { tenantId } }),
    course: await db.course.count({ where: inYear }),
    classSection: await db.classSection.count({ where: inYearCourse }),
    enrollment: await db.enrollment.count({ where: { tenantId, classSection: { course: { academicYearId } } } }),
    teacherAssignment: await db.teacherAssignment.count({ where: inYearCourse }),
    assessmentCategory: await db.assessmentCategory.count({ where: inYearCourse }),
  };
  return { tenantId, academicYearId, academicYearName: y.name, created, totals };
}

/**
 * Create (or complete) a full academic year for a tenant. Idempotent.
 *
 * `db` must be an OWNER-role client or transaction (seed, admin scripts). Given a
 * PrismaClient the whole run is wrapped in one transaction.
 */
export async function runSetupWizard(db: PrismaClient | Db, opts: SetupWizardOptions): Promise<SetupWizardResult> {
  const run = async (tx: Db): Promise<SetupWizardResult> => {
    const { input, countryPackId } = await loadPlanInput(tx, opts);
    const plan = planAcademicYear(input);
    const applied = await applyPlan(tx, opts, plan, countryPackId);
    return { ...applied, packCode: input.pack.code, placeholders: plan.placeholders, skippedUnits: plan.skippedUnits };
  };
  // An interactive-transaction client has no $transaction; a full client does.
  if (typeof (db as Partial<PrismaClient>).$transaction === "function")
    return (db as PrismaClient).$transaction(run, { timeout: 120_000 });
  return run(db);
}
