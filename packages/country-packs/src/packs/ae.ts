import type { CountryPackInput } from "../types";

/**
 * United Arab Emirates — Ministry of Education (MOE) national system.
 * Researched 2026-10-21; every fact cites `sources` by id. Private schools on
 * other curricula (British, American, IB, Indian…) use their own scales and
 * calendars; a tenant overrides those through tenant-level grade scales/settings.
 */
export const AE_INPUT = {
  code: "AE",
  name: "United Arab Emirates",
  version: "1.0.0",
  researchedAt: "2026-10-21",
  supportedLocales: ["en", "ar"],
  defaultTimezone: "Asia/Dubai",

  grades: [
    {
      key: "kindergarten",
      name: "رياض الأطفال",
      nameEn: "Kindergarten",
      isced: 0,
      grades: ["KG1", "KG2"],
      ageRange: { min: 4, max: 5 },
      compulsory: false,
      sourceIds: ["ae-portal-stages"],
    },
    {
      key: "cycle-1",
      name: "الحلقة الأولى",
      nameEn: "Cycle 1",
      isced: 1,
      grades: ["1", "2", "3", "4"],
      ageRange: { min: 6, max: 9 },
      compulsory: true,
      sourceIds: ["ae-portal-stages", "ae-timss-2019", "ae-pirls-2021-abu-dhabi"],
    },
    {
      key: "cycle-2",
      name: "الحلقة الثانية",
      nameEn: "Cycle 2",
      isced: 2,
      grades: ["5", "6", "7", "8"],
      ageRange: { min: 10, max: 13 },
      compulsory: true,
      sourceIds: ["ae-timss-2019", "ae-pirls-2021-abu-dhabi"],
    },
    {
      key: "cycle-3",
      name: "الحلقة الثالثة",
      nameEn: "Cycle 3 (secondary)",
      isced: 3,
      grades: ["9", "10", "11", "12"],
      ageRange: { min: 14, max: 17 },
      // Schooling is compulsory from age 6 until grade 12 is completed or age 18, whichever comes first.
      compulsory: true,
      sourceIds: ["ae-portal-stages", "ae-timss-2019", "ae-pirls-2021-abu-dhabi"],
    },
  ],

  gradingScales: [
    {
      key: "ae-moe-percentage",
      name: "MOE percentage scale (0–100)",
      kind: "percentage",
      min: 0,
      max: 100,
      passMark: 60,
      appliesToGrades: ["9", "10", "11", "12"],
      bands: [
        { min: 60, max: 100, label: "Pass", passing: true },
        { min: 0, max: 59.99, label: "Fail", passing: false },
      ],
      notes:
        "Cycle 3 (2026-27 MOE assessment policy): subject marks are recorded out of 100 (grade 12 Group A results to two decimals) and converted to letter grades on reports; promotion requires at least 60% in every Group A subject. The letter-band cut-offs are not published in the cited sources, so only the pass/fail boundary is encoded. Cycles 1–2 are not covered by a cited source yet.",
      sourceIds: ["ae-moe-assessment-2026-27"],
    },
  ],

  examCalendars: [
    {
      academicYear: "2026-2027",
      start: "2026-08-31",
      end: "2027-07-02",
      terms: [
        { key: "term-1", name: "Term 1", start: "2026-08-31", end: "2026-12-11" },
        { key: "term-2", name: "Term 2", start: "2027-01-04", end: "2027-04-02" },
        { key: "term-3", name: "Term 3", start: "2027-04-12", end: "2027-07-02" },
      ],
      exams: [
        {
          key: "spa-term-1",
          name: "Standardised Proficiency Assessment — Term 1",
          nameEn: "Standardised Proficiency Assessment — Term 1",
          months: [10],
          window: { start: "2026-10-05", end: "2026-10-30" },
          status: "active",
          sourceIds: ["ae-calendar-2026-27-assessments"],
        },
        {
          key: "end-of-term-1",
          name: "End-of-Term 1 examinations",
          nameEn: "End-of-Term 1 examinations",
          months: [11, 12],
          window: { start: "2026-11-25" },
          status: "active",
          notes: "Centralised tests for Group A subjects at the end of terms 1 and 3 (Cycle 3).",
          sourceIds: ["ae-calendar-2026-27-assessments", "ae-moe-assessment-2026-27"],
        },
        {
          key: "spa-term-3",
          name: "Standardised Proficiency Assessment — Term 3",
          nameEn: "Standardised Proficiency Assessment — Term 3",
          months: [5, 6],
          window: { start: "2027-05-03", end: "2027-06-11" },
          status: "active",
          notes: "Window from a secondary (non-ministry) calendar summary; confirm against the MOE calendar when published.",
          sourceIds: ["ae-calendar-2026-27-term-3"],
        },
        {
          key: "end-of-term-3",
          name: "End-of-Term 3 (end-of-year) examinations",
          nameEn: "End-of-Term 3 (end-of-year) examinations",
          months: [6],
          window: { start: "2027-06-21", end: "2027-06-30" },
          status: "active",
          notes:
            "Centralised for Group A subjects (Cycle 3). Window from a secondary calendar summary; confirm against the MOE calendar.",
          sourceIds: ["ae-calendar-2026-27-term-3", "ae-moe-assessment-2026-27"],
        },
        {
          key: "emsat",
          name: "Emirates Standardised Test (EmSAT)",
          nameEn: "Emirates Standardised Test (EmSAT)",
          grades: ["12"],
          months: [],
          status: "discontinued",
          notes:
            "Cancelled for grade 12 with immediate effect on 3 November 2024 (MOE + MOHESR); university admission now uses each university's own criteria.",
          sourceIds: ["ae-emsat-cancelled"],
        },
      ],
      sourceIds: ["ae-moe-calendar-2026-2029", "ae-calendar-2026-27-terms"],
    },
  ],

  consentAges: {
    dataProcessing: {
      minAge: 13,
      basis:
        "Federal Decree-Law 26/2025 on Child Digital Safety with Federal Decree-Law 45/2021 (PDPL): personal data of children under 13 may only be collected or used with clear, withdrawable consent from a parent or guardian. Persons under 18 remain children under the law.",
      sourceIds: ["ae-child-digital-safety", "ae-cds-law-summary"],
    },
    medical: {
      minAge: 18,
      basis:
        "Federal Decree-Law 4/2016 on Medical Liability, Art. 5: a person who has completed 18 years is competent to consent unless legally incompetent; below that, consent comes from the guardian/relatives.",
      sourceIds: ["ae-medical-liability-law"],
    },
    ageOfMajority: {
      minAge: 18,
      basis: "Under Federal Decree-Law 26/2025 a child is any person under 18; FDL 4/2016 treats 18+ as competent to consent.",
      sourceIds: ["ae-cds-law-summary", "ae-medical-liability-law"],
    },
  },

  defaultLanguages: {
    primary: "en",
    secondary: ["ar"],
    notes:
      "Arabic is the language of instruction in MOE public schools and English is taught as a second language and used for some subjects. The product defaults the UI to English (private, English-medium schools) with Arabic as the secondary locale; an Arabic-medium tenant sets its own default_locale to \"ar\".",
    sourceIds: ["ae-pirls-2021-uae"],
  },

  sources: [
    {
      id: "ae-portal-stages",
      title: "Stages and streams of school education",
      publisher: "The UAE Government portal (u.ae)",
      url: "https://u.ae/en/information-and-services/education/school-education-k-12/stages-and-streams-of-school-education",
      kind: "official",
      accessed: "2026-10-21",
    },
    {
      id: "ae-timss-2019",
      title: "TIMSS 2019 Encyclopedia — United Arab Emirates (Ministry of Education chapter)",
      publisher: "TIMSS & PIRLS International Study Center, Boston College",
      url: "https://isc.bc.edu/timss2019/encyclopedia/pdf/United%20Arab%20Emirates.pdf",
      kind: "reference",
      accessed: "2026-10-21",
    },
    {
      id: "ae-pirls-2021-abu-dhabi",
      title: "PIRLS 2021 Encyclopedia — Abu Dhabi, UAE (compulsory schooling age 6 to grade 12 / 18; cycles)",
      publisher: "TIMSS & PIRLS International Study Center, Boston College",
      url: "https://pirls2021.org/wp-content/uploads/2022/10/Abu-Dhabi.pdf",
      kind: "reference",
      accessed: "2026-10-21",
    },
    {
      id: "ae-pirls-2021-uae",
      title: "PIRLS 2021 Encyclopedia — United Arab Emirates (language of instruction)",
      publisher: "TIMSS & PIRLS International Study Center, Boston College",
      url: "https://pirls2021.org/wp-content/uploads/2022/11/United-Arab-Emirates.pdf",
      kind: "reference",
      accessed: "2026-10-21",
    },
    {
      id: "ae-moe-assessment-2026-27",
      title: "UAE Ministry of Education grading system 2026-27: How secondary students are evaluated and promoted",
      publisher: "Emirates 24|7",
      url: "https://www.emirates247.com/uae/uae-ministry-of-education-grading-system-2026-27-how-secondary-students-are-evaluated-and-promoted/5175",
      kind: "news",
      accessed: "2026-10-21",
    },
    {
      id: "ae-moe-calendar-2026-2029",
      title: "Ministry of Education announces the academic calendar for the next three years",
      publisher: "UAE Ministry of Education (moe.gov.ae)",
      url: "https://moe.gov.ae/en/mediacenter/news/Pages/MOE-announces-the-academic-calendar-for-the-next-3-years.aspx",
      kind: "official",
      accessed: "2026-10-21",
    },
    {
      id: "ae-calendar-2026-27-terms",
      title: "UAE School Calendar 2026-27: Term Dates, Breaks, and How the Systems Differ",
      publisher: "UAE Inform",
      url: "https://uaeinform.com/education-guide/school-calendar",
      kind: "reference",
      accessed: "2026-10-21",
    },
    {
      id: "ae-calendar-2026-27-assessments",
      title: "UAE school calendar 2026-27: Key term dates, holidays, and breaks parents need to know",
      publisher: "Arabian Business",
      url: "https://www.arabianbusiness.com/business/education/uae-school-calendar-2027",
      kind: "news",
      accessed: "2026-10-21",
    },
    {
      id: "ae-calendar-2026-27-term-3",
      title: "UAE School Calendar 2026–2027 (term-by-term timeline)",
      publisher: "Relocate2UAE",
      url: "https://www.relocate2uae.com/uae-school-holiday-calendar-2026-2027",
      kind: "reference",
      accessed: "2026-10-21",
    },
    {
      id: "ae-emsat-cancelled",
      title: "UAE scraps standardised test for university admissions with immediate effect",
      publisher: "The National",
      url: "https://www.thenationalnews.com/news/uae/2024/11/03/uae-scraps-standardised-test-for-university-admissions-with-immediate-effect/",
      kind: "news",
      accessed: "2026-10-21",
    },
    {
      id: "ae-medical-liability-law",
      title: "Federal Decree-Law No. (4) of 2016 Concerning Medical Liability",
      publisher: "UAE Legislation (uaelegislation.gov.ae)",
      url: "https://uaelegislation.gov.ae/en/legislations/1192/download",
      kind: "legislation",
      accessed: "2026-10-21",
    },
    {
      id: "ae-child-digital-safety",
      title: "Children's digital safety (Federal Decree-Law 26/2025 and PDPL 45/2021)",
      publisher: "The UAE Government portal (u.ae)",
      url: "https://u.ae/en/information-and-services/social-affairs/Priority-groups/children/Childrens-digital-safety",
      kind: "official",
      accessed: "2026-10-21",
    },
    {
      id: "ae-cds-law-summary",
      title: "UAE's Child Digital Safety Law: What Every Digital Platform and ISP Should Know",
      publisher: "Latham & Watkins",
      url: "https://www.lw.com/en/insights/uaes-child-digital-safety-law-what-every-digital-platform-and-isp-should-know",
      kind: "reference",
      accessed: "2026-10-21",
    },
  ],
} satisfies CountryPackInput;
