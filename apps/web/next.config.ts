import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./i18n/request.ts");

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Workspace packages ship TypeScript source.
  transpilePackages: ["@ssos/ui", "@ssos/country-packs", "@ssos/auth", "@ssos/db"],
  // Lint runs as its own turbo task (`pnpm lint`), not inside `next build`.
  eslint: { ignoreDuringBuilds: true },
  // Behind a proxy that rewrites x-forwarded-host, Server Actions reject the browser's Origin.
  // SSOS_ALLOWED_ORIGINS (comma-separated hosts) names the public hosts to accept.
  ...(process.env.SSOS_ALLOWED_ORIGINS
    ? {
        experimental: {
          serverActions: {
            allowedOrigins: process.env.SSOS_ALLOWED_ORIGINS.split(",").map((h) => h.trim()).filter(Boolean),
          },
        },
      }
    : {}),
};

export default withNextIntl(nextConfig);
