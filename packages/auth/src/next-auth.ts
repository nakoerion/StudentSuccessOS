/**
 * Auth.js v5 (next-auth) wiring. This is the ONLY file that knows about the
 * provider; everything else uses the small interface in ./index.ts, so a later
 * slice can swap in Supabase Auth (or any OIDC provider) without touching pages.
 */
import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";

import { verifyCredentials } from "./credentials";

export const nextAuth = NextAuth({
  trustHost: true,
  // Credentials provider requires JWT sessions in Auth.js; the token carries
  // only the user id + profile fields, never tenant data (that is resolved per
  // request from ssos_user_memberships).
  session: { strategy: "jwt", maxAge: 60 * 60 * 8 },
  pages: { signIn: "/sign-in" },
  providers: [
    Credentials({
      credentials: { email: {}, password: {} },
      authorize: async (credentials) => {
        const user = await verifyCredentials(credentials?.email, credentials?.password);
        return user ? { id: user.id, email: user.email, name: user.name, locale: user.locale } : null;
      },
    }),
  ],
  callbacks: {
    jwt({ token, user }) {
      if (user) {
        token.sub = user.id;
        token.locale = (user as { locale?: string | null }).locale ?? null;
      }
      return token;
    },
    session({ session, token }) {
      if (token.sub) session.user.id = token.sub;
      (session.user as { locale?: string | null }).locale = (token.locale as string | null | undefined) ?? null;
      return session;
    },
  },
});
