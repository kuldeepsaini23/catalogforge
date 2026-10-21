import { rm } from "node:fs/promises";
import { afterAll } from "vitest";

// Integration tests run against a dedicated database and storage dir with the deterministic mock.
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://catalogforge:catalogforge@localhost:5433/catalogforge_test";
process.env.AI_PROVIDER = "mock";
process.env.STORAGE_DIR = "./data-test";
process.env.MOCK_LATENCY_MS ??= "0";
process.env.MOCK_BATCH_DELAY_MS ??= "300";
process.env.AI_BATCH_THRESHOLD ??= "100000";
process.env.WORKER_CONCURRENCY ??= "4";

afterAll(async () => {
  const { stopBoss } = await import("@/lib/queue");
  const { closeDb } = await import("@/lib/db/client");
  await stopBoss();
  await closeDb();
  await rm("./data-test", { recursive: true, force: true }).catch(() => undefined);
});
