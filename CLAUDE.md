# Student Success OS — standing rules for Claude Code sessions

Multi-tenant platform for secondary schools in Albania (AL) and the UAE (AE). Read `README.md` first.
Keep this file under ~120 lines. A rule the tooling already enforces (lint, tests) can be removed.

## Commands
- `pnpm install` · `pnpm typecheck` · `pnpm lint` · `pnpm test` · `pnpm build`
- DB: `pnpm db:migrate` (as `ssos_owner`) · `pnpm db:seed` · `pnpm rls:generate --name <ts>_rls_<what>`
- Local Postgres 16: `bash scripts/db-up.sh`; Supabase: `bash scripts/supabase-db-up.sh`.

## Non-negotiable invariants
1. **Every tenant table has `tenant_id` and forced RLS generated from the single template** in
   `packages/db/rls/generate.ts`. Never hand-write a policy. New table → add to `rls/tables.ts`, migrate,
   regenerate. `rls-coverage.test.ts` fails on any miss or drift.
2. **Runtime role is `ssos_app` (NOBYPASSRLS).** Request handlers use `withTenant(tenantId, fn, { userId })`.
   The owner role (`ssos_owner`) is for migrations, seed and engine services only; every owner-role query
   filters by `tenant_id` explicitly. Never point `DATABASE_URL` at Supabase's `postgres` role.
3. **Derived data is engine-owned** (`access: "derived"`/engine tables: term/annual grades, risk scores,
   risk_model_config). The app role may only SELECT them. Never write them from request code.
4. **AI/engine proposes, a human decides.** Track changes are action cards; only an approved card can create a
   `track_assignment` (enforced in the database, not only in code). Do not bypass.
5. **Every mutation writes exactly one `event` row in the same transaction** (the event table is the outbox).
   `event` is append-only.
6. **No country literals outside `packages/country-packs`.** Differences between AL and AE are pack data.
7. **Locale:** `sq`/`en`/`ar`; `ar` renders RTL; use logical CSS properties only (`ps/pe/ms/me`, `start/end`).
8. **Server-side authorization on every page and action** (`requireTenant`, permission keys). The middleware is
   the first gate, not the only one. No secrets in the repo; `.env` is gitignored.
9. **Conventions are not law.** Anything in a pack marked `needsConfirmation` must stay visibly flagged in the UI.

## Working rules
- One slice per PR, under ~600 changed lines where possible. Cite the spec section in the PR description.
- Tests with every service change (Vitest against the real database). Do not snapshot the implementation.
- Money-like and grade arithmetic uses decimals and half-up rounding to 2 dp; never floats.
- Do not widen scope inside a fix PR. Record decisions in `docs/adr/`.
- Never put real student data in fixtures. Demo accounts are local-only; set `SSOS_HIDE_DEMO_ACCOUNTS=1` when deployed.

## Open decisions (do not assume)
- Regional hosting layout: EU database for Albania, UAE-resident database for the UAE (see ADR 0002 when written).
- AI service (`sso-ai`): not started; no model call may be added without the regional egress guard and redaction.
