/**
 * Route handlers for app/api/auth/[...auth]/route.ts:
 *   GET  /api/auth/session            -> 200 { user } | 401 { user: null }
 *   GET  /api/auth/callback?code&next -> exchange a PKCE code (e-mail links) for a session, redirect to `next`
 *   POST /api/auth/sign-out           -> clear the session, 303 to /sign-in
 */
import { NextResponse } from "next/server";

import { sessionUserFromSubject } from "./credentials";
import { createSupabaseServerClient } from "./supabase";

function action(request: Request): string {
  const parts = new URL(request.url).pathname.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? "";
}

function safeNext(path: string | null): string {
  return path && path.startsWith("/") && !path.startsWith("//") && !path.startsWith("/\\") ? path : "/";
}

const notFound = () => NextResponse.json({ error: "not_found" }, { status: 404 });

async function GET(request: Request): Promise<NextResponse> {
  const url = new URL(request.url);
  switch (action(request)) {
    case "session": {
      const supabase = await createSupabaseServerClient();
      const { data, error } = await supabase.auth.getClaims();
      const claims = !error ? data?.claims : undefined;
      const user = claims?.sub
        ? await sessionUserFromSubject({ sub: claims.sub, email: claims.email, user_metadata: claims.user_metadata })
        : null;
      return NextResponse.json({ user }, { status: user ? 200 : 401, headers: { "cache-control": "no-store" } });
    }
    case "callback": {
      const code = url.searchParams.get("code");
      if (code) {
        const supabase = await createSupabaseServerClient();
        const { error } = await supabase.auth.exchangeCodeForSession(code);
        if (!error) return NextResponse.redirect(new URL(safeNext(url.searchParams.get("next")), url.origin), 303);
      }
      return NextResponse.redirect(new URL("/sign-in?error=callback", url.origin), 303);
    }
    default:
      return notFound();
  }
}

async function POST(request: Request): Promise<NextResponse> {
  if (action(request) !== "sign-out") return notFound();
  const supabase = await createSupabaseServerClient();
  await supabase.auth.signOut();
  return NextResponse.redirect(new URL("/sign-in", request.url), 303);
}

export const authHandlers = { GET, POST };
