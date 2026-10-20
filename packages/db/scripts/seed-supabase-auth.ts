/**
 * Create (or refresh) the demo logins in Supabase Auth and link them to the
 * local database: user_account.external_auth_id = Supabase auth.users.id.
 *
 *   pnpm db:seed && pnpm auth:seed
 *
 * Idempotent: existing Supabase users are found by e-mail and their password
 * is reset to the demo password; the link is (re)written every run.
 *
 * Needs SUPABASE_URL and SUPABASE_SECRET_KEY (server-only service key) plus
 * DATABASE_ADMIN_URL. Only the AUTH side lives in Supabase — the database stays
 * local (Postgres 16) for now.
 *
 * Demo credentials (synthetic, demo data only), password `Demo1234!`:
 *   admin.tirane@demo.ssos.test     teacher.tirane@demo.ssos.test     parent.tirane@demo.ssos.test
 *   admin.abudhabi@demo.ssos.test   teacher.abudhabi@demo.ssos.test   parent.abudhabi@demo.ssos.test
 *   join@demo.ssos.test             (no role -> "Join your school")
 */
import { createClient, type User } from "@supabase/supabase-js";

import { createAdminClient } from "../src/client";
import { DEMO_PASSWORD, demoLoginEmails } from "../seed/fixtures";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set (see .env.example)`);
  return value;
}

async function findUsersByEmail(
  admin: ReturnType<typeof createClient>["auth"]["admin"],
  emails: Set<string>,
): Promise<Map<string, User>> {
  const found = new Map<string, User>();
  for (let page = 1; ; page++) {
    const { data, error } = await admin.listUsers({ page, perPage: 1000 });
    if (error) throw error;
    for (const u of data.users) {
      const email = u.email?.toLowerCase();
      if (email && emails.has(email)) found.set(email, u);
    }
    if (data.users.length < 1000) return found;
  }
}

async function main(): Promise<void> {
  const supabase = createClient(requireEnv("SUPABASE_URL"), requireEnv("SUPABASE_SECRET_KEY"), {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const db = createAdminClient();
  try {
    const emails = demoLoginEmails();
    const existing = await findUsersByEmail(supabase.auth.admin, new Set(emails));

    for (const email of emails) {
      const account = await db.userAccount.findUnique({ where: { email } });
      if (!account) throw new Error(`user_account ${email} missing — run \`pnpm db:seed\` first`);

      let user = existing.get(email);
      if (user) {
        const { data, error } = await supabase.auth.admin.updateUserById(user.id, {
          password: DEMO_PASSWORD,
          email_confirm: true,
        });
        if (error) throw error;
        user = data.user;
      } else {
        const { data, error } = await supabase.auth.admin.createUser({
          email,
          password: DEMO_PASSWORD,
          email_confirm: true,
          user_metadata: { display_name: account.displayName },
        });
        if (error) throw error;
        user = data.user;
      }

      await db.$transaction([
        // external_auth_id is unique: release it from any other row first.
        db.userAccount.updateMany({
          where: { externalAuthId: user.id, NOT: { id: account.id } },
          data: { externalAuthId: null },
        }),
        db.userAccount.update({ where: { id: account.id }, data: { externalAuthId: user.id } }),
      ]);
      console.info(`${existing.has(email) ? "refreshed" : "created  "} ${email} -> ${user.id}`);
    }
    console.info(`Linked ${emails.length} demo logins to Supabase Auth (password: ${DEMO_PASSWORD}).`);
  } finally {
    await db.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
