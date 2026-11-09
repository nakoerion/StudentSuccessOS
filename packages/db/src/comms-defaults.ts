/**
 * Default notification preferences per system role — documented defaults that each
 * school can change. Quiet hours are minutes of the day in the tenant's own time zone
 * (tenant.timezone), so the same defaults are correct in Tirana and Abu Dhabi without
 * any country branching. Channels are ordered: the first opted-in binding wins.
 */
import type { CommChannel, NotificationCategory, Prisma } from "@prisma/client";

import type { SystemRoleKey } from "./system-roles";

export const DEFAULT_QUIET_HOURS = {
  /** Families: 21:00–07:00. */
  family: { startMinute: 21 * 60, endMinute: 7 * 60 },
  /** Staff: 20:00–07:00. */
  staff: { startMinute: 20 * 60, endMinute: 7 * 60 },
} as const;

export interface DefaultPreference {
  roleKey: SystemRoleKey;
  category: NotificationCategory;
  channels: CommChannel[];
  enabled: boolean;
}

const CATEGORY_CHANNELS: Record<"family" | "staff", Record<NotificationCategory, CommChannel[]>> = {
  family: {
    alert: ["push", "whatsapp", "telegram", "sms"],
    digest: ["whatsapp", "telegram", "email"],
    message: ["push", "whatsapp", "telegram"],
    announcement: ["push", "email"],
    nudge: ["push"],
    system: ["email"],
  },
  staff: {
    alert: ["push", "email"],
    digest: ["email"],
    message: ["push", "email"],
    announcement: ["push", "email"],
    nudge: ["push"],
    system: ["email"],
  },
};

const ROLE_GROUP: Record<SystemRoleKey, "family" | "staff"> = {
  student: "family",
  parent: "family",
  teacher: "staff",
  advisor: "staff",
  trainer: "staff",
  admin: "staff",
};

const CATEGORIES: NotificationCategory[] = ["alert", "digest", "message", "announcement", "nudge", "system"];

/** The weekly digest goes to parents only. */
export const DEFAULT_NOTIFICATION_PREFERENCES: readonly DefaultPreference[] = (
  Object.keys(ROLE_GROUP) as SystemRoleKey[]
).flatMap((roleKey) =>
  CATEGORIES.map((category) => ({
    roleKey,
    category,
    channels: [...CATEGORY_CHANNELS[ROLE_GROUP[roleKey]][category]],
    enabled: category !== "digest" || roleKey === "parent",
  })),
);

/** Insert the role-default preferences for one tenant. `newId` lets the seed use deterministic ids. */
export async function createCommsDefaults(
  tx: Prisma.TransactionClient,
  tenantId: string,
  newId?: (table: string, key: string) => string,
): Promise<{ notificationPreferences: number }> {
  const { count } = await tx.notificationPreference.createMany({
    data: DEFAULT_NOTIFICATION_PREFERENCES.map((p) => {
      const quiet = DEFAULT_QUIET_HOURS[ROLE_GROUP[p.roleKey]];
      return {
        ...(newId ? { id: newId("notification_preference", `${p.roleKey}:${p.category}`) } : {}),
        tenantId,
        roleKey: p.roleKey,
        category: p.category,
        channels: p.channels,
        enabled: p.enabled,
        quietStartMinute: quiet.startMinute,
        quietEndMinute: quiet.endMinute,
      };
    }),
  });
  return { notificationPreferences: count };
}
