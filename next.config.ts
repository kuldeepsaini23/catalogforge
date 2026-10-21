import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  // The storefront keeps every published product's data in memory (≈3 KB each).
  cacheMaxMemorySize: 256 * 1024 * 1024,
  cacheLife: {
    // Storefront pages: serve from cache, refresh in the background; publishing expires tags at once.
    storefront: { stale: 60, revalidate: 300, expire: 3600 },
  },
  // Server-only packages used by route handlers and the worker.
  serverExternalPackages: ["pg", "pg-boss", "sanitize-html", "xlsx"],
  partialPrefetching: true,
  reactCompiler: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
