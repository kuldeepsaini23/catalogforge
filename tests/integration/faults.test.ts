import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generate, toCsv } from "../../fixtures/generate";
import { getDb } from "@/lib/db/client";
import { createImport } from "@/lib/imports";
import { reconcile } from "@/lib/pipeline/finalize";
import { resetDatabase, waitForImport } from "./helpers";

// 30% of model calls fail: half with a transient 529, half with invalid JSON (missing product + wrong types).
process.env.MOCK_FAULT_RATE = "0.3";

let stop: () => Promise<void>;
beforeAll(async () => {
  await resetDatabase();
  const { startWorker } = await import("@/worker/index");
  stop = await startWorker();
});
afterAll(async () => {
  await stop?.();
});

describe("flaky AI", () => {
  it("retries errors and invalid JSON; every row still ends in a final state and nothing is doubled", async () => {
    // ~1,000 rows → ~40 build calls, so injected faults are effectively certain to occur.
    const g = generate(1000, 23, { photos: 0 });
    const { id } = await createImport({ name: "faults.csv", bytes: new TextEncoder().encode(toCsv(g.headers, g.rows)) }, []);
    const imp = await waitForImport(id, 240_000);
    expect(imp.status).toBe("completed");
    const r = await reconcile(id);
    expect(r.ok).toBe(true);
    expect(r.total).toBe(1000);

    const db = getDb();
    const outcomes = await db.execute<{ outcome: string; n: string }>(sql`SELECT outcome, count(*) AS n FROM ai_calls WHERE kind = 'build' GROUP BY outcome`);
    const by = Object.fromEntries(outcomes.rows.map((o) => [o.outcome, Number(o.n)]));
    // Faults happened (both kinds are injected at 15 % each) and the import still finished.
    expect((by.invalid_output ?? 0) + (by.error ?? 0)).toBeGreaterThan(2);
    expect(by.ok).toBeGreaterThan(0);
    // Faults are retried, so (almost) nothing should end up Failed.
    expect(r.failed).toBeLessThan(r.total * 0.02);
    const dup = await db.execute<{ n: string }>(sql`SELECT count(*) AS n FROM (SELECT sku FROM variants GROUP BY sku HAVING count(*) > 1) d`);
    expect(Number(dup.rows[0].n)).toBe(0);
  });
});
