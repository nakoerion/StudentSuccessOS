import { redirectWithSession, updateSession } from "@ssos/auth/middleware";
import type { NextRequest } from "next/server";

/** Paths reachable without a session. Everything else (in the matcher) needs one. */
const PUBLIC_PATHS = ["/sign-in"];

/**
 * 1. Validate/refresh the Supabase session cookie (@supabase/ssr) on every
 *    page request, so server components always see fresh tokens.
 * 2. No valid session on a protected path -> /sign-in. Pages still call
 *    requireUser()/requireTenant() server-side; this is the first gate, not the only one.
 * 3. Forward the pathname to server components (next-intl's request config
 *    uses it to pick the tenant's default locale for /t/<slug>/...).
 */
export async function middleware(request: NextRequest) {
  const headers = new Headers(request.headers);
  headers.set("x-ssos-pathname", request.nextUrl.pathname);
  const session = await updateSession(request, headers);

  const { pathname } = request.nextUrl;
  const isPublic = PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
  if (!session.authSubject && !isPublic) {
    return redirectWithSession(session, new URL("/sign-in", request.url));
  }
  return session.response;
}

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|svg|ico|woff2?)$).*)"],
};
