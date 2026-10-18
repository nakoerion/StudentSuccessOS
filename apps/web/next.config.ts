import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Workspace packages ship TypeScript source.
  transpilePackages: ["@ssos/ui", "@ssos/country-packs"],
  // Lint runs as its own turbo task (`pnpm lint`), not inside `next build`.
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
