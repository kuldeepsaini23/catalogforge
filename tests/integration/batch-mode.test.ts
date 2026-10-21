import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generate, toCsv } from "../../fixtures/generate";
import { getDb } from "@/lib/db/client";
import { createImport } from "@/lib/imports";
import { reconcile } from "@/lib/pipeline/finalize";
import { resetDatabase, waitForImport } from "./helpers";

// Force the Message Batches path for anything with 20+ products to build.
process.env.AI_BATCH_THRESHOLD = "20";

let stop: () => Promise<void>;
beforeAll(async () => {
  await resetDatabase();
  const { startWorker } = await import("@/worker/index");
  stop = await startWorker();
});
afterAll(async () => {
  await stop?.();
});

describe("Message Batches mode", () => {
  it("submits one batch, applies every result exactly once, and bills at the batch rate", async () => {
    const g = generate(400, 31, { photos: 0 });
    const { id } = await createImport({ name: "batch.csv", bytes: new TextEncoder().encode(toCsv(g.headers, g.rows)) }, []);
    const imp = await waitForImport(id, 180_000);
    expect(imp.status).toBe("completed");
    expect(imp.mode).toBe("batch");
    const r = await reconcile(id);
    expect(r.ok).toBe(true);
    expect(r.total).toBe(400);

    const db = getDb();
    const batches = await db.execute<{ status: string; n: string }>(sql`SELECT status, count(*) AS n FROM ai_batches GROUP BY status`);
    expect(batches.rows).toEqual([{ status: "applied", n: "1" }]);
    const calls = await db.execute<{ mode: string; products: string }>(sql`SELECT mode, sum(product_count) AS products FROM ai_calls WHERE kind = 'build' GROUP BY mode`);
    const built = await db.execute<{ n: string }>(sql`SELECT count(*) AS n FROM products WHERE built_hash IS NOT NULL`);
    // Every product came from the batch, once.
    expect(calls.rows).toEqual([{ mode: "batch", products: built.rows[0].n }]);
  });
});
