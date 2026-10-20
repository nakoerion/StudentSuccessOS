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
| `packages/country-packs` | `@ssos/country-packs` | Typed `AL` / `AE` packs — **placeholder values** |
| `packages/ui` | `@ssos/ui` | Design tokens (CSS variables, light/dark) + shadcn-style Button, Input, Card, Table, Badge, Tabs, Select |

## Setup (from clean)

Requirements: Node 22+, pnpm (the repo pins `pnpm@10.34.7` via `packageManager`), PostgreSQL 16.

```bash
# In this team environment /home is tiny: work from /work and keep caches there.
export HOME=/work/home            # npm/corepack/prisma caches otherwise land in /home
cd /work/sso

bash scripts/db-up.sh             # start Postgres 16, create roles + database, create .env
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

**Auth = Supabase, data = local Postgres.** Supabase Auth stores passwords and
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
- Locale: `NEXT_LOCALE` cookie (set by the switcher) > the tenant's `default_locale`
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

## Seed

`pnpm db:seed` — deterministic (UUIDv5-style ids, seeded PRNG, hand-written name
pools), re-runnable (each demo tenant is rebuilt; globals are upserted).

| Tenant | Pack | Locale | Timezone | Join code | Sample invitation code |
| --- | --- | --- | --- | --- | --- |
| Liceu Demo Tiranë (`liceu-demo-tirane`) | AL | sq | Europe/Tirane | `TIR-4821` | `INV-TIR-001` |
| Demo School Abu Dhabi (`demo-school-abu-dhabi`) | AE | en | Asia/Dubai | `AUH-7315` | `INV-AUH-001` |

Per tenant: 30 students (10 in each of 3 classes), 6 teachers, 20 parents
(parents P-001…P-010 have two children, P-011…P-020 one), 1 advisor, 1 admin =
58 persons, 58 role assignments, 30 guardianships, 30 consents, 3 classes,
2 settings, 1 invitation, 1 audit entry. Globals: 2 country packs, 2 grade scales,
6 system roles (Student, Parent, Teacher, Advisor, Trainer, Admin), 8 permissions.

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
password reset / sign-up; researched country-pack values;
invite outreach; CSV/OneRoster import; RBAC service layer and tenant custom roles;
audit middleware; Storybook; CI; OpenAPI.
