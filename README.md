# Student Success OS (`sso`)

Multi-tenant platform for secondary schools in Albania and the UAE. One codebase;
country differences come only from `@ssos/country-packs` data; every tenant-owned
table carries `tenant_id` and is protected by Postgres row-level security
generated from **one** policy template.

**Slice 1**: monorepo foundation, schema, RLS, seed and isolation tests.
**Slice 2**: the clickable Next.js 15 app — sign-in, tenant resolution, "Join your
school", school dashboard and roster, `sq`/`en`/`ar` with RTL, `@ssos/ui` tokens.

## Layout

| Path | Package | What |
| --- | --- | --- |
| `apps/web` | `@ssos/web` | Next.js 15 app (App Router, next-intl, Tailwind v4), Vitest + Playwright |
| `packages/auth` | `@ssos/auth` | Auth behind a small interface (`getSessionUser`, `signInWithPassword`, `signOutUser`, `authHandlers`, `@ssos/auth/middleware`); Supabase Auth (cookie sessions via `@supabase/ssr`) |
| `packages/db` | `@ssos/db` | Prisma schema, migrations, RLS generator, seed, `withTenant`, tests |
| `packages/config` | `@ssos/config` | Shared `tsconfig` presets (strict) and ESLint flat config |
| `packages/country-packs` | `@ssos/country-packs` | Researched, source-cited `AL` / `AE` packs, Zod-validated at import (see "Country packs") |
| `packages/ui` | `@ssos/ui` | Design tokens (CSS variables, light/dark) + shadcn-style Button, Input, Card, Table, Badge, Tabs, Select |

## Setup (from clean)

Requirements: Node 22+, pnpm (the repo pins `pnpm@10.34.7` via `packageManager`), PostgreSQL 16.

```bash
# In this team environment /home is tiny: work from /work and keep caches there.
export HOME=/work/home            # npm/corepack/prisma caches otherwise land in /home
cd /work/sso

source /etc/profile.d/cto-env-vars.sh   # SUPABASE_DB_URL + SUPABASE_* keys
bash scripts/supabase-db-up.sh    # Supabase Postgres: create ssos_owner/ssos_app, write .env (see "Supabase Postgres")
# (offline alternative: bash scripts/db-up.sh — local Postgres 16, roles + database + .env)
pnpm install                      # also runs `prisma generate`
pnpm db:migrate                   # prisma migrate deploy (as ssos_owner)
pnpm db:seed                      # deterministic; safe to re-run
pnpm auth:seed                    # create/refresh demo logins in Supabase Auth + link external_auth_id (idempotent)
pnpm typecheck
pnpm lint
pnpm test                         # Vitest against the real database
pnpm build
pnpm --filter @ssos/web start     # http://localhost:3000  (or `pnpm --filter @ssos/web dev`)
```

### Running the app

`.env` (copied from `.env.example` by `db-up.sh`) needs `DATABASE_URL`,
`DATABASE_ADMIN_URL`, `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY` and (for
`pnpm auth:seed` only) the server-only `SUPABASE_SECRET_KEY` — see `.env.example`
for which key is client-safe. Never commit real values. The web scripts load the
repo-root `.env` via `dotenv-cli`.

**Auth = Supabase Auth, data = Supabase Postgres** (or local Postgres offline). Supabase Auth stores passwords and
issues the cookie session; `apps/web/middleware.ts` validates/refreshes it on
every page request and sends visitors without a session to `/sign-in`. The
Supabase user id (`auth.users.id`) is stored in `user_account.external_auth_id`;
`getSessionUser()` maps it to the `user_account` row (via the SECURITY DEFINER
`ssos_account_for_auth`) and `SessionUser.id` stays the `user_account.id` used by
`userMemberships`, `withTenant` and `person.user_account_id`
(`SessionUser.authId` is the Supabase id). A Supabase user with no linked
account gets a fresh role-less account and lands on `/join`; an existing account
is never auto-linked by e-mail — `pnpm auth:seed` links the demo logins.
Auth endpoints: `GET /api/auth/session`, `GET /api/auth/callback` (PKCE code
exchange), `POST /api/auth/sign-out`. Sign in with any demo account below; **every demo account's
password is `Demo1234!`**. Set `SSOS_HIDE_DEMO_ACCOUNTS=1` to hide the demo list
on the sign-in page.

| URL | What |
| --- | --- |
| `/sign-in` | Email + password |
| `/` | Routes by memberships: 0 → `/join`, 1 → `/t/<slug>`, many → `/schools` |
| `/join` | Join code (`TIR-4821`, `AUH-7315`) → choose Student/Parent/Teacher → *pending* ("waiting for approval"); invitation code (`INV-TIR-001`, `INV-AUH-001`) → role granted immediately (single use) |
| `/t/<slug>` | Dashboard: counts of students, teachers, parents, classes (parents see "My children") |
| `/t/<slug>/people` | Roster: role tabs + name/ID search via URL params, server-rendered; students show guardians |

Rules enforced on the server:
- The active tenant is the URL slug. `requireTenant(slug)` 404s unless the user has an
  **active** role there, and every query runs through `withTenant(tenantId, …, { userId })`.
- Roster scope comes from permission keys (`roster.read` → whole roster;
  `guardianship.read_own` → only students the viewer is guardian of), applied in the SQL
  `WHERE` — a parent cannot widen it with `?role=` or `?q=`.
- Locale: `NEXT_LOCALE` cookie (set by the switcher) > the tenant's default (`default_locale` if its
  country pack supports it, else the pack's `defaultLanguages.primary`)
  > account locale > `Accept-Language` > `en`. `ar` renders `<html dir="rtl" lang="ar">`;
  components use logical properties only (`ps/pe/ms/me`, `start/end`).
- Theme: `ssos-theme` cookie (`light`/`dark`), applied server-side as `class="dark"`.

### Playwright smoke

```bash
pnpm --filter @ssos/web build
PLAYWRIGHT_BROWSERS_PATH=/opt/browsers pnpm --filter @ssos/web test:e2e   # re-seeds first
```
`/opt/browsers` already holds the matching Chromium build in this environment; elsewhere run
`npx playwright install chromium` once.

### PostgreSQL

There is no Docker daemon here, so Postgres 16 is the Ubuntu 24.04 distro package:

```bash
apt-get install -y postgresql-16
pg_ctlcluster 16 main start       # data dir: /var/lib/postgresql/16/main (root overlay)
```

After a reboot (or on a fresh machine) run **`bash scripts/db-up.sh`** (or `pnpm db:up`).
It installs Postgres if missing, starts the `16/main` cluster, and idempotently
creates the roles and the `ssos` database. Processes do not survive a restart;
the data directory does only if the root overlay does — if the database is empty,
just run `pnpm db:migrate && pnpm db:seed` again.

### Database roles and URLs

| Role | Attributes | Used for | Env var |
| --- | --- | --- | --- |
| `ssos_owner` | NOSUPERUSER, **BYPASSRLS**, owns schema | migrations, seed | `DATABASE_ADMIN_URL` |
| `ssos_app` | NOSUPERUSER, **NOBYPASSRLS** | the app at runtime, tests | `DATABASE_URL` |

See `.env.example`. Prisma Migrate uses `DATABASE_ADMIN_URL` automatically
(`directUrl` in `schema.prisma`); the seed uses `createAdminClient()`.
Passwords there are local-dev only.

### Supabase Postgres

The shared database is the owner's Supabase project. `bash scripts/supabase-db-up.sh`
(idempotent) connects with `SUPABASE_DB_URL` (the `postgres` role) and:

- creates `ssos_owner` (BYPASSRLS) and `ssos_app` (NOBYPASSRLS), asserts neither is a
  superuser, grants `ssos_owner` CREATE on `public` (+ CREATE on the database, needed by the
  init migration's `CREATE SCHEMA IF NOT EXISTS`) and `ssos_app` USAGE on `public`. All
  table/function grants for `ssos_app` come from the generated RLS migrations, exactly as locally;
- keeps the role passwords outside git in `/home/team/shared/.secrets/sso-supabase-roles.env`
  (chmod 600; override with `SSOS_SUPABASE_SECRETS`), reused on every run;
- writes `DATABASE_URL` / `DATABASE_ADMIN_URL` (+ `SUPABASE_*`) into `.env`.

**Why not run as `postgres`?** Supabase's `postgres` role has BYPASSRLS — an app connected
as it would see every tenant. Runtime is always `ssos_app`; `packages/db/test/isolation.test.ts`
fails if it is not.

**Why `ssos_owner` creates the tables:** Supabase's default privileges grant ALL on new
`public` tables created *by `postgres`* to `anon`/`authenticated` (the Data API). Tables
created by `ssos_owner` get no such grants, so the publishable key cannot reach SSOS data
through PostgREST/GraphQL; `isolation.test.ts` checks this too.

**Connections.** The direct host `db.<ref>.supabase.co` is IPv6-only (no IPv4 add-on), and
this environment has no IPv6, so:

| Use | Connection | Why |
| --- | --- | --- |
| Runtime (`DATABASE_URL`, `ssos_app`) | Transaction pooler `:6543`, `?pgbouncer=true&connection_limit=5` | IPv4; scales to many short app connections. Safe because tenant context is only ever set with `set_config(…, true)` inside a transaction. |
| Migrate/seed (`DATABASE_ADMIN_URL`, `ssos_owner`) | Direct host if it resolves, else session pooler `:5432` | Prisma Migrate needs a session connection (advisory locks, prepared statements); the session pooler is Supabase's IPv4 equivalent of direct. |

The pooler host is region-specific (`SUPABASE_POOLER_HOST`, default
`aws-1-ap-southeast-1.pooler.supabase.com`; Dashboard → Connect shows it).

## Country packs

`packages/country-packs/src/packs/{al,ae}.ts` hold the country data; `src/schema.ts` is the
Zod schema the types are inferred from. Each pack covers five dimensions — `grades`
(stages with grade codes and typical ages), `gradingScales`, `examCalendars` (academic
year, terms, national exams with months/windows; discontinued exams are kept with
`status: "discontinued"`), `consentAges` (data processing, medical, age of majority) and
`defaultLanguages` (primary + secondary) — and a `sources` array. Every fact cites
`sourceIds`; validation fails on an unknown or uncited source, overlapping grades, bands
outside the scale or disagreeing with the pass mark, exam windows outside their months,
consent ages above majority, or a primary language the pack does not offer. Packs are
validated at import, so a bad edit breaks `pnpm test`, `pnpm build` and `pnpm db:seed`.

Calendars may also give per-term `schoolDays` (validated to sum to the year's
`schoolDays`), `breaks` (each inside one term), term `nameEn`, and `notes` on scope.
Any consent rule, grading scale or calendar can carry
`needsConfirmation: { by: "local-counsel" | "school", note }`; `packConfirmationItems(pack)`
lists them so the UI/reports can show what is still unconfirmed.
The seed stores the validated pack in `country_pack.data` and sets each tenant's
`default_locale` (= `defaultLanguages.primary`, unless the tenant fixture sets its own
supported `defaultLocale`) and `timezone` from its pack.
`ssos_user_memberships` returns the tenant's `country_code`, and the web app resolves the
tenant default with `resolveTenantLocale` from `@ssos/country-packs`. Bump `version` and
`researchedAt` whenever pack data changes.

### Pack policy (owner decisions, 2026-10-26)

These are product defaults built from law-firm summaries and official pages — **not legal
advice**. Items marked *confirm with local counsel* must be checked by a lawyer licensed in
that country before we rely on them; *needs school confirmation* means each school confirms
or replaces the default for its own curriculum.

| | Albania (AL 1.1.0) | UAE (AE 1.1.0) |
| --- | --- | --- |
| Default UI language | `sq` | **`ar` (RTL)**, `en` as the second language/toggle; a tenant may set `default_locale = "en"` |
| Data-consent age (`consentAges.dataProcessing.minAge`) | **16** — guardian below 16 *(confirm with local counsel)* | **16** — guardian below 16 *(confirm with local counsel)* |
| Medical-consent age (`consentAges.medical.minAge`) | **18** — guardian below 18 *(confirm with local counsel)* | **18** — guardian below 18 *(confirm with local counsel)* |
| Year structure | 2 semesters; **no authoritative dates yet** → the wizard creates 2 placeholder periods *(needs school confirmation)* | 3 MOE terms 2026-27 *(needs school confirmation for non-MOE private schools)* |
| Grading | 4–10, pass 5 (ASCAP) | 0–100, pass 60 — a configurable default per tenant/curriculum, **not** an authoritative Ministry scale *(needs school confirmation)* |

- **UAE language.** Government schools teach all subjects in Arabic, with English as a second
  language for technical/scientific subjects; private schools may follow IB/British/American
  and other curricula but must offer Arabic as a second language (u.ae, *Curricula and
  language of instruction*). Hence Arabic is the pack default; many international private
  schools work in English and switch their tenant's `default_locale` to `en`. The demo
  **Demo School Abu Dhabi** does exactly that (fixture `defaultLocale: "en"`), so the demo
  shows the toggle; with no override an AE tenant opens in Arabic.
- **Data-consent age 16 in both packs.** Albania: Law 124/2024 Art. 8(6) — a minor's own consent
  to online services counts from 16; below 16 a parent/guardian consents (Law 124/2024 via
  idp.al; DLA Piper). UAE: the PDPL (Federal Decree-Law 45/2021) sets no age of digital
  consent (EdLaw); the Child Digital Safety Law (Federal Decree-Law 26/2025) requires
  verifiable parental consent below 13 (Clyde & Co; u.ae). 16 is stricter than both and
  satisfies both. **For a school the lawful basis for processing student data is usually the
  school's own legal duty, not the child's consent** — confirm with counsel in each country.
- **Medical consent 18 in both packs.** Albania: guardian consent below 18; the likely governing
  text is Law 10107/2009 on health care, but its consent rule is unconfirmed, and a
  non-authoritative industry blog suggests 16 may sometimes apply — we do **not** default to
  16 until Albanian counsel confirms. Health data is sensitive data under Law 124/2024.
  UAE: Federal Decree-Law 4/2016 on Medical Liability, Art. 5 (18+ competent to consent).
- **UAE 2026-27 calendar (MOE).** Term 1 31 Aug–11 Dec 2026 (67 school days), Term 2
  4 Jan–2 Apr 2027 (60), Term 3 12 Apr–2 Jul 2027 (58) = 185 days; Term 1 mid-term break
  12–16 Oct 2026 per the MOE document (some press gives 12–18 Oct counting weekends — we use
  MOE). Not covered: private schools on Indian, Bangladeshi or Pakistani curricula; other
  non-MOE private schools may split the mid-term break differently (not in Sharjah).
  Sources: moe.gov.ae calendar announcement; Gulf Today's report of the MOE day counts.
- **UAE grading.** No single authoritative Ministry scale was found (only vendor/news
  pages), so the 0–100 / pass-60 scale is a starting default. Schools set their own scale per
  curriculum via tenant grade scales and the `grading_scale` tenant setting.

## Row-level security

- `packages/db/rls/tables.ts` — the list of tenant-scoped tables (`tenant` scope:
  `tenant_id NOT NULL`; `shared` scope: nullable `tenant_id`, where NULL = global
  row such as a system role, readable by all tenants and writable by none).
- `packages/db/rls/generate.ts` — **the one template** (`policyFor`). Emits
  `ENABLE` + `FORCE ROW LEVEL SECURITY` and a `tenant_isolation` policy with
  `tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid` for both
  `USING` and `WITH CHECK`, plus grants for `ssos_app`.
  `NULLIF(..., '')` matters: once a pooled connection has used `SET LOCAL`, the
  setting reads back as `''`, and `''::uuid` would error instead of returning 0 rows.
- Output is committed as `prisma/migrations/20261018000100_rls/migration.sql`.
- `withTenant(tenantId, fn, { userId })` (`@ssos/db`) runs `fn` in one
  transaction after `set_config('app.tenant_id', …, true)` and
  `set_config('app.user_id', …, true)` (= `SET LOCAL`, parameterised).

```ts
import { withTenant } from "@ssos/db";
const roster = await withTenant(tenantId, (tx) => tx.person.findMany(), { userId });
```

**Adding a tenant-owned table:** add the model with `tenantId` to `schema.prisma`,
add it to `rls/tables.ts`, create the table migration, then
`pnpm rls:generate --name <timestamp>_rls_<what>` to write a new (idempotent)
RLS migration, and update `DEFAULT_RLS_MIGRATION` in `generate.ts`. The test
suite fails if any model with `tenantId` lacks a policy (DMMF check), if any live
table with a `tenant_id` column lacks forced RLS, or if the committed RLS
migration drifts from the generator.

Other integrity rules (`prisma/migrations/20261018000050_integrity`):
- Composite FKs `(tenant_id, x_id) → x(tenant_id, id)` so a row can never reference
  another tenant's person/unit (FK checks bypass RLS, so this matters).
- Trigger: a role referenced by `role_assignment` / `invitation` must be a system
  role or the same tenant's; `role_permission.tenant_id` must equal the role's.
- `UNIQUE … NULLS NOT DISTINCT` for system role keys and default grade scales.
- SECURITY DEFINER lookups (`prisma/migrations/20261019000000_auth_join`), each taking one
  key and returning one subject — the runtime role's only way to reach `user_account`
  or other tenants' rows before a tenant is chosen (typed wrappers in `@ssos/db` `lookups.ts`):
  `ssos_user_memberships(user_id)` (tenant, slug, default locale, role, status),
  `ssos_account_for_sign_in(email)`, `ssos_record_sign_in(user_id)`,
  `ssos_tenant_by_join_code(code)`, `ssos_invitation_by_code(code)`.
- Slice 2 tightening (generated `20261019000100_rls`): `ssos_app` has **no** privileges on
  `user_account`, and `tenant` has forced RLS with a `tenant_self` policy
  (`id = app.tenant_id`, SELECT only) — so the app role cannot list accounts or schools.
- `role_assignment.status` is `active` | `pending` (join-code claims await approval).

### Academic record (schema)

Migration `20261026000000_academic_record` (tables + integrity) and generated
`20261026000100_rls` (the current `DEFAULT_RLS_MIGRATION`).

- **Tenant-scoped** (`tenant_id` + `tenant_isolation`, composite FKs inside the tenant):
  `academic_year`, `term`, `subject` (nullable `pack_code`/`pack_key` origin hint),
  `course`, `class_section`, `enrollment`, `teacher_assignment`, `timetable_slot`,
  `attendance_event` (method `grid|qr`), `assessment_category`, `grade_entry`
  (FK to `grade_scale`), `term_grade`, `annual_grade`, `assignment` (`ai_policy`
  `allowed|guided|forbidden`), `submission`, `rubric_score`, `note`
  (`visibility` `internal|parent|student`), `event`, `edge`, `mastery_state`.
- **Global** (forced RLS + `global_read`, SELECT only): `concept`, `concept_edge`.
- **Access modes** in `rls/tables.ts` (`access`), same row filter for all:
  `read_write` (default), `append_only` (`event`: SELECT + INSERT; UPDATE/DELETE →
  permission denied), `derived` (`term_grade`, `annual_grade`: SELECT only — written
  by the grade-derivation service as owner / SECURITY DEFINER, never by hand).
- Trigger `ssos_check_grade_scale_tenant`: a `grade_scale_id` on course/grade_entry/
  term_grade/annual_grade must be a pack default or the same tenant's override.

### Academic-year setup wizard

`runSetupWizard(ownerDb, { tenantId })` in `packages/db/src/setup-wizard.ts`
(exported from `@ssos/db`) builds a tenant's academic year from its country pack:
`academic_year` → `term` → `subject` → `course` (subject × grade) → `class_section`
(one per class unit) → `enrollment` (each student into every section of their class)
→ `teacher_assignment` (subjects round-robin over teachers, one primary per section)
→ `assessment_category` (weighted, summing to 100 per course; `course.grade_scale_id`
is the pack scale whose `appliesToGrades` covers the grade, a tenant override winning).

- `planAcademicYear` is pure (pack + roster → plan); `runSetupWizard` loads the roster
  and applies the plan as the **owner** role, filtering every query by `tenant_id`.
- **Idempotent**: inserts use the tables' unique keys with `ON CONFLICT DO NOTHING`, so a
  re-run creates nothing and never overwrites what a school has edited. `result.created`
  reports rows inserted, `result.totals` the rows in the year.
- Never writes `term_grade` / `annual_grade` (derived) and emits no `event` rows.
- No country branches: everything comes from pack data. Where the pack has no data
  yet, the wizard uses **placeholders** and lists them in `result.placeholders`:
  - `terms` — the pack calendar has no terms (AL 2026-2027): the year is split into
    2 equal "Period" terms (`period-1`, `period-2`) standing in for Albania's 2 semesters.
    Real AL semester dates belong in the pack once a school confirms them. AE has no
    placeholder terms: it gets the 3 real MOE 2026-27 terms (named in the tenant's
    locale — `nameEn` for non-Arabic tenants).
  - `subjects` — the pack has no `subjects`: a generic 8-subject catalog
    (`PLACEHOLDER_SUBJECTS`, names in sq/en/ar, `pack_code`/`pack_key` NULL). Packs may
    now declare `subjects` (cited); then `pack_code`/`pack_key` are set.
  - `assessment_categories` — the scale has no `defaultCategories`: Coursework 40 /
    Tests 30 / Final assessment 30 (`PLACEHOLDER_CATEGORIES`). Packs may now declare
    `gradingScales[].defaultCategories` (cited via `categoriesSourceIds`, weights sum to 100).

## Seed

`pnpm db:seed` — deterministic (UUIDv5-style ids, seeded PRNG, hand-written name
pools), re-runnable (each demo tenant is rebuilt; globals are upserted).

| Tenant | Pack | Locale | Timezone | Join code | Sample invitation code |
| --- | --- | --- | --- | --- | --- |
| Liceu Demo Tiranë (`liceu-demo-tirane`) | AL | sq | Europe/Tirane | `TIR-4821` | `INV-TIR-001` |
| Demo School Abu Dhabi (`demo-school-abu-dhabi`) | AE | en (tenant override; pack default `ar`) | Asia/Dubai | `AUH-7315` | `INV-AUH-001` |

Per tenant: 30 students (10 in each of 3 classes), 6 teachers, 20 parents
(parents P-001…P-010 have two children, P-011…P-020 one), 1 advisor, 1 admin =
58 persons, 58 role assignments, 30 guardianships, 30 consents, 3 classes,
2 settings, 1 invitation, 1 audit entry, plus a full academic year built by the
**setup wizard** (below): 1 academic year, its terms (AL 2, AE 3), 8 subjects,
24 courses, 24 class sections, 240 enrollments, 24 teacher assignments and
72 assessment categories.
Globals: 2 country packs, 2 grade scales,
6 system roles (Student, Parent, Teacher, Advisor, Trainer, Admin), 8 permissions,
and 4 demo `concept` + 3 `concept_edge` rows per pack (placeholder codes, not official).

### Demo login accounts

Every account's password is **`Demo1234!`** — stored in Supabase Auth by
`pnpm auth:seed` (`packages/db/scripts/seed-supabase-auth.ts`), not in our database.

| Email | Tenant | Role |
| --- | --- | --- |
| `admin.tirane@demo.ssos.test` | Liceu Demo Tiranë | Admin |
| `teacher.tirane@demo.ssos.test` | Liceu Demo Tiranë | Teacher |
| `parent.tirane@demo.ssos.test` | Liceu Demo Tiranë | Parent (2 children) |
| `admin.abudhabi@demo.ssos.test` | Demo School Abu Dhabi | Admin |
| `teacher.abudhabi@demo.ssos.test` | Demo School Abu Dhabi | Teacher |
| `parent.abudhabi@demo.ssos.test` | Demo School Abu Dhabi | Parent (2 children) |
| `join@demo.ssos.test` | — | none ("Join your school" state) |

All names are synthetic combinations; no real people.

## Scripts

| Command | What |
| --- | --- |
| `pnpm build` | turbo: builds `apps/web` |
| `pnpm typecheck` | turbo: `tsc --noEmit` in every workspace |
| `pnpm lint` | turbo: ESLint (shared flat config) |
| `pnpm test` | turbo: Vitest in `packages/db`, `packages/auth`, `apps/web`, one package at a time (needs Postgres up, migrated, seeded) |
| `pnpm db:up` | start Postgres + ensure roles/db |
| `pnpm db:migrate` | `prisma migrate deploy` |
| `pnpm db:seed` | seed demo data |
| `pnpm auth:seed` | create/refresh the demo logins in Supabase Auth and link `user_account.external_auth_id` |
| `pnpm db:reset` | drop everything, re-migrate, re-seed |
| `pnpm rls:generate` | regenerate the RLS migration from the template |

## Deferred

Approving pending join requests (an admin UI; the dashboard only shows the count);
password reset / sign-up; letter-grade bands for the UAE scale and Cycle 1–2 scales (not yet in a cited source);
invite outreach; CSV/OneRoster import; RBAC service layer and tenant custom roles;
audit middleware; Storybook; CI; OpenAPI.
