/**
 * Edge-safe session refresh for Next middleware. Imports only @supabase/ssr and
 * next/server (no database), so it can run in the middleware runtime.
 *
 * Usage (apps/web/middleware.ts):
 *   const { response, authSubject } = await updateSession(request, headers);
 */
import { createServerClient } from "@supabase/ssr";
import { type NextRequest, NextResponse } from "next/server";

import { supabaseAuthEnv } from "./supabase";

export interface UpdatedSession {
  /** Pass-through response carrying any refreshed auth cookies. */
  response: NextResponse;
  /** Supabase auth user id (JWT `sub`) when the session is valid, else null. */
  authSubject: string | null;
}

/**
 * Validate the Supabase session cookie (signature-checked JWT claims) and
 * refresh it when the access token has expired. `requestHeaders` lets the
 * caller forward extra request headers to server components.
 */
export async function updateSession(request: NextRequest, requestHeaders?: Headers): Promise<UpdatedSession> {
  const headers = requestHeaders ?? new Headers(request.headers);
  let response = NextResponse.next({ request: { headers } });
  const { url, publishableKey } = supabaseAuthEnv();

  const supabase = createServerClient(url, publishableKey, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (toSet) => {
        for (const { name, value } of toSet) request.cookies.set(name, value);
        // Server components must see the refreshed tokens in this same request.
        headers.set("cookie", request.cookies.toString());
        response = NextResponse.next({ request: { headers } });
        for (const { name, value, options } of toSet) response.cookies.set(name, value, options);
      },
    },
  });

  // Do not run code between createServerClient and getClaims (Supabase SSR rule).
  const { data, error } = await supabase.auth.getClaims();
  const authSubject = !error && typeof data?.claims.sub === "string" ? data.claims.sub : null;
  return { response, authSubject };
}

/** Redirect while keeping any cookies the session refresh set (or cleared). */
export function redirectWithSession(session: UpdatedSession, to: URL): NextResponse {
  const redirect = NextResponse.redirect(to);
  for (const cookie of session.response.cookies.getAll()) redirect.cookies.set(cookie);
  return redirect;
}
