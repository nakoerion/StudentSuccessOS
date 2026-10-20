/**
 * Supabase Auth wiring (cookie sessions via @supabase/ssr). This is the ONLY
 * file that constructs Supabase clients; pages use the small interface in
 * ./index.ts. Server-side only: it uses the publishable key, never the secret.
 */
import { createServerClient, type CookieMethodsServer } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";

export interface SupabaseAuthEnv {
  url: string;
  publishableKey: string;
}

export function supabaseAuthEnv(): SupabaseAuthEnv {
  const url = process.env.SUPABASE_URL;
  const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!url || !publishableKey) {
    throw new Error("SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY must be set (see .env.example)");
  }
  return { url, publishableKey };
}

/** A Supabase client bound to an arbitrary cookie store (middleware, tests). */
export function createSupabaseClient(cookies: CookieMethodsServer, env = supabaseAuthEnv()): SupabaseClient {
  return createServerClient(env.url, env.publishableKey, { cookies });
}

/**
 * A Supabase client bound to Next's request cookies (server components, server
 * actions, route handlers). Cookie writes throw inside server components; that
 * is fine because middleware refreshes the session before they render.
 */
export async function createSupabaseServerClient(): Promise<SupabaseClient> {
  const { cookies } = await import("next/headers");
  const store = await cookies();
  return createSupabaseClient({
    getAll: () => store.getAll(),
    setAll: (toSet) => {
      try {
        for (const { name, value, options } of toSet) store.set(name, value, options);
      } catch {
        // Called from a server component: read-only cookies. Middleware handles refresh.
      }
    },
  });
}
