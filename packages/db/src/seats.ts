/**
 * Seats for the AI budget (seat-count-sync-spec.md): a seat is one student with an active
 * enrolment in the tenant. Students only; a student in several classes counts once; withdrawn
 * or completed enrolments do not count. ENGINE task over the OWNER client — every query filters
 * by `tenant_id` explicitly. Returns counts only, never names.
 */
import type { Prisma, PrismaClient } from "@prisma/client";

type Db = PrismaClient | Prisma.TransactionClient;

export interface TenantSeats {
  tenantId: string;
  slug: string;
  seats: number;
}

/** Distinct students with at least one active enrolment in this tenant. */
export async function countActiveSeats(db: Db, tenantId: string): Promise<number> {
  const rows = await db.enrollment.findMany({
    where: { tenantId, status: "active" },
    distinct: ["studentPersonId"],
    select: { studentPersonId: true },
  });
  return rows.length;
}

/** Every tenant with its seat count, ordered by slug. */
export async function listTenantSeats(db: Db): Promise<TenantSeats[]> {
  const tenants = await db.tenant.findMany({ select: { id: true, slug: true }, orderBy: { slug: "asc" } });
  const out: TenantSeats[] = [];
  for (const t of tenants) out.push({ tenantId: t.id, slug: t.slug, seats: await countActiveSeats(db, t.id) });
  return out;
}
