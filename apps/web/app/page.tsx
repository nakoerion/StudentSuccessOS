import { redirect } from "next/navigation";

import { getMembershipRows, requireUser } from "../lib/session";
import { landingPath, resolveLanding } from "../lib/tenancy";

/** Entry point: route the signed-in user by their memberships (0 / 1 / many). */
export default async function Home() {
  const user = await requireUser();
  redirect(landingPath(resolveLanding(await getMembershipRows(user.id))));
}
