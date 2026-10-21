import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const alias = { "@": path.resolve(path.dirname(fileURLToPath(import.meta.url)), "src") };

export default defineConfig({
  resolve: { alias },
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: "unit",
          include: ["tests/unit/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        resolve: { alias },
        test: {
          name: "integration",
          include: ["tests/integration/**/*.test.ts"],
          environment: "node",
          setupFiles: ["tests/integration/setup.ts"],
          // Integration tests share one database; run files serially.
          fileParallelism: false,
          testTimeout: 180_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
