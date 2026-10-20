import type { CountryCode } from "@ssos/country-packs";

import { ALBANIAN, EMIRATI, LEVANTINE_EGYPTIAN, type NamePool, SOUTH_ASIAN, WESTERN_EXPAT } from "./names";

/** Seed data for one demo tenant. Pure data — the seed code never branches on country. */
export interface TenantFixture {
  slug: string;
  name: string;
  countryCode: CountryCode;
  defaultLocale: string;
  timezone: string;
  joinCode: string;
  /** Prefix for demo login emails, e.g. "tirane" -> admin.tirane@demo.ssos.test */
  emailTag: string;
  pools: readonly NamePool[];
  classes: readonly { code: string; name: string; gradeLevel: number }[];
  /** Localised relationship labels are a UI concern; stored values are keys. */
  invitation: { email: string; roleKey: "teacher"; code: string };
}

export const COUNTS = { students: 30, teachers: 6, parents: 20, advisors: 1, admins: 1 } as const;

export const DEMO_EMAIL_DOMAIN = "demo.ssos.test";
/** Password for every demo login, set in Supabase Auth by scripts/seed-supabase-auth.ts (demo data only). */
export const DEMO_PASSWORD = "Demo1234!";
export const NO_ROLE_EMAIL = `join@${DEMO_EMAIL_DOMAIN}`;

export const TENANTS: readonly TenantFixture[] = [
  {
    slug: "liceu-demo-tirane",
    name: "Liceu Demo Tiranë",
    countryCode: "AL",
    defaultLocale: "sq",
    timezone: "Europe/Tirane",
    joinCode: "TIR-4821",
    emailTag: "tirane",
    pools: [ALBANIAN],
    classes: [
      { code: "10-A", name: "Klasa 10-A", gradeLevel: 10 },
      { code: "11-A", name: "Klasa 11-A", gradeLevel: 11 },
      { code: "12-A", name: "Klasa 12-A", gradeLevel: 12 },
    ],
    invitation: { email: `new.teacher.tirane@${DEMO_EMAIL_DOMAIN}`, roleKey: "teacher", code: "INV-TIR-001" },
  },
  {
    slug: "demo-school-abu-dhabi",
    name: "Demo School Abu Dhabi",
    countryCode: "AE",
    defaultLocale: "en",
    timezone: "Asia/Dubai",
    joinCode: "AUH-7315",
    emailTag: "abudhabi",
    pools: [EMIRATI, LEVANTINE_EGYPTIAN, SOUTH_ASIAN, WESTERN_EXPAT],
    classes: [
      { code: "G10-A", name: "Grade 10 A", gradeLevel: 10 },
      { code: "G11-A", name: "Grade 11 A", gradeLevel: 11 },
      { code: "G12-A", name: "Grade 12 A", gradeLevel: 12 },
    ],
    invitation: { email: `new.teacher.abudhabi@${DEMO_EMAIL_DOMAIN}`, roleKey: "teacher", code: "INV-AUH-001" },
  },
];

/** Kinds of seeded per-tenant demo logins: `${kind}.${emailTag}@demo.ssos.test`. */
export const DEMO_LOGIN_KINDS = ["admin", "teacher", "parent"] as const;

/** Every seeded demo login e-mail (per-tenant logins plus the no-role join@ account). */
export function demoLoginEmails(): string[] {
  return [
    ...TENANTS.flatMap((t) => DEMO_LOGIN_KINDS.map((kind) => `${kind}.${t.emailTag}@${DEMO_EMAIL_DOMAIN}`)),
    NO_ROLE_EMAIL,
  ];
}
