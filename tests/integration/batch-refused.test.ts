import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generate, toCsv } from "../../fixtures/generate";
import { FatalAiError } from "@/lib/ai/errors";
import { MockProvider } from "@/lib/ai/mock";
import { setProviderForTests } from "@/lib/ai/provider";
import { getDb } from "@/lib/db/client";
import { createImport } from "@/lib/imports";
import { reconcile } from "@/lib/pipeline/finalize";
import { resetDatabase, waitForImport } from "./helpers";

process.env.AI_BATCH_THRESHOLD = "20";

/** A provider whose batch endpoint is refused, as Vercel AI Gateway does when batches aren't enabled. */
class NoBatchProvider extends MockProvider {
  override async submitBatch(): Promise<string> {
    throw new FatalAiError("403 batches are not enabled for this team");
  }
}

let stop: () => Promise<void>;
beforeAll(async () => {
  await resetDatabase();
  setProviderForTests(new NoBatchProvider());
  const { startWorker } = await import("@/worker/index");
  stop = await startWorker();
});
afterAll(async () => {
  await stop?.();
  setProviderForTests(undefined);
});

describe("batch submission refused", () => {
  it("builds the products with normal calls instead, once each", async () => {
    const g = generate(300, 37, { photos: 0 });
    const { id } = await createImport({ name: "nobatch.csv", bytes: new TextEncoder().encode(toCsv(g.headers, g.rows)) }, []);
    const imp = await waitForImport(id, 180_000);
    expect(imp.status).toBe("completed");
    const r = await reconcile(id);
    expect(r.ok).toBe(true);
    expect(r.total).toBe(300);

    const db = getDb();
    const batches = await db.execute<{ status: string }>(sql`SELECT DISTINCT status FROM ai_batches`);
    expect(batches.rows).toEqual([{ status: "fallback" }]);
    const calls = await db.execute<{ mode: string; products: string }>(sql`SELECT mode, sum(product_count) AS products FROM ai_calls WHERE kind = 'build' AND outcome = 'ok' GROUP BY mode`);
    const built = await db.execute<{ n: string }>(sql`SELECT count(*) AS n FROM products WHERE built_hash IS NOT NULL`);
    expect(calls.rows).toEqual([{ mode: "sync", products: built.rows[0].n }]);
  });
});
