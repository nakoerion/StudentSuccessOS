import type { CountryPackInput } from "../types";

/**
 * Albania. Researched 2026-10-21; every fact cites `sources` by id.
 * Structure: Law 69/2012 "Për sistemin arsimor parauniversitar" (as amended).
 */
export const AL_INPUT = {
  code: "AL",
  name: "Albania",
  version: "1.0.0",
  researchedAt: "2026-10-21",
  supportedLocales: ["sq", "en"],
  defaultTimezone: "Europe/Tirane",

  grades: [
    {
      key: "parashkollor",
      name: "Arsimi parashkollor",
      nameEn: "Pre-school education",
      isced: 0,
      // Law 69/2012 runs pre-school "from three to six"; grade 1 starts at 6, so the
      // last pre-school year begins at age 5 (the preparatory class for 5-year-olds).
      grades: ["KG1", "KG2", "KG3"],
      ageRange: { min: 3, max: 5 },
      compulsory: false,
      sourceIds: ["al-law-69-2012"],
    },
    {
      key: "fillor",
      name: "Arsimi fillor",
      nameEn: "Primary education",
      isced: 1,
      grades: ["1", "2", "3", "4", "5"],
      ageRange: { min: 6, max: 10 },
      compulsory: true,
      sourceIds: ["al-law-69-2012", "al-compulsory-age"],
    },
    {
      key: "mesem-i-ulet",
      name: "Arsimi i mesëm i ulët",
      nameEn: "Lower secondary education",
      isced: 2,
      grades: ["6", "7", "8", "9"],
      ageRange: { min: 11, max: 14 },
      compulsory: true,
      sourceIds: ["al-law-69-2012", "al-compulsory-age"],
    },
    {
      key: "mesem-i-larte",
      name: "Arsimi i mesëm i lartë (gjimnaz)",
      nameEn: "Upper secondary education (gymnasium)",
      isced: 3,
      grades: ["10", "11", "12"],
      ageRange: { min: 15, max: 17 },
      // Basic education (grades 1–9) is compulsory from age 6 to 16; upper secondary is free but not compulsory.
      compulsory: false,
      sourceIds: ["al-law-69-2012", "al-compulsory-age"],
    },
  ],

  gradingScales: [
    {
      key: "al-4-10",
      name: "Shkalla e notave 4–10",
      kind: "numeric",
      min: 4,
      max: 10,
      passMark: 5,
      appliesToGrades: ["4", "5", "6", "7", "8", "9", "10", "11", "12"],
      bands: [
        { min: 4, max: 4, label: "4", description: "Niveli I — pakaluese", passing: false },
        { min: 5, max: 5, label: "5", description: "Niveli II", passing: true },
        { min: 6, max: 6, label: "6", description: "Niveli II", passing: true },
        { min: 7, max: 7, label: "7", description: "Niveli III", passing: true },
        { min: 8, max: 8, label: "8", description: "Niveli III", passing: true },
        { min: 9, max: 9, label: "9", description: "Niveli IV", passing: true },
        { min: 10, max: 10, label: "10", description: "Niveli IV", passing: true },
      ],
      notes:
        "Whole-number marks 4–10; 4 is the only failing mark. Grades 1–3 are assessed descriptively (achievement levels), not with marks.",
      sourceIds: ["al-ascap-assessment-framework", "al-grading-levels"],
    },
  ],

  examCalendars: [
    {
      academicYear: "2026-2027",
      start: "2026-09-14",
      end: "2027-06-18",
      // The Albanian school-year structure order sets lesson periods and holidays, not numbered terms.
      terms: [],
      exams: [
        {
          key: "matura-shteterore",
          name: "Matura Shtetërore",
          nameEn: "State Matura (upper-secondary leaving exam)",
          grades: ["12"],
          months: [6],
          window: { start: "2027-06-07", end: "2027-06-28" },
          status: "active",
          notes:
            "Ends upper secondary education. Lessons for grade 12 end 4 June 2027. The 2026 session sat foreign language (2 Jun), Albanian language and literature (9 Jun), mathematics (16 Jun) and the elective (23 Jun).",
          sourceIds: ["al-calendar-2026-2027", "al-law-69-2012", "al-matura-2026"],
        },
        {
          key: "provimet-kombetare-arsimi-baze",
          name: "Provimet Kombëtare të Arsimit Bazë",
          nameEn: "National Basic Education Exams (end of grade 9)",
          grades: ["9"],
          months: [6],
          window: { start: "2027-06-21", end: "2027-06-30" },
          status: "active",
          notes: "Taken at the end of grade 9 (lower secondary); results feed placement into upper secondary.",
          sourceIds: ["al-calendar-2026-2027", "al-law-69-2012"],
        },
      ],
      sourceIds: ["al-calendar-2026-2027"],
    },
  ],

  consentAges: {
    dataProcessing: {
      minAge: 16,
      basis:
        "Law 124/2024 on Personal Data Protection, Art. 8(6): consent-based processing of a minor's data for online services is lawful only from age 16; below 16 a parent or legal guardian must give or authorise consent.",
      sourceIds: ["al-law-124-2024"],
    },
    medical: {
      minAge: 18,
      basis:
        "No lower statutory age for medical consent was found; a minor (under 18) is represented by a parent or guardian, and full legal capacity — including consenting to treatment without a parent — starts at 18.",
      sourceIds: ["al-law-18-2017", "al-unfpa-capacity"],
    },
    ageOfMajority: {
      minAge: 18,
      basis: "Law 18/2017 on the Rights and Protection of the Child: a child is any person under 18.",
      sourceIds: ["al-law-18-2017"],
    },
  },

  defaultLanguages: {
    primary: "sq",
    secondary: [],
    notes: "Albanian is the language of instruction in pre-university education. English is offered in the UI as an option, not a default.",
    sourceIds: ["al-law-69-2012"],
  },

  sources: [
    {
      id: "al-law-69-2012",
      title: "Ligji nr. 69/2012 \"Për sistemin arsimor parauniversitar në Republikën e Shqipërisë\" (i ndryshuar)",
      publisher: "Ministria e Arsimit / arsimiparauniversitar.gov.al",
      url: "https://arsimiparauniversitar.gov.al/wp-content/uploads/2021/04/LIGJI-69-2012-I-NDRYSHUAR.pdf",
      kind: "legislation",
      accessed: "2026-10-21",
    },
    {
      id: "al-compulsory-age",
      title: "Projektligj për disa shtesa dhe ndryshime në ligjin nr. 69/2012 — basic education compulsory from 6 to 16",
      publisher: "Regjistri Elektronik për Njoftimet dhe Konsultimet Publike (konsultimipublik.gov.al)",
      url: "https://konsultimipublik.gov.al/Konsultime/Detaje/487",
      kind: "official",
      accessed: "2026-10-21",
    },
    {
      id: "al-ascap-assessment-framework",
      title: "Korniza e vlerësimit të nxënësit në arsimin parauniversitar (notat 4–10)",
      publisher: "Agjencia e Sigurimit të Cilësisë së Arsimit Parauniversitar (ASCAP)",
      url: "https://ascap.edu.al/wp-content/uploads/2017/03/Korniza-e-vleresimit-2.pdf",
      kind: "official",
      accessed: "2026-10-21",
    },
    {
      id: "al-grading-levels",
      title: "Si bëhet vlerësimi i nxënësve në Arsimin Fillor? (nivelet I–IV, nota 4 pakaluese)",
      publisher: "Portali Shkollor",
      url: "https://www.portalishkollor.al/kuriozitet/si-behet-vleresimi-i-nxenesve-ne-arsimin-fillor",
      kind: "news",
      accessed: "2026-10-21",
    },
    {
      id: "al-calendar-2026-2027",
      title: "Ministria e Arsimit publikon kalendarin, viti i ri shkollor 2026-2027 nis më 14 shtator",
      publisher: "Agjencia Telegrafike Shqiptare (ATA)",
      url: "https://acp.al/news/30803/ministria-e-arsimit-publikon-kalendarin-viti-i-ri-shkollor-2026-2027-nis-me-14-shtator/",
      kind: "news",
      accessed: "2026-10-21",
    },
    {
      id: "al-matura-2026",
      title: "Buletini janar 2026 — Publikohet rregullorja dhe kalendari i provimeve të Maturës Shtetërore 2026",
      publisher: "Ministria e Arsimit (arsimi.gov.al)",
      url: "https://arsimi.gov.al/wp-content/uploads/2026/02/Buletini-janar-2026.pdf",
      kind: "official",
      accessed: "2026-10-21",
    },
    {
      id: "al-law-124-2024",
      title: "Law no. 124/2024 On Personal Data Protection (English translation)",
      publisher: "Information and Data Protection Commissioner (idp.al)",
      url: "https://idp.al/wp-content/uploads/2025/03/Law-no.124-2024.pdf",
      kind: "legislation",
      accessed: "2026-10-21",
    },
    {
      id: "al-law-18-2017",
      title: "Law No. 18/2017 On the Rights and Protection of the Child (English)",
      publisher: "Observatori për të Drejtat e Fëmijëve",
      url: "https://observator.org.al/wp-content/uploads/2017/06/Layout-A5-english_18May2017.pdf",
      kind: "legislation",
      accessed: "2026-10-21",
    },
    {
      id: "al-unfpa-capacity",
      title: "Child Marriage in Albania (Overview) — juridical capacity at 18, incl. medical treatment without parental consent",
      publisher: "UNFPA Eastern Europe and Central Asia",
      url: "https://eeca.unfpa.org/sites/default/files/pub-pdf/unfpa%20albania%20overview.pdf",
      kind: "reference",
      accessed: "2026-10-21",
    },
  ],
} satisfies CountryPackInput;
