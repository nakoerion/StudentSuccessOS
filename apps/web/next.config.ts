import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./i18n/request.ts");

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Workspace packages ship TypeScript source.
  transpilePackages: ["@ssos/ui", "@ssos/country-packs", "@ssos/auth", "@ssos/db"],
  // Lint runs as its own turbo task (`pnpm lint`), not inside `next build`.
  eslint: { ignoreDuringBuilds: true },
};

export default withNextIntl(nextConfig);
