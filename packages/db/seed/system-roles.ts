import type { Prisma } from "@prisma/client";

import { PERMISSIONS, ROLE_PERMISSIONS, SYSTEM_ROLES, type SystemRoleKey } from "../src/system-roles";
import { seedId } from "./deterministic";

type Tx = Prisma.TransactionClient;

/**
 * Upserts the system permissions, system roles and their grants. Additive and
 * idempotent: a permission newly defined in `system-roles.ts` is created and
 * granted to existing roles without touching any tenant data.
 */
export async function seedSystemRoles(tx: Tx): Promise<Record<SystemRoleKey, string>> {
  const permissionIds: Record<string, string> = {};
  for (const p of PERMISSIONS) {
    const row = await tx.permission.upsert({
      where: { key: p.key },
      create: { id: seedId("permission", p.key), key: p.key, description: p.description },
      update: { description: p.description },
    });
    permissionIds[p.key] = row.id;
  }

  const roleIds = {} as Record<SystemRoleKey, string>;
  for (const r of SYSTEM_ROLES) {
    const existing = await tx.role.findFirst({ where: { tenantId: null, key: r.key } });
    const row = existing
      ? await tx.role.update({ where: { id: existing.id }, data: { name: r.name, isSystem: true } })
      : await tx.role.create({ data: { id: seedId("role", r.key), key: r.key, name: r.name, isSystem: true } });
    roleIds[r.key] = row.id;
    for (const permKey of ROLE_PERMISSIONS[r.key]) {
      const permissionId = permissionIds[permKey]!;
      await tx.rolePermission.upsert({
        where: { roleId_permissionId: { roleId: row.id, permissionId } },
        create: { id: seedId("role_permission", r.key, permKey), roleId: row.id, permissionId },
        update: {},
      });
    }
  }
  return roleIds;
}
