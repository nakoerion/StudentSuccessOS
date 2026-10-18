# Student Success OS (`sso`)

Multi-tenant platform for secondary schools in Albania and the UAE. One codebase;
country differences come only from `@ssos/country-packs` data; every tenant-owned
table carries `tenant_id` and is protected by Postgres row-level security
generated from **one** policy template.

This is **Slice 1**: monorepo foundation, schema, RLS, seed and isolation tests.
`apps/web` is a placeholder — the UI is Slice 2.

## Layout

| Path | Package | What |
| --- | --- | --- |
| `apps/web` | `@ssos/web` | Next.js 15 placeholder (one page) |
| `packages/db` | `@ssos/db` | Prisma schema, migrations, RLS generator, seed, `withTenant`, tests |
| `packages/config` | `@ssos/config` | Shared `tsconfig` presets (strict) and ESLint flat config |
| `packages/country-packs` | `@ssos/country-packs` | Typed `AL` / `AE` packs — **placeholder values** |
| `packages/ui` | `@ssos/ui` | Stub export (design tokens arrive in Slice 2) |

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
pnpm typecheck
pnpm lint
pnpm test                         # Vitest against the real database
pnpm build
```

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
- `ssos_user_memberships(user_account_id)` — SECURITY DEFINER lookup for Slice 2
  sign-in ("which schools/roles does this login have?") before a tenant is chosen.

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

Authentication itself is Slice 2; these `user_account` rows exist and are linked
to seeded people.

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
| `pnpm test` | turbo: Vitest in `packages/db` (needs Postgres up, migrated, seeded) |
| `pnpm db:up` | start Postgres + ensure roles/db |
| `pnpm db:migrate` | `prisma migrate deploy` |
| `pnpm db:seed` | seed demo data |
| `pnpm db:reset` | drop everything, re-migrate, re-seed |
| `pnpm rls:generate` | regenerate the RLS migration from the template |

## Deferred (not in Slice 1)

Next.js UI, auth, i18n/RTL, design tokens (Slice 2); researched country-pack values;
invite outreach; CSV/OneRoster import; RBAC service layer and tenant custom roles;
audit middleware; Storybook; CI; OpenAPI.
