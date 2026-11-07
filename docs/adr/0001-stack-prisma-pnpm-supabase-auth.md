# ADR 0001 — Stack: Prisma, pnpm, Supabase Auth

Status: proposed (needs owner confirmation) · Date: 2026-11-07

## Context
The initial design kit used Drizzle, npm workspaces and a custom auth adapter. The team's implementation
(since 2026-10-18) uses Prisma 6, pnpm + Turborepo, and Supabase Auth (cookie sessions via `@supabase/ssr`),
with Postgres on Supabase. The invariants (forced RLS from one template, no-bypass runtime role, event outbox,
engine-owned derived tables) were kept.

## Decision
Keep Prisma, pnpm/Turborepo and Supabase Auth for the pilot. The invariants in `CLAUDE.md` are the contract;
the ORM is not. Prisma Migrate runs as `ssos_owner`; the app runs as `ssos_app`.

## Consequences
- Kit prompts that mention Drizzle/npm must be adapted before use.
- Supabase Auth stores passwords; `user_account.external_auth_id` links the identity. Accounts are never
  auto-linked by e-mail.
- Supabase hosting region is a separate, still-open decision (data residency for AL and AE tenants).
- Revisit if production moves to self-managed Postgres on AWS (Prisma and pg-boss both work there).
