/**
 * pg-boss on the OWNER connection. pg-boss creates and migrates its own schema (`pgboss`),
 * which needs CREATE on the database — and the runtime role `ssos_app` must never hold
 * DDL rights. So the queue always connects with DATABASE_ADMIN_URL (ssos_owner), and
 * `createBoss` refuses an app-role URL outright.
 */
import { PgBoss } from "pg-boss";

import { type DomainEvent } from "./events";
import type { JobDeps } from "./handlers";

export const BOSS_SCHEMA = "pgboss";
const APP_ROLE = "ssos_app";

/** The login role of a Postgres URL ("ssos_app.<ref>" on the Supabase pooler counts as ssos_app). */
export function roleOfUrl(url: string): string {
  const user = decodeURIComponent(new URL(url).username);
  return user.split(".")[0] ?? user;
}

/** Throws unless the URL logs in as a role other than the RLS-bound app role. */
export function assertOwnerUrl(url: string | undefined): string {
  if (!url) throw new Error("DATABASE_ADMIN_URL is not set — pg-boss must run on the owner connection");
  if (roleOfUrl(url) === APP_ROLE) throw new Error(`pg-boss must not connect as ${APP_ROLE}: it creates its own schema (DDL). Use DATABASE_ADMIN_URL.`);
  // Prisma-only parameters mean nothing to node-postgres.
  const u = new URL(url);
  for (const p of ["schema", "pgbouncer", "connection_limit", "pool_timeout"]) u.searchParams.delete(p);
  return u.toString();
}

export function createBoss(url: string | undefined = process.env.DATABASE_ADMIN_URL, options: { schedule?: boolean; supervise?: boolean } = {}): PgBoss {
  return new PgBoss({ connectionString: assertOwnerUrl(url), schema: BOSS_SCHEMA, ...options });
}

/** The `publish` / `send` the handlers need, backed by a started boss. */
export function bossTransport(boss: PgBoss): Pick<JobDeps, "publish" | "send"> {
  return {
    publish: (topic: DomainEvent, data, options) => boss.publish(topic, data, options),
    send: (queue, data) => boss.send(queue, data),
  };
}
