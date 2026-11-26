"use server";

import { redirect } from "next/navigation";

import { acceptInvitationCode, claimRoleWithJoinCode, lookupCode, normaliseCode } from "../../lib/join";
import { requireUser } from "../../lib/session";

/** Step 1: a code was typed. Invitation -> grant now; join code -> pick a role. */
export async function submitCodeAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const code = normaliseCode(formData.get("code"));
  const found = await lookupCode(code);
  if (found.kind === "invitation") {
    const result = await acceptInvitationCode({ userId: user.id, name: user.name, email: user.email }, code);
    if (result.ok) redirect(`/t/${result.slug}`);
    redirect(`/join?error=${result.error}`);
  }
  if (found.kind === "join") redirect(`/join?code=${encodeURIComponent(code)}`);
  redirect(`/join?error=${found.kind === "used" ? "code_used" : "invalid_code"}`);
}

/** Step 2: role chosen for a join code -> pending claim. */
export async function claimRoleAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const code = normaliseCode(formData.get("code"));
  const rawName = formData.get("name");
  const name = typeof rawName === "string" ? rawName.replace(/\s+/g, " ").trim().slice(0, 120) : "";
  // The admin approves a person, not an e-mail address: a claim needs a name.
  if (name.length < 2) redirect(`/join?code=${encodeURIComponent(code)}&error=name_required`);
  const result = await claimRoleWithJoinCode(
    { userId: user.id, name, email: user.email },
    code,
    formData.get("role"),
  );
  if (result.ok) redirect("/join?claimed=1");
  redirect(
    result.error === "invalid_role"
      ? `/join?code=${encodeURIComponent(code)}&error=invalid_role`
      : `/join?error=${result.error}`,
  );
}
