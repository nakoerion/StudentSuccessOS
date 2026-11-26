import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import { canApproveClaims } from "../../../../../lib/join-claims";
import { requireTenant } from "../../../../../lib/session";

/**
 * The authorisation boundary sits here, above this route's loading skeleton, so anyone who
 * cannot approve claims gets a real 404 before anything streams.
 */
export default async function ClaimsLayout({ children, params }: { children: ReactNode; params: Promise<{ tenantSlug: string }> }) {
  const { viewer } = await requireTenant((await params).tenantSlug);
  if (!canApproveClaims(viewer)) notFound();
  return children;
}
