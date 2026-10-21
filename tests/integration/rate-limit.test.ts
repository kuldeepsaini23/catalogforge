import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generate, toCsv } from "../../fixtures/generate";
import { getDb } from "@/lib/db/client";
import { createImport } from "@/lib/imports";
import { reconcile } from "@/lib/pipeline/finalize";
import { resetDatabase, waitFor, waitForImport } from "./helpers";

// Every 4th model call answers 429 (mock retry-after: 3 s).
process.env.MOCK_RATE_LIMIT_EVERY = "4";

let stop: () => Promise<void>;
beforeAll(async () => {
  await resetDatabase();
  const { startWorker } = await import("@/worker/index");
  stop = await startWorker();
});
afterAll(async () => {
  await stop?.();
});

describe("rate limits", () => {
  it("pauses the import with a resume time, then resumes and finishes without losing rows", async () => {
    const g = generate(150, 11, { photos: 0 });
    const { id } = await createImport({ name: "rl.csv", bytes: new TextEncoder().encode(toCsv(g.headers, g.rows)) }, []);
    const db = getDb();
    const paused = await waitFor(
      async () => {
        const imp = await db.query.imports.findFirst({ where: (t, { eq }) => eq(t.id, id) });
        return imp?.status === "paused" ? imp : null;
      },
      { timeoutMs: 60_000, intervalMs: 50, label: "paused state" },
    );
    expect(paused.pausedUntil!.getTime()).toBeGreaterThan(Date.now() - 1000);
    expect(paused.pauseReason).toMatch(/Rate limited/);

    const imp = await waitForImport(id, 180_000);
    expect(imp.status).toBe("completed");
    expect(imp.pausedUntil).toBeNull();
    const r = await reconcile(id);
    expect(r.ok).toBe(true);
    expect(r.total).toBe(150);
    const limited = await db.execute<{ n: string }>(sql`SELECT count(*) AS n FROM ai_calls WHERE outcome = 'rate_limited'`);
    expect(Number(limited.rows[0].n)).toBeGreaterThan(0);
  });
});
